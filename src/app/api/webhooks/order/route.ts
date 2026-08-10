import { NextRequest, NextResponse } from "next/server";
import { markProcessed, receive, registerOrder } from "@/lib/intake";

/**
 * UTAGE の決済完了・Stripe からの通知を受け取って、受注として登録する。
 *
 * これまで Make のシナリオ#1 がやっていたことを、ここで直接受ける。
 * UTAGE の「決済完了時のWebhook」に、この URL を設定する:
 *   https://vis-rimiens-system.vercel.app/api/webhooks/order?token=＜合言葉＞
 *
 * 代理店は UTAGE の ?ref= で渡ってくる。
 * ref に代理店名が入ってくることがあるため、コードで見つからなければ名前でも探す。
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
      stripePaymentId: paymentId ?? undefined,
    });

    await markProcessed(box.id, r.ok ? undefined : r.message);
    return NextResponse.json(r, { status: r.ok ? 200 : 202 });
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
