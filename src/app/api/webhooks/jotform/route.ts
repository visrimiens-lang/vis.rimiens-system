import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pick, prettyPairs } from "@/lib/jotform-fields";
import {
  markProcessed,
  notifyLicenseTest,
  receive,
  registerAgency,
  registerDemoMachine,
  registerLead,
  registerPreLead,
  type AgencyApplication,
} from "@/lib/intake";

/**
 * JotForm からの申込を受け取る。
 *
 * これまで Make が受けていたものを、ここで直接受ける。
 * JotForm のフォーム設定で、送信先（Webhook）をこの URL にする:
 *   https://vis-rimiens-system.vercel.app/api/webhooks/jotform?token=＜合言葉＞&kind=＜種類＞
 *
 * kind に入れる値:
 *   agency       … 代理店システム登録（会社としての登録）
 *   referrer     … 取次パートナー登録
 *   staff        … スタッフ／販売ライセンス認定登録
 *   lead         … トスアップ（お客様のご紹介）
 *   demo         … デモ機登録
 *   pre-register … 体験の事前登録（QR1）
 *   license-test … ライセンステストの提出（本部へ採点依頼が飛ぶ）
 *
 * 届いたものは必ず受信箱に丸ごと残してから処理する。
 * 途中で失敗しても申込が消えないようにするため。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * JotForm の項目名は「q6_input3」「q60_inviteCode」のような形で届く。
 * 頭の「q番号_」を落として、後ろの名前だけで照合できるようにする。
 */
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

/** JotForm の送信内容を取り出す。form-data でも JSON でも受けられるようにする。 */
async function readPayload(req: NextRequest): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  const out: Record<string, unknown> = {};

  if (type.includes("application/json")) {
    Object.assign(out, (await req.json()) as Record<string, unknown>);
  } else {
    const form = await req.formData();
    for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : String(v);
  }

  // JotForm は中身を rawRequest という1つの項目に JSON で詰めて送ってくる
  const raw = out["rawRequest"];
  if (typeof raw === "string") {
    try {
      Object.assign(out, JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // JSON でなければそのまま使う
    }
  }

  /*
   * pretty の日本語ラベルも照合できるようにする。
   * すでにある項目は上書きしない。rawRequest 側は氏名 {first,last} や
   * 生年月日 {year,month,day} のように構造が残っていて、そちらの方が正確に組み立てられるため。
   */
  for (const [label, value] of Object.entries(prettyPairs(out["pretty"]))) {
    if (!(label in out)) out[label] = value;
  }
  return out;
}

export async function POST(req: NextRequest) {
  // 合言葉の確認。第三者に偽の申込を送られないようにする。
  const secret = process.env.WEBHOOK_TOKEN ?? "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || !sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  const kind = (req.nextUrl.searchParams.get("kind") ?? "").toLowerCase();

  let data: Record<string, unknown>;
  try {
    data = await readPayload(req);
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  const submissionId =
    pick(data, "submissionID", "submission_id", "submissionId") || null;
  const formId = pick(data, "formID", "form_id") || null;

  // まず丸ごと保存する
  const box = await receive("jotform", submissionId, formId, data);
  if (box.duplicate) {
    return NextResponse.json({ ok: true, message: "受付済みです。" });
  }

  try {
    if (kind === "demo") {
      const r = await registerDemoMachine({
        serialNo: pick(data, "製品番号", "シリアル", "serial"),
        model: pick(data, "機種", "model") || undefined,
        acquiredKind: pick(data, "取得区分", "acquiredKind") || undefined,
        acquiredOn: pick(data, "取得日", "acquiredOn") || undefined,
        holderCode: pick(data, "代理店コード", "保有代理店コード", "code") || undefined,
        holderName: pick(data, "保有代理店名", "代理店名") || undefined,
        purpose: pick(data, "貸与目的", "目的", "purpose") || undefined,
        note: pick(data, "備考", "note") || undefined,
      });
      await markProcessed(box.id, r.ok ? undefined : r.message);
      return NextResponse.json(r, { status: r.ok ? 200 : 202 });
    }

    if (kind === "pre-register" || kind === "prelead") {
      const r = await registerPreLead({
        customerName: pick(data, "お名前", "氏名", "ニックネーム", "name"),
        phone: pick(data, "電話", "phone", "tel"),
        referrerCode: pick(data, "紹介コード", "スタッフコード", "code"),
        note: pick(data, "備考", "note"),
      });
      await markProcessed(box.id, r.ok ? undefined : r.message);
      return NextResponse.json(r, { status: r.ok ? 200 : 202 });
    }

    if (kind === "license-test" || kind === "test") {
      const r = await notifyLicenseTest({
        name: pick(data, "お名前", "氏名", "name"),
        agencyCode: pick(data, "代理店コード", "スタッフコード", "code") || undefined,
        score: pick(data, "点数", "得点", "score") || undefined,
        detail: pick(data, "回答", "detail") || undefined,
      });
      await markProcessed(box.id, r.ok ? undefined : r.message);
      return NextResponse.json(r, { status: r.ok ? 200 : 202 });
    }

    if (kind === "lead") {
      const r = await registerLead({
        customerName: pick(data, "お客様氏名", "お名前", "氏名", "name", "customerName"),
        phone: pick(data, "電話", "phone", "tel"),
        referrerCode: pick(data, "取次店コード", "紹介コード", "referrerCode", "code"),
        note: pick(data, "備考", "note"),
      });
      await markProcessed(box.id, r.ok ? undefined : r.message);
      return NextResponse.json(r, { status: r.ok ? 200 : 202 });
    }

    const formKind: AgencyApplication["formKind"] =
      kind === "referrer" ? "取次パートナー登録"
      : kind === "staff" ? "スタッフ登録"
      : "代理店システム登録";

    const r = await registerAgency({
      formKind,
      // VIS代理店システム登録は「法人／サロン／個人」で入口が分かれ、
      // 会社名(textbox6)・サロン名(textbox14)・氏名(fullname20)のいずれかに入る。
      name: pick(
        data, "会社名", "サロン名", "法人名", "textbox6", "textbox14",
        "fullname20", "お名前", "氏名", "input3", "name",
      ),
      repName: pick(data, "代表者", "代表者名", "representative"),
      email: pick(data, "input32", "メール", "email", "mail"),
      phone: pick(data, "input33", "携帯電話", "電話", "phone", "tel"),
      zip: pick(data, "郵便番号", "zip", "postal"),
      address: pick(data, "住所", "address"),
      shopName: pick(data, "input60", "店舗名", "屋号", "shop"),
      birthday: pick(data, "input19", "生年月日", "birthday"),
      inviteCode: pick(data, "input48", "inviteCode", "招待コード", "紹介コード", "上位代理店コード"),
      /*
       * 代理店種別（エリア統括代理店 / 販売代理店 / サロン代理店 / 個人販売代理店）。
       * この1項目でランク・販路種別・上位の決まり方が変わる（intake.ts の kindOf）。
       * 実フォーム 261833358386063 では q4_q4_radio2 に入っている
       * （make-blueprints/scenario-13-v3-FINAL3.json のルーター条件と同じ項目）。
       * pick は頭の「q番号_」を1つ落とすので、正規化後は q4_radio2 になる。
       */
      agencyType: pick(data, "代理店種別", "agencyType", "q4_radio2", "radio2") || undefined,
      channel: pick(data, "販路種別", "channel") || undefined,
      areaClass: pick(data, "エリア", "area") || undefined,
      bank: {
        name: pick(data, "銀行名", "bankName"),
        branch: pick(data, "支店名", "branch"),
        type: pick(data, "口座種別", "accountType"),
        number: pick(data, "口座番号", "accountNumber"),
        holder: pick(data, "口座名義", "accountHolder"),
      },
      jotformId: submissionId ?? undefined,
      ip: pick(data, "ip") || undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });

    await markProcessed(box.id, r.ok ? undefined : r.message);
    // 登録できなかった場合も 202 で返す。JotForm 側でエラー扱いにさせず、
    // 本部が受信箱を見て手当てできるようにするため。
    return NextResponse.json(r, { status: r.ok ? 200 : 202 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    await markProcessed(box.id, msg);
    console.error("[jotform]", e);
    return NextResponse.json(
      { ok: false, error: "登録に失敗しました。本部で確認します。" },
      { status: 202 },
    );
  }
}

/** 設定確認用。ブラウザで開いたときに、繋がっているかだけ分かるようにする。 */
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
