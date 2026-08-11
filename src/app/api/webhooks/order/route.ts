import { NextRequest, NextResponse } from "next/server";
import { audit, selectOne } from "@/lib/db";
import { KIND_STAFF, markProcessed, receive, registerOrder } from "@/lib/intake";

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
  if (!secret || given !== secret) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  let data: Record<string, unknown>;
  try {
    data = await readPayload(req);
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  const paymentId =
    pick(data, "payment_id", "paymentId", "transaction_id", "charge_id", "id") || null;

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

  try {
    const r = await registerOrder({
      customerName: pick(data, "customer_name", "注文者名", "お名前", "氏名", "name"),
      email: pick(data, "email", "メール"),
      phone: pick(data, "phone", "tel", "電話"),
      zip: pick(data, "zipcode", "zip", "郵便"),
      address: pick(data, "address", "住所"),
      building: pick(data, "building", "建物"),
      productName: pick(data, "product", "商品", "item"),
      amount: toAmount(pick(data, "amount", "price", "金額", "total")),
      quantity: Number(pick(data, "quantity", "数量")) || 1,
      paymentMethod: pick(data, "payment_method", "決済方法") || "Stripe",
      agencyCode: pick(data, "ref", "partner", "代理店コード", "agency_code") || undefined,
      staffCode: staff.code || undefined,
      stripePaymentId: paymentId ?? undefined,
    });

    // 担当者コードに引っかかりがあれば、受信箱に残して本部に確認してもらう。
    // 受注は登録できているので、その旨も一緒に書いておく。
    if (staff.note) {
      await audit("intake", "担当者コードの確認待ち", { type: "order", key: r.ok ? r.code : "" }, {
        受け取った担当者コード: staffRaw.slice(0, 40),
        記録した担当者コード: staff.code || null,
        内容: staff.note,
      });
    }

    const trouble = [r.ok ? "" : r.message, staff.note].filter(Boolean).join(" ");
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
  if (given !== secret) {
    return NextResponse.json({ ok: false, error: "合言葉が違います。" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, message: "受け口は正常です。" });
}
