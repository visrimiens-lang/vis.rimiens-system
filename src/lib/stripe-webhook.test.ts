import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_TOLERANCE_SEC,
  isPaymentLinkCheckout,
  orderDataFromSession,
  phoneFromE164,
  productNameOf,
  verifyStripeSignature,
} from "./stripe-webhook";

/**
 * stripe-webhook.ts は「Stripe の通知 → 受注の受け口の項目名」への詰め替えと、
 * 署名の検証だけを担う。登録そのものは受け口の既存処理に任せる。
 * ここでは**現在の実装が実際にどう動くか**を固定する。
 */

const SECRET = "whsec_test_secret";
const NOW = 1_800_000_000;

function sign(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyStripeSignature（署名の検証）", () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';

  it("正しい署名・時刻内なら通す", () => {
    expect(verifyStripeSignature(body, sign(body, NOW), SECRET, NOW)).toBe(true);
  });

  it("本文が1文字でも違えば弾く（生の本文で検証している）", () => {
    expect(verifyStripeSignature(body + " ", sign(body, NOW), SECRET, NOW)).toBe(false);
  });

  it("鍵が違えば弾く", () => {
    expect(verifyStripeSignature(body, sign(body, NOW, "whsec_other"), SECRET, NOW)).toBe(false);
  });

  it("有効期限（5分）を過ぎた時刻は弾く。境界ちょうどは通す", () => {
    const t = NOW - SIGNATURE_TOLERANCE_SEC - 1;
    expect(verifyStripeSignature(body, sign(body, t), SECRET, NOW)).toBe(false);
    const edge = NOW - SIGNATURE_TOLERANCE_SEC;
    expect(verifyStripeSignature(body, sign(body, edge), SECRET, NOW)).toBe(true);
  });

  it("ヘッダ無し・鍵未設定・v1 無しは弾く", () => {
    expect(verifyStripeSignature(body, null, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, NOW), "", NOW)).toBe(false);
    expect(verifyStripeSignature(body, `t=${NOW}`, SECRET, NOW)).toBe(false);
  });

  it("v1 が複数（鍵のローテーション中）なら、どれか1つ合えば通す", () => {
    const good = sign(body, NOW).split(",")[1];
    expect(verifyStripeSignature(body, `t=${NOW},v1=deadbeef,${good}`, SECRET, NOW)).toBe(true);
  });
});

describe("phoneFromE164（電話番号の国内表記化）", () => {
  it("+81 を 0 に戻す", () => {
    expect(phoneFromE164("+819075978739")).toBe("09075978739");
    expect(phoneFromE164("+81 90-7597-8739")).toBe("09075978739");
  });
  it("国内表記はそのまま。空は空", () => {
    expect(phoneFromE164("090-7597-8739")).toBe("090-7597-8739");
    expect(phoneFromE164("")).toBe("");
  });
});

describe("isPaymentLinkCheckout（受ける範囲）", () => {
  const base = {
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", payment_link: "plink_1", payment_status: "paid" } },
  };
  it("支払いリンク経由・支払い済みなら受ける", () => {
    expect(isPaymentLinkCheckout(base)).toBe(true);
  });
  it("支払いリンク以外（UTAGE など）の Checkout は受けない", () => {
    expect(
      isPaymentLinkCheckout({ ...base, data: { object: { ...base.data.object, payment_link: null } } }),
    ).toBe(false);
  });
  it("未払い（銀行振込待ちなど）は受けない", () => {
    expect(
      isPaymentLinkCheckout({ ...base, data: { object: { ...base.data.object, payment_status: "unpaid" } } }),
    ).toBe(false);
  });
  it("別のイベント種別は受けない", () => {
    expect(isPaymentLinkCheckout({ ...base, type: "payment_intent.succeeded" })).toBe(false);
  });
});

describe("orderDataFromSession（受け口の項目名への詰め替え）", () => {
  const session = {
    id: "cs_test_1",
    payment_link: "plink_1",
    payment_status: "paid",
    payment_intent: "pi_3TEST",
    amount_total: 203500,
    customer_details: {
      name: "曳野 美華",
      email: "Unsourire.Mika@gmail.com",
      phone: "+819075978739",
      address: {
        postal_code: "150-0001",
        state: "東京都",
        city: "渋谷区",
        line1: "神宮前1-1-1",
        line2: "テストビル3F",
        country: "JP",
      },
    },
  };
  const items = [
    { description: "眼筋トレーニングマシンVIS 一式（先行予約）", quantity: 1, price: { product: { name: "VIS本体 先行予約" } } },
  ];

  it("名前・連絡先・住所・金額・決済番号を受け口の項目名で返す", () => {
    const d = orderDataFromSession(session, items);
    expect(d).toMatchObject({
      event: "stripe_payment_link",
      customer_name: "曳野 美華",
      email: "unsourire.mika@gmail.com",
      phone: "09075978739",
      zipcode: "150-0001",
      address: "東京都渋谷区神宮前1-1-1",
      building: "テストビル3F",
      product_name: "VIS本体 先行予約",
      amount: "203500",
      quantity: "1",
      payment_id: "pi_3TEST",
      checkout_session: "cs_test_1",
    });
    // 決済方法は入れない（受け口が商品名から判断し、当たらなければ Stripe とする）
    expect(d).not.toHaveProperty("payment_method");
  });

  it("配送先があれば請求先より配送先を使う", () => {
    const withShipping = {
      ...session,
      shipping_details: {
        name: "受取 太郎",
        address: { postal_code: "343-0845", state: "埼玉県", city: "越谷市", line1: "南越谷4-16-7", line2: "" },
      },
    };
    const d = orderDataFromSession(withShipping, items);
    expect(d.customer_name).toBe("受取 太郎");
    expect(d.zipcode).toBe("343-0845");
    expect(d.address).toBe("埼玉県越谷市南越谷4-16-7");
    expect(d.building).toBe("");
  });

  it("明細が複数なら商品名を「 ／ 」でつなぎ、台数は1にする", () => {
    const many = [
      { quantity: 1, price: { product: { name: "VIS本体 先行予約" } } },
      { quantity: 1, price: { product: { name: "3年保証セット" } } },
    ];
    const d = orderDataFromSession(session, many);
    expect(d.product_name).toBe("VIS本体 先行予約 ／ 3年保証セット");
    expect(d.quantity).toBe("1");
  });

  it("明細が1行で台数2なら台数を伝える", () => {
    const d = orderDataFromSession(session, [{ quantity: 2, description: "VIS本体" }]);
    expect(d.quantity).toBe("2");
  });

  it("明細が取れなかったときは、指定の代替名か既定の文言にする", () => {
    expect(orderDataFromSession(session, [], { productNameFallback: "取得失敗" }).product_name).toBe("取得失敗");
    expect(orderDataFromSession(session, []).product_name).toBe("Stripe決済（商品名を取得できませんでした）");
  });

  it("productNameOf は product.name → description の順で拾い、空の行は飛ばす", () => {
    expect(
      productNameOf([{ description: "説明だけ" }, { description: "" }, { price: { product: "prod_x" }, description: "展開なし" }]),
    ).toBe("説明だけ ／ 展開なし");
  });
});
