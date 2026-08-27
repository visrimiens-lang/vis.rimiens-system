import { payItemsOf, type PayItem } from "./pay-items";
import type { Agency } from "./types";

/**
 * 「この代理店に1台あたりいくら払うか」の決め方。
 *
 * 個別の額（agencies.pay_unit）が入っていればそれを使い、
 * 無ければ 2026-08-19 の打合せで決めた推奨額を使う。
 *
 * ■ 金額は税抜きで統一（2026-08-19 決定）
 *
 * 契約は「基本、税金は払わない」前提で、税抜きの金額をそのまま払う。
 * 税込で書くと語弊が生まれるので、この欄の金額はすべて税抜き。
 *   販売代理店（3次）… 50,000円
 *   取次パートナー   … 25,000円
 *
 * ■ 統括（2次）と総販には既定を置かない
 *
 * 統括へのお支払いは本部からの報酬（商品マスタの税込単価で自動計上）が担当で、
 * この欄の出番は無い。額を変えたいときだけ個別に入れる。
 *
 * 組織図・本部の代理店管理・配下への支払い集計の3か所から使うので、
 * 数字はここにだけ置く。ばらばらに持つと画面ごとに額が食い違う。
 */
export function defaultPayUnit(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "staffType">,
): number | null {
  /*
   * スタッフ（区分02）の既定は、その人の種別で決まる（2026-08-26 決定）。
   *
   *   取次店   … 25,000円（紹介だけで販売はしないため）
   *   それ以外 … 50,000円（販売代理店・サロン代理店・個人販売代理店）
   *
   * 種別がまだ設定されていない人にも 50,000円 を出す。
   * ここを null にすると、売上・報酬のお支払額が「—」のままになり、
   * 支払通知が作れない（それに気づかず払い漏れる）ため。
   * 種別ごとに違う額にしたい場合は「組織と枠」で個別の額を入れれば上書きされる。
   */
  if (a.codeKind === "02") {
    return a.staffType === "取次店" ? 25000 : 50000;
  }

  // 3次（販売代理店）は「ランク＝取次店 ＋ 販路種別＝販売代理店」で表す（lib/orders.ts と同じ）
  const rank = a.rank === "取次店" && a.channel === "販売代理店" ? "販売代理店" : a.rank;
  if (rank === "販売代理店") return 50000;
  if (rank === "取次店") return 25000;
  return null;
}

/** 実際に使われる1台あたりの支払額（税抜き）。個別の額が最優先。 */
export function effectivePayUnit(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "payUnit" | "staffType">,
): number | null {
  return a.payUnit ?? defaultPayUnit(a);
}

/* ═══════════════════════ 品目ごとの支払額 ═══════════════════════ */

/**
 * 支払額を画面に税込で出すための換算。
 *
 * 支払額は税抜きで持っている（2026-08-19 決定）。支払通知書は小計に消費税を足して
 * 総額を出すので、保存値は税抜きのままでないと二重に課税された額が書面に載る。
 * 画面の見出しを「税込」でそろえるときだけ、ここを通して出す。
 *
 * 税込にすると商品マスタの額と一致する。
 *   販売代理店 50,000 → 55,000（商品マスタの販売代理店ぶんと同じ）
 *   取次店     25,000 → 27,500（同上）
 */
export function payTaxIncl(amount: number): number {
  return Math.round(amount * 1.1);
}

/**
 * 画面から受け取った税込の額を、保存する税抜きの額に戻す。
 *
 * 入力欄も税込にそろえたので（2026-08-27）、保存の直前にここを通す。
 * 55,000 → 50,000 / 27,500 → 25,000 / 550 → 500 のように、
 * 実際に使う額はどれも割り切れる。
 */
export function payTaxExcl(amount: number): number {
  return Math.round(amount / 1.1);
}

/** 品目ごとの1件あたりの支払額（税抜）。null は「この品目では払わない」。 */
export type PayUnits = Record<PayItem, number | null>;

type PayUnitFields = Pick<
  Agency,
  "rank" | "channel" | "codeKind" | "staffType" | "payUnit" | "payUnitOp1" | "payUnitOp2" | "payUnitPadYearly"
>;

/**
 * この相手に払う額を品目ごとに出す。
 *
 * 本体は今までどおり、個別の額が無ければランクの既定（50,000／25,000）を使う。
 * OP①・OP②・1年後定期には既定を置かない。ここに額を入れて初めて払う扱いになる。
 * 既定を置いてしまうと、これまで本体だけで払っていた相手の支払額が
 * この画面を開いた日から勝手に増えるため。
 */
export function effectivePayUnits(a: PayUnitFields): PayUnits {
  return {
    body: effectivePayUnit(a),
    op1: a.payUnitOp1,
    op2: a.payUnitOp2,
    padYearly: a.payUnitPadYearly,
  };
}

/**
 * 受注1件ぶんの支払額。含まれている品目の額を足し、数量を掛ける。
 *
 * 本体の額が決まっていないときだけ null を返す（「まだ決めていない」を
 * 0円と区別して、画面に「—」を出すため）。
 * OP の額が未設定なのは「その品目では払わない」という意味なので、
 * 0 として足す。
 */
export function payoutForOrder(
  units: PayUnits,
  productName: string,
  quantity: number,
): number | null {
  const items = payItemsOf(productName);
  if (items.includes("body") && units.body === null) return null;
  const per = items.reduce((sum, i) => sum + (units[i] ?? 0), 0);
  return per * (quantity || 1);
}
