import "server-only";
import type { Agency } from "./types";

/**
 * 枠のルール。
 *
 * ── 統括代理店（2次代理店）1社あたりの配下枠 ── 合計100枠
 *   販売代理店                  10
 *   サロン代理店                30
 *   個人販売パートナー           30
 *   サロン提携パートナー（取次） 30
 *   （2026-07-30 会議「10 30 30で取次30、全部で100の枠」）
 *
 * ── 統括代理店そのものの枠（全国） ── 合計60社
 *   北海道+東北 10 / 関東 15 / 中部 10 / 関西+近畿 10 / 中国+四国 5 / 九州+沖縄 10
 *   （2026-06-25 東純汰さん回答で確定）
 */

/** 販路種別ごとの枠の定義。並び順がそのまま画面の表示順になる。 */
export const SLOT_KINDS = [
  {
    key: "販売代理店",
    label: "販売代理店",
    limitField: "販売代理店枠上限",
    defaultLimit: 10,
    /** この種別に該当するか。コード区分ではなく販路種別で判定する。 */
    match: (a: Agency) => a.channel === "販売代理店",
    note: "会社として販売する代理店",
  },
  {
    key: "サロン代理店",
    label: "サロン代理店",
    limitField: "サロン代理店枠上限",
    defaultLimit: 30,
    match: (a: Agency) => a.channel === "サロン代理店",
    note: "店舗を持つサロン",
  },
  {
    key: "個人販売パートナー",
    label: "個人販売パートナー",
    limitField: "個人代理店枠上限",
    defaultLimit: 30,
    match: (a: Agency) => a.channel === "個人販売パートナー",
    note: "個人で販売する方（税理士・保険など）",
  },
  {
    key: "サロン提携パートナー（取次）",
    label: "取次パートナー",
    limitField: "取次店枠上限",
    defaultLimit: 30,
    match: (a: Agency) => a.channel === "サロン提携パートナー（取次）",
    note: "紹介のみ。販売はしない",
  },
] as const;

export type SlotKindKey = (typeof SLOT_KINDS)[number]["key"];

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

export type SlotLine = {
  key: SlotKindKey;
  label: string;
  note: string;
  limit: number;
  used: number;
  remaining: number;
  isFull: boolean;
  members: Agency[];
};

export type SlotBreakdown = {
  lines: SlotLine[];
  totalLimit: number;
  totalUsed: number;
  /** どれか1種別でも埋まっているか */
  anyFull: boolean;
  /** 販路種別が未設定などで、どの枠にも入らなかった配下 */
  unclassified: Agency[];
  /** 枠を消費しないスタッフ（コード区分 02） */
  staff: Agency[];
};

/** 稼働していない代理店は枠を消費しない。 */
function isActive(a: Agency): boolean {
  return a.status !== "停止・解約";
}

/**
 * 枠を消費する相手かどうか。
 *
 * スタッフ（コード区分 02）は代理店ではなく、代理店に所属する個人なので枠を使わない。
 * スタッフ登録シナリオ(#15)は販路種別に「販売代理店」を入れるため、
 * 販路種別だけで判定すると販売代理店の枠を食ってしまう。ここで先に外す。
 */
function consumesSlot(a: Agency): boolean {
  return isActive(a) && a.codeKind !== "02";
}

/**
 * ある統括代理店の直下について、販路種別ごとの枠の使用状況を出す。
 * 上限は App9 のフィールドがあればそれを、無ければ既定値を使う。
 */
export function breakdownSlots(
  parent: Agency,
  directChildren: Agency[],
  limits: Partial<Record<string, number>> = {},
): SlotBreakdown {
  const active = directChildren.filter(consumesSlot);
  const claimed = new Set<string>();

  const lines: SlotLine[] = SLOT_KINDS.map((kind) => {
    const members = active.filter((a) => kind.match(a));
    members.forEach((m) => claimed.add(m.code));
    const limit = limits[kind.limitField] ?? kind.defaultLimit;
    const used = members.length;
    return {
      key: kind.key,
      label: kind.label,
      note: kind.note,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      isFull: used >= limit,
      members,
    };
  });

  return {
    lines,
    totalLimit: lines.reduce((s, l) => s + l.limit, 0),
    totalUsed: lines.reduce((s, l) => s + l.used, 0),
    anyFull: lines.some((l) => l.isFull),
    unclassified: active.filter((a) => !claimed.has(a.code)),
    staff: directChildren.filter((a) => isActive(a) && a.codeKind === "02"),
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
 *   統括代理店（2次）の配下   → 販路種別ごとの「100枠」
 *
 * 階層が違えば枠の意味も違う。取り違えると本部と代理店で見える数字がずれる。
 */
export function slotModelOf(agency: Agency): "area" | "channel" {
  return agency.rank === "総販売代理店" ? "area" : "channel";
}
