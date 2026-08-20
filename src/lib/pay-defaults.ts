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
  a: Pick<Agency, "rank" | "channel" | "codeKind">,
): number | null {
  /*
   * スタッフ（区分02）には支払額が無い。
   *
   * スタッフが売った売上は所属先の会社に付くので（src/lib/intake.ts の
   * resolveAttribution）、本人あてに報酬が立つことはない。
   * ここで額を返すと、組織図と代理店管理の支払額の欄に
   * 「1台あたり5万円」と出てしまい、払う約束をしたように見えてしまう。
   */
  if (a.codeKind === "02") return null;

  // 3次（販売代理店）は「ランク＝取次店 ＋ 販路種別＝販売代理店」で表す（lib/orders.ts と同じ）
  const rank = a.rank === "取次店" && a.channel === "販売代理店" ? "販売代理店" : a.rank;
  if (rank === "販売代理店") return 50000;
  if (rank === "取次店") return 25000;
  return null;
}

/** 実際に使われる1台あたりの支払額（税抜き）。個別の額が最優先。 */
export function effectivePayUnit(
  a: Pick<Agency, "rank" | "channel" | "codeKind" | "payUnit">,
): number | null {
  return a.payUnit ?? defaultPayUnit(a);
}
