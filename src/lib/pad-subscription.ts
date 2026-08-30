import "server-only";

import { audit, selectOne, update } from "./db";
import { StripeError, stripeConfigured, stripeReq } from "./stripe";
import { todayInJapan } from "./jst";

/**
 * 1年後の定期パッド配送（17,500円/年・税込）を、受注が入った瞬間に仕込む。
 *
 * ■ 決まりごと（2026-08-27 会議）
 *
 *   ・本体を買った方は全員、1年後から毎年17,500円の定期パッド配送が始まる
 *   ・OP①（2年目ジェルパッド 13,200円）を付けた方は、1年後が免除で2年後から
 *   ・解約は公式LINEで受け、本部が止める
 *
 * ■ 決済方法ごとの扱い
 *
 *   クレジットカード … 決済に使ったカードで、Stripe に定期（トライアル付き）を作る。
 *                     期日が来ると自動で請求される。お客様の操作はない。
 *   銀行振込・アプラス … カードが無いので自動化できない。請求予定日だけを
 *                     顧客台帳（pad_charge_from）に残し、本部が期日に請求書を送る。
 *
 * ■ この処理は受注登録の「ついで」である
 *
 * ここで何が起きても受注・報酬には影響させない。失敗したら記録を残して黙って戻る。
 * 定期が作れていないお客様は pad_charge_from だけが入った状態になるので、
 * 本部が台帳から気づいて手で請求できる（取りこぼしが事故にならない形）。
 */

type Row = Record<string, unknown>;

const s_ = (r: Row | null | undefined, k: string): string => {
  const v = r?.[k];
  return v === null || v === undefined ? "" : String(v);
};

/** 定期の年額（税込）。商品マスタの「単体／追加パッド(１年分)」と同じ額。 */
const YEARLY_AMOUNT = 17500;

/** Stripe 上で年額プランを見つけるための名札。 */
const PRICE_LOOKUP_KEY = "vis_pad_yearly_17500";

/** 本体の受注か（パッド単体の買い足しには定期を付けない）。 */
function isMainUnitOrder(productName: string): boolean {
  const p = productName ?? "";
  if (!/本体/.test(p)) return false;
  if (/単体|追加パッド|追加パット/.test(p)) return false;
  return true;
}

/** OP①付きか。付いていれば初回請求は2年後になる。 */
function hasOp1(productName: string): boolean {
  return /OP①|２年目ジェルパット|2年目ジェルパット/.test(productName ?? "");
}

/** 日本時間の今日から days 日後の日付（YYYY-MM-DD）。 */
function chargeFromDate(days: number): string {
  const base = new Date(`${todayInJapan()}T00:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(base);
}

/** 17,500円/年の Price を用意する。既にあればそれを使う。 */
async function ensureYearlyPrice(): Promise<string> {
  const found = await stripeReq("GET", "/prices", {
    lookup_keys: [PRICE_LOOKUP_KEY],
    limit: 1,
  });
  const hit = (found["data"] as Row[] | undefined)?.[0];
  if (hit) return String(hit["id"]);

  const product = await stripeReq("POST", "/products", {
    name: "VIS 定期パッド配送（1年ごと）",
  });
  const price = await stripeReq("POST", "/prices", {
    product: String(product["id"]),
    currency: "jpy",
    unit_amount: YEARLY_AMOUNT,
    recurring: { interval: "year" },
    lookup_key: PRICE_LOOKUP_KEY,
  });
  return String(price["id"]);
}

/**
 * 受注1件ぶんの定期を仕込む。受注登録が終わったあとに呼ぶ。
 * どんな失敗でも投げない（受注の登録を巻き添えにしないため）。
 */
export async function schedulePadSubscription(orderId: string): Promise<void> {
  try {
    const order = await selectOne<Row>(
      `orders?select=id,customer_id,customer_name,product_name,payment_method,stripe_payment_id&id=eq.${encodeURIComponent(orderId)}`,
    );
    if (!order) return;

    const productName = s_(order, "product_name");
    if (!isMainUnitOrder(productName)) return;

    const customerId = s_(order, "customer_id");
    if (!/^\d+$/.test(customerId)) {
      // 顧客台帳に紐づいていない受注には予定日を残す場所がない。
      // 紐づけ失敗はすでに audit に残っているので、ここでは何もしない。
      return;
    }

    const days = hasOp1(productName) ? 730 : 365;
    const from = chargeFromDate(days);

    const customer = await selectOne<Row>(
      `customers?select=id,name,email,phone,pad_subscription_id,pad_charge_from&id=eq.${customerId}`,
    );
    if (!customer) return;

    // 同じお客様に二重に定期を作らない（通知の再送・買い直しで二度届くことがある）
    if (s_(customer, "pad_subscription_id")) return;

    /*
     * まず請求予定日を台帳に残す。ここから先（Stripe連携）が失敗しても、
     * 「この日から定期が始まるはずのお客様」が台帳から見えるようにする。
     */
    try {
      await update(`customers?id=eq.${customerId}`, { pad_charge_from: from });
    } catch {
      // 列がまだ無い。supabase/migrations の pad_subscription を流すと入り始める。
    }

    const method = s_(order, "payment_method");
    const paymentIntent = s_(order, "stripe_payment_id");
    if (method !== "Stripe" || !paymentIntent.startsWith("pi_")) {
      // 銀行振込・アプラス（またはカード情報なし）。自動化はせず、予定日の記録だけ。
      return;
    }
    if (!stripeConfigured()) {
      await audit("intake", "1年後定期を自動で作れませんでした", { type: "order", key: orderId }, {
        顧客: s_(order, "customer_name"),
        理由: "STRIPE_SECRET_KEY が未設定のため。設定後の受注から自動で作られます。",
        請求予定日: from,
      });
      return;
    }

    /* ── 決済に使ったカードを取り出す ── */
    const pi = await stripeReq("GET", `/payment_intents/${paymentIntent}`);
    const paymentMethod = s_(pi, "payment_method");
    if (!paymentMethod) {
      throw new Error("決済からカード情報を取り出せませんでした。");
    }

    /* ── Stripe 上のお客様を用意して、カードを持たせる ── */
    let stripeCustomer = s_(pi, "customer");
    if (!stripeCustomer) {
      const created = await stripeReq("POST", "/customers", {
        name: s_(customer, "name") || s_(order, "customer_name"),
        email: s_(customer, "email") || undefined,
        phone: s_(customer, "phone") || undefined,
        metadata: { vis_customer_id: customerId },
      });
      stripeCustomer = String(created["id"]);
    }
    try {
      await stripeReq("POST", `/payment_methods/${paymentMethod}/attach`, {
        customer: stripeCustomer,
      });
    } catch (e) {
      // すでに同じお客様に付いている場合はそのまま使えるので握りつぶす
      if (!(e instanceof StripeError && /already been attached/i.test(e.message))) throw e;
    }
    await stripeReq("POST", `/customers/${stripeCustomer}`, {
      invoice_settings: { default_payment_method: paymentMethod },
    });

    /* ── トライアル付きの定期を作る（期日が来ると 17,500円/年が自動で走る） ── */
    const price = await ensureYearlyPrice();
    const trialEnd = Math.floor(
      new Date(`${from}T00:00:00+09:00`).getTime() / 1000,
    );
    const sub = await stripeReq("POST", "/subscriptions", {
      customer: stripeCustomer,
      items: [{ price }],
      trial_end: trialEnd,
      metadata: {
        vis_order_id: orderId,
        vis_customer_id: customerId,
        op1: hasOp1(productName) ? "1" : "0",
      },
    });

    await update(`customers?id=eq.${customerId}`, {
      pad_subscription_id: String(sub["id"]),
    });
    await audit("intake", "1年後定期を作成", { type: "customer", key: customerId }, {
      顧客: s_(customer, "name"),
      初回請求日: from,
      OP1: hasOp1(productName) ? "あり（2年後開始）" : "なし（1年後開始）",
      Stripe定期: String(sub["id"]),
    });
  } catch (e) {
    /*
     * ここに来るのは Stripe 連携の失敗。
     * テストモードの決済（本番キーでは読めない）もここに落ちる。
     * 予定日は先に台帳へ入れてあるので、本部が手で請求すれば取りこぼしはない。
     */
    console.error("[pad-subscription]", e);
    await audit("intake", "1年後定期の自動作成に失敗", { type: "order", key: orderId }, {
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
      手当て: "顧客台帳の請求予定日（pad_charge_from）を見て、期日に手で請求してください。",
    });
  }
}
