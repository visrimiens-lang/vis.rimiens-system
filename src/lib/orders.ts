import "server-only";
import { select } from "./db";
import { PRODUCT_COLUMNS, buildProductMatcher } from "./product-match";
import type { Agency, Order } from "./types";

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const n_ = (r: Row, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};
/** PostgREST の in.() に渡す値を組み立てる。 */
const inList = (codes: string[]): string =>
  "(" + codes.map((c) => '"' + c.replace(/"/g, '\\"') + '"').join(",") + ")";

function toOrder(r: Row): Order {
  const referrer = s_(r, "referrer_code");
  const agencyCode = s_(r, "agency_code");
  return {
    recordId: s_(r, "id"),
    date: s_(r, "ordered_on"),
    customerName: s_(r, "customer_name"),
    productName: s_(r, "product_name"),
    amount: n_(r, "amount"),
    quantity: n_(r, "quantity") || 1,
    phone: s_(r, "phone"),
    shippingStatus: s_(r, "ship_status"),
    shippedAt: s_(r, "shipped_on"),
    deliveredAt: s_(r, "delivered_on"),
    paymentMethod: s_(r, "payment_method"),
    matchStatus: s_(r, "match_status"),
    agencyCode,
    secondaryCode: s_(r, "niji_code"),
    referrerCode: referrer,
    trackingNo: s_(r, "tracking_no"),
    staffCode: s_(r, "staff_code"),
    /*
     * この受注を「誰の担当ぶん」として数えるか。
     *
     * 取次の紹介 → 紹介した取次店
     * スタッフが売った → そのスタッフ本人
     * それ以外 → 売った代理店
     *
     * スタッフ本人を見るようにしたのは 2026-08-22 から。
     * エリア統括の下が全員スタッフになり、売ると agency_code が
     * 統括のコードに揃ってしまうため、本人を見ないと担当ごとに割れない
     * （統括の明細が「SASA 1行」に潰れる）。
     */
    ownerCode: referrer || s_(r, "staff_code") || agencyCode,
  };
}

/**
 * 1件の受注につき、指定ランクの人が受け取る単価。
 *
 * 単価は商品マスタ（products）に入っている。
 * listOrders が受注1件ごとに単価を引いて行に載せてくるので、ここではそれを読むだけ。
 * 商品名が商品マスタに無いときは null（金額を出さず、画面には「—」と出す）。
 */
export function unitRewardFor(r: Row, rank: string): number | null {
  const key =
    rank === "総販売代理店" ? "_unit_so"
    : rank === "2次代理店" ? "_unit_niji"
    : rank === "取次店" ? "_unit_toritsugi"
    : rank === "販売代理店" ? "_unit_hanbai"
    : "";
  if (!key) return null;
  const v = r[key];
  return v === null || v === undefined ? null : Number(v);
}

export type OrderWithReward = Order & { unitReward: number | null; reward: number | null };

export type OrderQuery = {
  /** "2026-08" 形式。未指定なら全期間。 */
  month?: string;
  /**
   * 月の判定に使う日付。
   *   order     … 受注日（顧客一覧・ダッシュボード）
   *   delivered … 配達完了日（売上・報酬・支払通知書）
   *
   * 売上・報酬を配達完了で切るのは 2026-08-26 の決定。
   * それまでは出荷完了日で切っていたため、顧客一覧と件数が合わなかった。
   */
  basis?: "order" | "delivered";
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
): Promise<{ orders: OrderWithReward[]; raw: Row[] }> {
  // 自分に関係する受注だけをデータベース側で絞る。
  const wanted = codes.map((c) => c.trim()).filter(Boolean);
  if (wanted.length === 0) return { orders: [], raw: [] };
  const list = inList(wanted);

  /*
   * staff_code も見る。
   *
   * スタッフ（コード区分02）が売ると、売上の付け先は所属先の会社になり
   * （src/lib/intake.ts の resolveAttribution）、agency_code には会社のコードが入る。
   * そのため agency_code / niji_code / referrer_code だけを見ていると、
   * スタッフ本人がログインしても自分の受注が1件も出てこない。
   * ダッシュボードは「今月の受注 0件」、売上画面は「ご自身が売った件数と売上金額です」と
   * 書いてあるのに永久に0のまま、という状態になっていた。
   */
  const filters = [
    `or=(agency_code.in.${list},niji_code.in.${list},referrer_code.in.${list},staff_code.in.${list})`,
    "order=ordered_on.desc",
  ];
  if (opts.month) {
    const { from, to } = monthRange(opts.month);
    const col = opts.basis === "delivered" ? "delivered_on" : "ordered_on";
    filters.push(`${col}=gte.${from}`, `${col}=lte.${to}`);
  }
  const [rows, products] = await Promise.all([
    select<Row>(`orders?select=*&${filters.join("&")}`),
    select<Row>(`products?select=${PRODUCT_COLUMNS}`),
  ]);

  /*
   * 商品名から単価を引く。引き当ては ./product-match に集約してある。
   * 報酬の計上（./rewards）と同じ関数を通さないと、
   * 実際に計上された額と、この画面に出る額がずれる。
   */
  const matchProduct = buildProductMatcher(products);

  const matched = rows.map((r) => {
    const p = matchProduct(
      s_(r, "product_name"),
      n_(r, "amount"),
      n_(r, "quantity") || 1,
    )?.row;
    const off = !p || s_(p, "reward_target") === "対象外";
    return {
      ...r,
      _unit_so: off ? null : p!["amount_so"] ?? null,
      _unit_niji: off ? null : p!["amount_niji"] ?? null,
      _unit_hanbai: off ? null : p!["amount_hanbai"] ?? null,
      _unit_toritsugi: off ? null : p!["amount_toritsugi"] ?? null,
    } as Row;
  });

  return { orders: matched.map(toOrder) as OrderWithReward[], raw: matched };
}

/** 受注一覧に、指定ランクでの報酬額を付ける。 */
export function attachRewards(
  raw: Row[],
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
 * 代理店ランクの選択肢は「総販売代理店 / 2次代理店 / 取次店」の3つで、
 * 3次にあたる「販売代理店」が入っていない。そこで3次は
 * 「ランク＝取次店 ＋ 販路種別＝販売代理店」の組み合わせで表している。
 *
 * ★ 販路種別を見るのは、ランクが「取次店」のときだけ。
 *   エリア統括代理店は「ランク＝2次代理店 ＋ 販路種別＝販売代理店」で登録される
 *   （make-blueprints/scenario-13-v3-FINAL3.json のエリア統括ルート）。
 *   販路種別だけを見て上書きすると、統括代理店まで3次の単価になり、
 *   1台あたり 62,700 円のところが 55,000 円と、7,700 円少なく計上される。
 *   実データでも RIM0002・RIM0004 がこの組み合わせで、少ない額が出ていた。
 *
 * 画面ごとに判定がぶれると同じ代理店に違う金額が出るため、必ずここを通す。
 */
export function effectiveRank(agency: Agency): string {
  if (agency.rank === "取次店" && agency.channel === "販売代理店") {
    return "販売代理店";
  }
  return agency.rank;
}

/** そのランクで1台あたりの報酬額を出せるかどうか。受注が0件でも判定できる。 */
export function canComputeReward(agency: Agency): boolean {
  // 商品マスタに4ランクぶんの単価があるので、どのランクでも計算できる。
  return ["総販売代理店", "2次代理店", "取次店", "販売代理店"].includes(effectiveRank(agency));
}
