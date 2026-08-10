import "server-only";
import { APP, getRecords, num, str, type KintoneRecord } from "./kintone";
import type { Agency, Order } from "./types";

const FIELDS = [
  "レコード番号",
  "日付",
  "注文者名",
  "商品名",
  "販売金額",
  "数量",
  "電話番号",
  "出荷状況",
  "出荷完了日",
  "決済方法",
  "照合ステータス",
  "代理店コード",
  "_2次代理店コード",
  "取次紹介コード",
  "ヤマト送り状番号",
  "総販売代理店報酬用",
  "_2次代理店報酬用",
  "取次店報酬用",
];

function toOrder(r: KintoneRecord): Order {
  const referrer = str(r, "取次紹介コード");
  const agencyCode = str(r, "代理店コード");
  return {
    recordId: str(r, "レコード番号"),
    date: str(r, "日付"),
    customerName: str(r, "注文者名"),
    productName: str(r, "商品名"),
    amount: num(r, "販売金額"),
    quantity: num(r, "数量") || 1,
    phone: str(r, "電話番号"),
    shippingStatus: str(r, "出荷状況"),
    shippedAt: str(r, "出荷完了日"),
    paymentMethod: str(r, "決済方法"),
    matchStatus: str(r, "照合ステータス"),
    agencyCode,
    secondaryCode: str(r, "_2次代理店コード"),
    referrerCode: referrer,
    trackingNo: str(r, "ヤマト送り状番号"),
    ownerCode: referrer || agencyCode,
  };
}

/** 1件の受注につき、指定ランクの人が受け取る単価。 */
export function unitRewardFor(r: KintoneRecord, rank: string): number | null {
  switch (rank) {
    case "総販売代理店":
      return num(r, "総販売代理店報酬用");
    case "2次代理店":
      return num(r, "_2次代理店報酬用");
    case "取次店":
      return num(r, "取次店報酬用");
    default:
      // 「販売代理店」ぶんの受け皿フィールドが App10 に無いため、金額を出せない。
      return null;
  }
}

export type OrderWithReward = Order & { unitReward: number | null; reward: number | null };

export type OrderQuery = {
  /** "2026-08" 形式。未指定なら全期間。 */
  month?: string;
  /** 月の判定に使う日付。既定は受注日。報酬は配送完了日で見る。 */
  basis?: "order" | "shipped";
};

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

/**
 * 代理店（とその配下）に紐づく受注を取得する。
 * 受注件数は多くないため、期間で絞ったうえでコード一致はアプリ側で判定する。
 */
export async function listOrders(
  codes: string[],
  opts: OrderQuery = {},
): Promise<{ orders: OrderWithReward[]; raw: KintoneRecord[] }> {
  const basisField = opts.basis === "shipped" ? "出荷完了日" : "日付";
  const conds: string[] = [];
  if (opts.month) {
    const { from, to } = monthRange(opts.month);
    conds.push(`${basisField} >= "${from}"`, `${basisField} <= "${to}"`);
  }
  const query = `${conds.join(" and ")}${conds.length ? " " : ""}order by 日付 desc limit 500`;
  const rows = await getRecords(APP.order, query, FIELDS);

  const set = new Set(codes.filter(Boolean));
  const matched = rows.filter((r) => {
    const a = str(r, "代理店コード");
    const s = str(r, "_2次代理店コード");
    const t = str(r, "取次紹介コード");
    return set.has(a) || set.has(s) || set.has(t);
  });

  return { orders: matched.map(toOrder) as OrderWithReward[], raw: matched };
}

/** 受注一覧に、指定ランクでの報酬額を付ける。 */
export function attachRewards(
  raw: KintoneRecord[],
  rank: string,
): OrderWithReward[] {
  return raw.map((r) => {
    const o = toOrder(r);
    const unit = unitRewardFor(r, rank);
    return {
      ...o,
      unitReward: unit,
      reward: unit === null ? null : unit * (o.quantity || 1),
    };
  });
}

export type MonthlySummary = {
  month: string;
  orderCount: number;
  unitCount: number;
  salesTotal: number;
  rewardTotal: number | null;
  shippedCount: number;
};

/** ダッシュボード用の月次サマリー。 */
export function summarize(orders: OrderWithReward[], month: string): MonthlySummary {
  let rewardTotal: number | null = 0;
  for (const o of orders) {
    if (o.reward === null) {
      rewardTotal = null;
      break;
    }
    rewardTotal += o.reward;
  }
  return {
    month,
    orderCount: orders.length,
    unitCount: orders.reduce((s, o) => s + (o.quantity || 1), 0),
    salesTotal: orders.reduce((s, o) => s + o.amount, 0),
    rewardTotal,
    shippedCount: orders.filter((o) => o.shippingStatus === "出荷済").length,
  };
}

/** 表示対象コードの一覧を作る（自分＋配下）。 */
export function scopeCodes(self: Agency, descendants: Agency[]): string[] {
  return [self.code, ...descendants.map((d) => d.code)];
}

/** 直近Nか月の "YYYY-MM" を新しい順で返す。 */
export function recentMonths(n: number, today = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function currentMonth(today = new Date()): string {
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 報酬の単価を引くときに使う「実際のランク」。
 *
 * App9 の代理店ランクには「販売代理店」という選択肢が無く、
 * 販路種別のほうに入っている。単価の引き先を決めるのはこちらなので、
 * 販路種別が「販売代理店」ならそれを優先する。
 * 画面ごとに判定がぶれると同じ代理店に違う金額が出るため、必ずここを通す。
 */
export function effectiveRank(agency: Agency): string {
  if (agency.channel === "販売代理店") return "販売代理店";
  return agency.rank;
}

/** そのランクで1台あたりの報酬額を出せるかどうか。受注が0件でも判定できる。 */
export function canComputeReward(agency: Agency): boolean {
  return unitRewardFor({}, effectiveRank(agency)) !== null;
}
