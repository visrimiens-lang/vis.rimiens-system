import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe から直接届く決済通知を、ポータルの受注通知の形にそろえる。
 *
 * ■ なぜ必要か（2026-10-25）
 *
 * ポータルは UTAGE の「決済完了時の Webhook」からしか受注を受け取っていなかった。
 * ところが「先行予約」や個別見積の販売は、庄司さんが Stripe で発行した
 * **支払いリンク**で決済されていて、UTAGE を通らない。そのぶんの受注は
 * ポータルに一切届かず、お客様がマイページで「購入情報が見つかりません」になる
 * （2026-10-25 曳野様。8/19 に手で復元した7件も同じ経路だった）。
 *
 * ここでは Stripe の Webhook（checkout.session.completed）を受け、
 * 受注の受け口（/api/webhooks/order）と同じ項目名に詰め替える。
 * 登録そのものは既存の処理に任せる。受け口を2つ持たず、重複よけ・担当者の付け方・
 * 1年後定期の仕込みを UTAGE 経由と同じにするため。
 *
 * ■ 受ける範囲
 *
 * 支払いリンク経由（session.payment_link がある）で、支払い済み（paid）のものだけ。
 * UTAGE の決済も同じ Stripe を通るが、UTAGE は Checkout Session を使わず
 * PaymentIntent を直接作るので、ここには来ない。来ても決済番号（pi_）が同じなら
 * 受け口側の重複よけで弾かれる。
 */

type Row = Record<string, unknown>;

const s_ = (r: Row | null | undefined, k: string): string => {
  const v = r?.[k];
  return v === null || v === undefined ? "" : String(v);
};

/** 署名の有効期限（秒）。Stripe の推奨どおり5分。 */
export const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Stripe-Signature ヘッダを検証する。
 *
 * ヘッダは `t=<unix秒>,v1=<hex>,v1=<hex>…` の形。
 * 署名は secret を鍵にした HMAC-SHA256(`${t}.${生の本文}`)。
 * 本文は JSON に戻す前の生の文字列でなければ一致しない。
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") timestamp = v ?? "";
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  return signatures.some((sig) => {
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Stripe は電話番号を E.164（+819012345678）で返す。
 * 日本の番号は先頭の +81 を 0 に戻して国内表記にする。それ以外はそのまま返す。
 */
export function phoneFromE164(v: string): string {
  const t = (v || "").trim();
  if (!t) return "";
  const digits = t.replace(/[^0-9]/g, "");
  if (t.startsWith("+81") || (t.startsWith("81") && digits.length >= 11)) {
    return "0" + digits.slice(2);
  }
  return t;
}

/** 支払いリンク経由の、支払い済みの Checkout だけを受ける。 */
export function isPaymentLinkCheckout(event: Row): boolean {
  if (s_(event, "type") !== "checkout.session.completed") return false;
  const session = ((event["data"] as Row | undefined)?.["object"] ?? null) as Row | null;
  if (!session) return false;
  if (!s_(session, "payment_link")) return false;
  return s_(session, "payment_status") === "paid";
}

/** Checkout Session から取り出す住所。配送先があればそれを、無ければ請求先を使う。 */
function addressOf(session: Row): { name: string; zip: string; address: string; building: string } {
  const shipping = (session["shipping_details"] ?? null) as Row | null;
  const billing = (session["customer_details"] ?? null) as Row | null;
  const src = shipping && shipping["address"] ? shipping : billing;
  const addr = ((src?.["address"] ?? {}) as Row) ?? {};
  // Stripe の住所は state=都道府県 / city=市区町村 / line1=町名番地 / line2=建物
  const address = [s_(addr, "state"), s_(addr, "city"), s_(addr, "line1")].filter(Boolean).join("");
  return {
    name: s_(shipping, "name") || s_(billing, "name"),
    zip: s_(addr, "postal_code"),
    address,
    building: s_(addr, "line2"),
  };
}

/** Checkout の明細1行。price.product を展開して取った名前を優先する。 */
export type CheckoutLineItem = {
  description?: string;
  quantity?: number;
  price?: { product?: { name?: string } | string } | null;
};

/** 明細から商品名を1本にまとめる。複数行なら「 ／ 」でつなぐ（商品マスタの表記に寄せる）。 */
export function productNameOf(items: CheckoutLineItem[]): string {
  const names = items
    .map((it) => {
      const product = it.price?.product;
      const fromProduct = product && typeof product === "object" ? (product.name ?? "") : "";
      return (fromProduct || it.description || "").trim();
    })
    .filter(Boolean);
  return names.join(" ／ ");
}

/**
 * Checkout Session（＋明細）を、受注の受け口が読む項目名に詰め替える。
 *
 * 受け口（/api/webhooks/order）は UTAGE の項目名で読むので、ここでもその名前にする。
 * 決済方法は空にしておく。受け口は空なら商品名から読み、どれにも当たらなければ
 * Stripe（カード）と判断する。支払いリンクはカード決済なのでそれで正しい。
 */
export function orderDataFromSession(
  session: Row,
  items: CheckoutLineItem[],
  opts: { productNameFallback?: string } = {},
): Record<string, string> {
  const billing = (session["customer_details"] ?? null) as Row | null;
  const who = addressOf(session);
  const amount = Number(session["amount_total"] ?? 0) || 0;
  const quantity =
    items.length === 1 ? Math.max(1, Number(items[0]?.quantity ?? 1) || 1) : 1;
  const productName =
    productNameOf(items) || opts.productNameFallback || "Stripe決済（商品名を取得できませんでした）";

  return {
    event: "stripe_payment_link",
    customer_name: who.name,
    email: s_(billing, "email").toLowerCase(),
    phone: phoneFromE164(s_(billing, "phone")),
    zipcode: who.zip,
    address: who.address,
    building: who.building,
    product_name: productName,
    amount: String(amount),
    quantity: String(quantity),
    payment_id: s_(session, "payment_intent"),
    checkout_session: s_(session, "id"),
    payment_link: s_(session, "payment_link"),
  };
}
