import type { Agency } from "./types";

/**
 * 「この代理店に1台あたりいくら払うか」の決め方。
 *
 * 個別の額（agencies.pay_unit）が入っていればそれを使い、
 * 無ければランクごとの推奨額（2026-07-30 会議で決めた既定）を使う。
 *
 * 契約上の言い方では 販売代理店 5万円（税別）＝55,000円（税込）、
 * 取次パートナー 2.5万円（税別）＝27,500円（税込）。
 * 商品マスタのランク別報酬額と同じ数字で、本体1台の目安。
 *
 * 組織図・本部の代理店管理・配下への支払い集計の3か所から使うので、
 * 数字はここにだけ置く。ばらばらに持つと画面ごとに額が食い違う。
 */
export function defaultPayUnit(
  a: Pick<Agency, "rank" | "channel">,
): number | null {
  // 3次（販売代理店）は「ランク＝取次店 ＋ 販路種別＝販売代理店」で表す（lib/orders.ts と同じ）
  const rank = a.rank === "取次店" && a.channel === "販売代理店" ? "販売代理店" : a.rank;
  if (rank === "総販売代理店") return 77000;
  if (rank === "2次代理店") return 62700;
  if (rank === "販売代理店") return 55000;
  if (rank === "取次店") return 27500;
  return null;
}

/** 実際に使われる1台あたりの支払額。個別の額が最優先。 */
export function effectivePayUnit(
  a: Pick<Agency, "rank" | "channel" | "payUnit">,
): number | null {
  return a.payUnit ?? defaultPayUnit(a);
}
