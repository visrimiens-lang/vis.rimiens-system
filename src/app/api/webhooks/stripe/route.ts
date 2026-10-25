import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { StripeError, stripeConfigured, stripeReq } from "@/lib/stripe";
import {
  type CheckoutLineItem,
  isPaymentLinkCheckout,
  orderDataFromSession,
  verifyStripeSignature,
} from "@/lib/stripe-webhook";
import { handleOrderNotification } from "../order/route";

/**
 * Stripe の支払いリンク決済を、受注として受け取る（2026-10-25）。
 *
 * Stripe ダッシュボード → 開発者 → Webhook に、この URL を登録する:
 *   https://vis-rimiens-system.vercel.app/api/webhooks/stripe
 *   受け取るイベント: checkout.session.completed
 * 発行される署名シークレット（whsec_…）を Vercel の STRIPE_WEBHOOK_SECRET に入れる。
 *
 * 明細（何を買ったか）は通知に入っていないので Stripe に取りに行く。
 * STRIPE_SECRET_KEY の制限付きキーに「Checkout Sessions: 読み取り」が要る。
 * 取れなくても受注は落とさない（商品名だけ仮の文言にして受信箱に残す）。
 * 取りこぼしてマイページで「購入情報が見つかりません」になるほうが、よほど困るため。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

async function lineItemsOf(sessionId: string): Promise<{ items: CheckoutLineItem[]; note: string }> {
  if (!stripeConfigured()) {
    return { items: [], note: "STRIPE_SECRET_KEY が未設定のため明細を取得できませんでした。" };
  }
  try {
    const res = await stripeReq("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`, {
      limit: 20,
      expand: ["data.price.product"],
    });
    const data = (res["data"] as CheckoutLineItem[] | undefined) ?? [];
    return { items: data, note: "" };
  } catch (e) {
    const msg =
      e instanceof StripeError ? `${e.message}（${e.code || e.status}）` : e instanceof Error ? e.message : "不明";
    return { items: [], note: `明細を取得できませんでした: ${msg}` };
  }
}

export async function POST(req: NextRequest) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "STRIPE_WEBHOOK_SECRET が未設定です。" }, { status: 500 });
  }

  // 署名は JSON に戻す前の生の本文で検証する
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ ok: false, error: "署名の検証に失敗しました。" }, { status: 401 });
  }

  let event: Row;
  try {
    event = JSON.parse(raw) as Row;
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  // 支払いリンク経由の支払い済み以外は、受け取ったことだけ返して何もしない
  if (!isPaymentLinkCheckout(event)) {
    return NextResponse.json({ ok: true, ignored: true, type: String(event["type"] ?? "") });
  }

  const session = ((event["data"] as Row)["object"] ?? {}) as Row;
  const sessionId = String(session["id"] ?? "");
  const { items, note } = await lineItemsOf(sessionId);
  if (note) {
    await audit("intake", "Stripe決済の明細を取得できませんでした", { type: "checkout", key: sessionId }, {
      理由: note,
      手当て: "受注は仮の商品名で登録しています。受注詳細で商品名と報酬をご確認ください。",
    });
  }

  const data = orderDataFromSession(session, items, {
    productNameFallback: note ? `Stripe決済（${note}）` : undefined,
  });
  return handleOrderNotification("stripe", data);
}

/** 受け口の生存確認。署名シークレットが設定されているかだけ返す（値は返さない）。 */
export async function GET() {
  const ready = Boolean((process.env.STRIPE_WEBHOOK_SECRET ?? "").trim());
  return NextResponse.json({
    ok: true,
    ready,
    message: ready ? "受け口は正常です。" : "STRIPE_WEBHOOK_SECRET が未設定です。",
  });
}
