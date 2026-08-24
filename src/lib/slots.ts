import "server-only";
import type { Agency } from "./types";

/**
 * 枠のルール。
 *
 * ── 統括代理店（2次代理店）1社あたりの配下枠 ── スタッフ100名
 *   （2026-08-22「組織と枠 → 100名（スタッフ）」）
 *   直下にいる稼働中の相手は、区分にかかわらず1名ぶん使う。
 *
 *   それ以前は販路種別ごとに4本に分けていた（販売10／サロン30／個人30／取次30 ＝ 100）。
 *   エリア統括の下が全員スタッフになり、種別で分ける意味がなくなったため1本にした。
 *
 * ── 統括代理店そのものの枠（全国） ── 合計60社
 *   北海道+東北 10 / 関東 15 / 中部 10 / 関西+近畿 10 / 中国+四国 5 / 九州+沖縄 10
 *   （2026-06-25 東純汰さん回答で確定）
 */

/**
 * 直下に登録できるスタッフの上限（既定）。
 *
 * 2026-08-22 から、枠は「スタッフ100名」の1本になった。
 * それまでは販路種別ごとに 販売10／サロン30／個人30／取次30 の4本に分けていたが、
 * エリア統括の下が全員スタッフになり、種別で分ける意味がなくなった。
 */
export const DEFAULT_STAFF_LIMIT = 100;

/** エリアごとの統括代理店（2次代理店）の上限。全国で60社。 */
export const AREA_QUOTA: { area: string; limit: number }[] = [
  { area: "北海道+東北", limit: 10 },
  { area: "関東", limit: 15 },
  { area: "中部", limit: 10 },
  { area: "関西+近畿", limit: 10 },
  { area: "中国+四国", limit: 5 },
  { area: "九州+沖縄", limit: 10 },
];

export const AREA_TOTAL = AREA_QUOTA.reduce((s, a) => s + a.limit, 0); // 60

export type SlotBreakdown = {
  /** 上限。0 は「上限なし」（特別枠や、本部が意図的に外した相手） */
  limit: number;
  used: number;
  remaining: number;
  isFull: boolean;
  /** 枠を使っている直下（稼働中のみ） */
  members: Agency[];
};

/** 稼働していない相手は枠を消費しない。 */
function isActive(a: Agency): boolean {
  return a.status !== "停止・解約";
}

/**
 * 枠を消費する相手かどうか。
 *
 * 2026-08-22 から「直下にいる稼働中の相手は、区分にかかわらず1人ぶん枠を使う」。
 * それまではスタッフ（区分02）だけ枠を使わない決まりだったが、
 * エリア統括の下が全員スタッフになったため、そのままだと枠が働かない。
 *
 * 数え方はここ1か所に集める。以前は
 *   ・slots.ts consumesSlot（区分02以外）
 *   ・agencies.ts countsTowardSlot（区分00だけ）
 *   ・intake.ts canRegisterUnder（DBを直接数える）
 * の3つが別々の答えを出していて、「画面では空きがあるのに申込は弾かれる」
 * という食い違いが起きうる状態だった。
 */
export function consumesSlot(a: Agency): boolean {
  return isActive(a);
}

/**
 * ある代理店の直下について、スタッフ枠の使用状況を出す。
 * 上限は代理店ごとの設定（limit_staff）があればそれ、無ければ既定の100名。
 */
export function breakdownSlots(
  parent: Agency,
  directChildren: Agency[],
  staffLimit?: number,
): SlotBreakdown {
  const members = directChildren.filter(consumesSlot);
  const raw = staffLimit ?? parent.staffLimit ?? DEFAULT_STAFF_LIMIT;
  // 0 と特別枠は「上限なし」の意味で使われている
  const unlimited = raw <= 0 || parent.specialSlot;
  const limit = unlimited ? 0 : raw;
  const used = members.length;
  return {
    limit,
    used,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    isFull: !unlimited && used >= limit,
    members,
  };
}

export type AreaUsage = {
  area: string;
  limit: number;
  used: number;
  remaining: number;
  isFull: boolean;
  members: Agency[];
};

/**
 * エリアごとの統括代理店の枠。
 * 数えるのは「代理店ランク = 2次代理店」かつ稼働中のもの。
 * エリア区分が「本部」の既存5社と、ゼロ次代理店は枠から除外する
 * （2026-07-09 の決定どおり）。
 */
export function areaUsage(all: Agency[]): {
  rows: AreaUsage[];
  total: { limit: number; used: number; remaining: number };
  excluded: Agency[];
} {
  const targets = all.filter(
    (a) => a.rank === "2次代理店" && isActive(a) && a.area !== "本部",
  );
  const excluded = all.filter(
    (a) => a.rank === "2次代理店" && isActive(a) && a.area === "本部",
  );

  const rows = AREA_QUOTA.map(({ area, limit }) => {
    const members = targets.filter((a) => a.area === area);
    return {
      area,
      limit,
      used: members.length,
      remaining: Math.max(0, limit - members.length),
      isFull: members.length >= limit,
      members,
    };
  });

  const used = rows.reduce((s, r) => s + r.used, 0);
  return {
    rows,
    total: { limit: AREA_TOTAL, used, remaining: Math.max(0, AREA_TOTAL - used) },
    excluded,
  };
}

/**
 * その代理店の配下に、どちらの枠が効くか。
 *
 *   総販売代理店（RIM）の配下 → 統括代理店なので「エリア枠（全国60社）」
 *   統括代理店（2次）の配下   → 「スタッフ100名」の枠
 *
 * 階層が違えば枠の意味も違う。取り違えると本部と代理店で見える数字がずれる。
 */
export function slotModelOf(agency: Agency): "area" | "staff" | "none" {
  // 取次パートナーとスタッフは配下を持たない。枠の画面自体が意味をなさない。
  if (agency.codeKind === "01" || agency.codeKind === "02") return "none";
  if (agency.rank === "取次店") return "none";
  return agency.rank === "総販売代理店" ? "area" : "staff";
}
