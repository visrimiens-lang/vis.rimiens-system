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
 * ■ 統括（2次）と総販にも推奨額を置く（2026-08-27 会議）
 *
 * 「Rimiensが目トレからもらう金額も変更できるように」との決定を受け、
 * 本部の報酬計上（lib/rewards.ts）もこの推奨額＋金額修正の上書きで計算する。
 * 推奨のままなら商品マスタの報酬列と同じ金額になる。
 *
 * 組織図・本部の代理店管理・配下への支払い集計の3か所から使うので、
 * 数字はここにだけ置く。ばらばらに持つと画面ごとに額が食い違う。
 */
/**
 * 推奨額の一覧（1台・1件あたり、税抜き）。2026-08-27 会議の提案資料より。
 *
 *   目トレ → 総販売代理店      本体 70,000 ／ OP① 3,000 ／ OP② 3,000 ／ 1年後定期 3,000
 *   総販 → エリア統括（2次）   本体 57,000 ／ OP① 1,000 ／ OP② 2,000 ／ 1年後定期 1,000
 *   統括 → 3次・スタッフ販売系 本体 50,000 ／ OP①    500 ／ OP② 1,000 ／ 1年後定期   500
 *   統括 → 取次（紹介のみ）    本体 25,000 ／ OP系は払わない
 *
 * 税込にすると商品マスタの報酬列と一致する
 * （例：本体 62,700・OP① 1,100 → 統括の「本体＋OP①」は 63,800）。
 *
 * 会議の決定は「推奨は既定として自動で効かせ、変えたい相手だけ金額修正で上書きする」。
 * 以前は OP系に既定を置いていなかったため、統括のスタッフへの支払額が
 * 本体ぶんだけになり、商品マスタ（55,550 など）と食い違って見えていた。
 */
type RankDefaults = { body: number | null; op1: number | null; op2: number | null; padYearly: number | null };
const RANK_DEFAULTS: Record<string, RankDefaults> = {
  総販売代理店: { body: 70000, op1: 3000, op2: 3000, padYearly: 3000 },
  "2次代理店": { body: 57000, op1: 1000, op2: 2000, padYearly: 1000 },
  販売代理店: { body: 50000, op1: 500, op2: 1000, padYearly: 500 },
  取次店: { body: 25000, op1: null, op2: null, padYearly: null },
};

function effectiveRankOf(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "staffType">,
): string {
  /*
   * スタッフ（区分02）は、その人の種別で決まる（2026-08-26 決定）。
   *   取次店   … 紹介だけで販売はしない
   *   それ以外 … 販売系（販売代理店・サロン代理店・個人販売代理店）。
   *              種別がまだ設定されていない人も販売系として扱う。
   *              ここを null にすると、売上・報酬のお支払額が「—」のままになり、
   *              支払通知が作れない（それに気づかず払い漏れる）ため。
   */
  if (a.codeKind === "02") {
    return a.staffType === "取次店" ? "取次店" : "販売代理店";
  }
  // 3次（販売代理店）は「ランク＝取次店 ＋ 販路種別＝販売代理店」で表す（lib/orders.ts と同じ）
  return a.rank === "取次店" && a.channel === "販売代理店" ? "販売代理店" : a.rank;
}

/** 品目ごとの推奨額（税抜き）。ランクに推奨が無ければすべて null。 */
export function defaultPayUnits(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "staffType">,
): PayUnits {
  const d = RANK_DEFAULTS[effectiveRankOf(a)];
  return d
    ? { body: d.body, op1: d.op1, op2: d.op2, padYearly: d.padYearly }
    : { body: null, op1: null, op2: null, padYearly: null };
}

export function defaultPayUnit(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "staffType">,
): number | null {
  return defaultPayUnits(a).body;
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
 * どの品目も、個別の額（金額修正で入れた値）が最優先。
 * 無ければランクの推奨額（RANK_DEFAULTS）が自動で効く（2026-08-27 会議）。
 */
export function effectivePayUnits(a: PayUnitFields): PayUnits {
  const d = defaultPayUnits(a);
  return {
    body: a.payUnit ?? d.body,
    op1: a.payUnitOp1 ?? d.op1,
    op2: a.payUnitOp2 ?? d.op2,
    padYearly: a.payUnitPadYearly ?? d.padYearly,
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
