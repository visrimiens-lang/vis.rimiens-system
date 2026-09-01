import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { schedulePadSubscription } from "@/lib/pad-subscription";
import { audit, select, selectOne, update } from "@/lib/db";
import {
  KIND_STAFF,
  markProcessed,
  normalizePhone,
  receive,
  registerOrder,
} from "@/lib/intake";

/**
 * UTAGE の決済完了・Stripe からの通知を受け取って、受注として登録する。
 *
 * これまで Make のシナリオ#1 がやっていたことを、ここで直接受ける。
 * UTAGE の「決済完了時のWebhook」に、この URL を設定する:
 *   https://vis-rimiens-system.vercel.app/api/webhooks/order?token=＜合言葉＞
 *
 * 代理店は UTAGE の ?ref= で渡ってくる。
 * ただし ref に入るのは代理店コードとは限らず、スタッフや取次パートナーのコードのこともある。
 * どの区分のコードだったかを見て置き場所を分けるのは registerOrder（src/lib/intake.ts）の役目で、
 * ここは「受け取った文字をそのまま渡す」だけにしている。
 *
 * 担当者コードの欄があるフォームでは、それも拾って渡す
 * （2026-08-07 会議「誰が売ったかが顧客管理側で追跡できない」への対応）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 合言葉をつき合わせる。長さや内容の違いで応答の速さが変わらないようにする。
 *
 * ふつうの !== は最初に違う文字が出た時点で終わるため、
 * 応答の速さの差から1文字ずつ言い当てられる余地が残る。
 * 実際に破るのは通信のばらつきがあって難しいが、
 * 数行で塞げるうえ、受け口は決済と申込という金額に直結する入口なので揃えておく。
 */
function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    // 長さが違っても、比較の手間は同じだけかける
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function pick(data: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    for (const [k, v] of Object.entries(data)) {
      if (k === n || k.toLowerCase().includes(n.toLowerCase())) {
        if (v === null || v === undefined) continue;
        if (typeof v === "object") continue;
        const s = String(v).trim();
        if (s) return s;
      }
    }
  }
  return "";
}

/**
 * 項目名がぴったり一致するものだけを拾う。
 *
 * 上の pick は名前の一部が入っていれば拾うので、担当者コードに使うと
 * 「スタッフ区分」「staff_flag」のような別の欄まで拾ってしまう。
 * 担当者コードは報酬の付け先を左右するので、ここでは決まった名前だけを見る。
 */
function pickExact(data: Record<string, unknown>, ...names: string[]): string {
  const entries = Object.entries(data).map(
    ([k, v]) => [k.trim().toLowerCase(), v] as const,
  );
  for (const n of names) {
    const want = n.trim().toLowerCase();
    for (const [k, v] of entries) {
      if (k !== want) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === "object") continue;
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return "";
}

/** 担当者コードを確かめた結果。note があれば本部に確認してもらう。 */
type StaffCheck = { code: string; note: string };

/**
 * 決済ページのカスタムJSが残した控えから、紹介コードを拾う。
 *
 * UTAGE は QRの ?ref= を決済の通知に載せないので、
 * 通知だけでは「誰の売上か」が決まらない。
 * お客様が決済ページで連絡先を入れたときに /api/ref-claim へ控えているので、
 * 連絡先で突き合わせる。
 *
 * ■ メールと電話の両方で探す（2026-09-01）
 *
 * 以前は「通知にメールがあればメールだけ」で探していた。
 * ところが、決済ページで打ったメールと UTAGE が通知してくるメールは
 * 同じとは限らない（LINE登録時の別アドレスが通知に載ることがある）。
 * メールが食い違うと本人の控えを見つけられず、たまたま連絡先が引っかかった
 * 別の控え（＝別のスタッフのQR）に付いてしまう事故が起きた。
 * メールと電話の両方で探し、次の順で選ぶ。
 *   1. メールも電話も一致する控え（本人でほぼ確実）
 *   2. どちらか片方が一致する控えのうち、いちばん新しいもの
 *
 * 拾うのは直近のものだけ。古い控えまで見ると、同じ方が
 * 別の代理店から買い直したときに前の付け先を引き継いでしまう。
 */
const CLAIM_WINDOW_HOURS = 72;

async function refFromClaim(
  email: string,
  phone: string,
): Promise<{ ref: string; claimId: unknown }> {
  const mail = (email || "").trim().toLowerCase();
  const tel = normalizePhone(phone || "");
  if (!mail && !tel) return { ref: "", claimId: null };

  const since = new Date(Date.now() - CLAIM_WINDOW_HOURS * 3600 * 1000).toISOString();
  const both = mail && tel;
  const filter = both
    ? `or=(email.eq.${encodeURIComponent(mail)},phone.eq.${encodeURIComponent(tel)})`
    : mail
      ? `email=eq.${encodeURIComponent(mail)}`
      : `phone=eq.${encodeURIComponent(tel)}`;

  try {
    const rows = await select<Record<string, unknown>>(
      `ref_claims?select=id,ref,email,phone&${filter}&used_by=is.null` +
        `&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=10`,
    );
    if (rows.length === 0) return { ref: "", claimId: null };
    // メールも電話も一致する控えがあれば最優先。無ければ新しい順の先頭。
    const exact = rows.find(
      (r) =>
        String(r["email"] ?? "").toLowerCase() === mail &&
        normalizePhone(String(r["phone"] ?? "")) === tel,
    );
    const hit = (both && exact) || rows[0];
    /*
     * ここでは「使用済み」の印を付けない。付けるのは受注の登録が成功したあと。
     * 先に印を付けると、登録が一時障害で失敗して再送されたとき、
     * 控えがもう拾えず、再送分が帰属なし（報酬0件）で登録されてしまう。
     */
    return { ref: String(hit["ref"] ?? ""), claimId: hit["id"] };
  } catch {
    // 控えの表がまだ無いときも、決済の取り込みは止めない
    return { ref: "", claimId: null };
  }
}

/** 受注の登録が成功したあとに、使った控えへ印を付ける。 */
async function markClaimUsed(claimId: unknown, orderId: string): Promise<void> {
  if (claimId === null || claimId === undefined) return;
  try {
    await update(`ref_claims?id=eq.${claimId}`, { used_by: Number(orderId) || -1 });
  } catch {
    // 印が付かなくても受注は成立している
  }
}

/**
 * 担当者コードを代理店マスタと照合する。
 *
 * この欄はお客様がフォームに打った文字がそのまま入ってくる。
 * 形（半角英数字）だけを見て受け入れると、実在しないコードが受注に残り、
 * 「?ref= が空のときは担当者の所属先に売上を付ける」（intake.ts の resolveAttribution）
 * の材料になるため、打ち間違いや当てずっぽうで報酬の支払先が変わりうる。
 * 本部の画面（updateOrderAction）はマスタに無いコードを弾いているので、
 * 入口による基準の食い違いをここで無くす。
 *
 * マスタに無いときは受注に記録せず、受信箱の error に落として本部に確認してもらう。
 * 受注そのものは止めない（お客様の注文が消えるほうが困るため）。
 */
async function verifyStaffCode(raw: string): Promise<StaffCheck> {
  const given = (raw || "").trim();
  if (!given) return { code: "", note: "" };

  const shown = given.slice(0, 40);
  if (!/^[A-Za-z0-9-]{1,20}$/.test(given)) {
    return {
      code: "",
      note: `担当者コード「${shown}」はコードの形ではないため、記録していません。誰が売ったかを本部でご確認ください。`,
    };
  }

  let person: Record<string, unknown> | null = null;
  try {
    person = await selectOne<Record<string, unknown>>(
      `agencies?select=code,name,code_kind&code=eq.${encodeURIComponent(given)}`,
    );
  } catch (e) {
    // 照合できなかったときも、確かめていないコードは記録しない
    console.error("[order] 担当者コードの照合に失敗", e);
    return {
      code: "",
      note: `担当者コード「${shown}」を代理店一覧と照合できなかったため、記録していません。本部でご確認ください。`,
    };
  }

  if (!person) {
    return {
      code: "",
      note: `担当者コード「${shown}」は代理店一覧に登録されていません。記録していませんので、誰が売ったかを本部でご確認ください。`,
    };
  }

  const code = String(person["code"] ?? given);
  const name = String(person["name"] ?? "");
  const kind = String(person["code_kind"] ?? "");
  if (kind !== KIND_STAFF) {
    // 会社・取次パートナーのコードでも記録は許す（本部の画面と同じ扱い）。ただし気づけるようにしておく。
    return {
      code,
      note: `担当者コード「${code}」${name ? `（${name}）` : ""}はスタッフ（区分02）として登録されていません。相違がないかご確認ください。`,
    };
  }
  return { code, note: "" };
}

function toAmount(v: string): number {
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/*
 * 決済方法。
 *
 * QR2 の決済ページで銀行振込・アプラスを選べるようにしたので、
 * 受注のお支払いステータス（着金待ち／決済完了）はここで決まる。
 * ところが通知に「決済方法」の欄が無いことがあり、そのときは既定の
 * Stripe＝決済完了になってしまう。振込やローンはまだ入金していないので、
 * これでは本部が入金確認をする対象から漏れる。
 *
 * UTAGE の商品詳細名には【銀行振込】【アプラス（ローン）】が入っているので、
 * 欄が無いときは商品名から読む。どちらも読めなければ、これまでどおり Stripe。
 */
function paymentMethodOf(given: string, productName: string): string {
  const m = given.trim();
  if (m) return m;
  const p = productName ?? "";
  if (/アプラス|ローン/.test(p)) return "アプラス";
  if (/銀行振込|振込/.test(p)) return "振込";
  return "Stripe";
}

async function readPayload(req: NextRequest): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return (await req.json()) as Record<string, unknown>;
  }
  const form = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : String(v);
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.WEBHOOK_TOKEN ?? "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || !sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  let data: Record<string, unknown>;
  try {
    data = await readPayload(req);
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  /*
   * 決済の番号。同じ通知が二度届いたときに、二重で受注を立てないための鍵になる。
   *
   * 項目名がぴったり一致するものだけを見る（pickExact）。
   * pick は名前の一部が入っていれば拾うので、"id" を候補にすると
   * "form_id" や "customer_id" のような別の欄を掴んでしまう。
   * 掴む相手を間違えると、
   *   ・その値が毎回同じ  → 正常な受注が全部「受付済み」で捨てられる
   *   ・その値が毎回違う  → 本当の重複を見逃して二重に計上する
   * のどちらかが起きる。決済の番号は金額に直結するので、当て推量で拾わない。
   */
  const paymentId =
    pickExact(
      data,
      "payment_id", "paymentid",
      "transaction_id", "transactionid",
      "charge_id", "chargeid",
      "決済ID", "決済番号",
    ) || null;

  const box = await receive("utage", paymentId, null, data);
  if (box.duplicate) {
    return NextResponse.json({ ok: true, message: "受付済みです。" });
  }

  /*
   * 誰が売ったか（スタッフのコード）。
   * 「担当者名」や「スタッフ区分」のような別の欄を拾わないよう、
   * 項目名がぴったり一致するものだけを見る。
   * そのうえで代理店マスタに実在するコードかを確かめ、無ければ記録しない。
   */
  const staffRaw = pickExact(data, "staff_code", "staffcode", "スタッフコード", "担当者コード");
  const staff = await verifyStaffCode(staffRaw);

  const email = pick(data, "email", "メール");
  const phone = pick(data, "phone", "tel", "電話");

  /*
   * 誰の紹介かを表すコード。次の順で決める。
   *
   *   1. 建物欄の目印（ #REF=コード ）。決済ページのJSが送信の直前に
   *      建物欄へ書き足したもので、決済そのものと同じ通知に載って届くため、
   *      連絡先の突き合わせが要らない＝取り違えが起きない（2026-09-01）。
   *      目印はここで取り除くので、受注に残る建物名は元のまま。
   *   2. 通知のコード欄（UTAGE は QRの ?ref= を通知に載せないため、通常は空）。
   *   3. 控え（ref_claims）との連絡先の突き合わせ。目印もコード欄も無いときの保険。
   */
  const buildingRaw = pick(data, "building", "建物");
  const refMark = buildingRaw.match(/\s*#REF=([A-Za-z0-9-]{1,20})\s*$/i);
  const building = refMark ? buildingRaw.slice(0, refMark.index).trim() : buildingRaw;

  const agencyFromWebhook =
    (refMark ? refMark[1] : "") ||
    pickExact(data, "ref", "ref_code", "partner", "代理店コード", "agency_code") ||
    "";
  const claim = agencyFromWebhook
    ? { ref: "", claimId: null }
    : await refFromClaim(email, phone);
  const agencyCode = agencyFromWebhook || claim.ref;

  const product = pick(data, "product", "商品", "item");

  try {
    const r = await registerOrder({
      customerName: pick(data, "customer_name", "注文者名", "お名前", "氏名", "name"),
      email,
      phone,
      zip: pick(data, "zipcode", "zip", "郵便"),
      address: pick(data, "address", "住所"),
      building,
      productName: product,
      amount: toAmount(pick(data, "amount", "price", "金額", "total")),
      quantity: Number(pick(data, "quantity", "数量")) || 1,
      paymentMethod: paymentMethodOf(pick(data, "payment_method", "決済方法"), product),
      agencyCode: agencyCode || undefined,
      staffCode: staff.code || undefined,
      stripePaymentId: paymentId ?? undefined,
    });

    // 受注が登録できたので、使った控えに印を付ける（失敗時は付けず、再送で拾い直せる）
    if (r.ok) await markClaimUsed(claim.claimId, r.code || "");

    /*
     * 1年後の定期パッド配送を仕込む（2026-08-27 会議の決定）。
     * クレジットカードなら Stripe に定期を自動作成、振込・アプラスなら
     * 請求予定日だけを台帳に残す。中で失敗しても受注には影響しない。
     */
    if (r.ok && r.code) await schedulePadSubscription(r.code);

    // 担当者コードに引っかかりがあれば、受信箱に残して本部に確認してもらう。
    // 受注は登録できているので、その旨も一緒に書いておく。
    if (staff.note) {
      await audit("intake", "担当者コードの確認待ち", { type: "order", key: r.ok ? r.code : "" }, {
        受け取った担当者コード: staffRaw.slice(0, 40),
        記録した担当者コード: staff.code || null,
        内容: staff.note,
      });
    }

    /*
     * 受信箱に残す理由。
     * 登録に失敗したときだけでなく、登録はできたが報酬が立たなかった等
     * （needsReview）も残す。ここを拾わないと、報酬の抜けが誰の目にも触れない。
     */
    const trouble = [r.needsReview ? r.message : "", r.ok ? "" : r.message, staff.note]
      .filter(Boolean)
      .join(" ");
    await markProcessed(box.id, trouble || undefined);
    return NextResponse.json(staff.note ? { ...r, note: staff.note } : r, {
      status: r.ok ? 200 : 202,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    await markProcessed(box.id, msg);
    console.error("[order]", e);
    return NextResponse.json(
      { ok: false, error: "登録に失敗しました。本部で確認します。" },
      { status: 202 },
    );
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.WEBHOOK_TOKEN ?? "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret) {
    return NextResponse.json({ ok: false, error: "WEBHOOK_TOKEN が未設定です。" }, { status: 500 });
  }
  if (!sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "合言葉が違います。" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, message: "受け口は正常です。" });
}
