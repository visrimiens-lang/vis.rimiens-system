import "server-only";
import { audit, insert, select, selectOne, update } from "./db";

/**
 * 報酬の計上。
 *
 * これまで Make のシナリオ#11 がやっていたことを、ここに持ってきた。
 *
 * 考え方（2026-07-09 回答書・2026-08-07 会議）:
 *   ・1件の受注から、階層ごとに複数の報酬が同時に発生する
 *     （例：2次代理店の報酬と、紹介した取次店の報酬）
 *   ・単価は商品マスタに入っている。ランクごとに額が違う
 *   ・報酬が確定するのは「配送完了」のとき
 *   ・キャンセルになったら、同額のマイナスを立てて相殺する（赤伝票）
 */

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const n_ = (r: Row | null, k: string): number => {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

/** 対象月を 'YYYY-MM' で返す。 */
function monthOf(date: string): string {
  return (date || new Date().toISOString().slice(0, 10)).slice(0, 7);
}

/** ランクに応じた単価の列名。 */
function amountColumn(rank: string): string | null {
  if (rank === "総販売代理店") return "amount_so";
  if (rank === "2次代理店") return "amount_niji";
  if (rank === "取次店") return "amount_toritsugi";
  if (rank === "販売代理店") return "amount_hanbai";
  return null;
}

/**
 * 受注1件から発生する報酬を計上する。
 *
 * 受注に記録されている「売った代理店」「2次代理店」「ゼロ次代理店」「紹介した取次店」
 * それぞれに、そのランクの単価で1行ずつ立てる。
 * 同じ受注で二度計上しないよう、既にある行は作り直さない。
 */
export async function accrueRewards(orderId: string | number): Promise<number> {
  const order = await selectOne<Row>(`orders?select=*&id=eq.${encodeURIComponent(String(orderId))}`);
  if (!order) return 0;

  // すでに計上済みなら何もしない
  const existing = await select<Row>(
    `rewards?select=id&order_id=eq.${encodeURIComponent(String(orderId))}`,
  );
  if (existing.length > 0) return 0;

  const product = await selectOne<Row>(
    `products?select=*&name=eq.${encodeURIComponent(s_(order, "product_name"))}`,
  );
  if (!product || s_(product, "reward_target") === "対象外") return 0;

  const month = monthOf(s_(order, "ordered_on"));
  const quantity = n_(order, "quantity") || 1;

  // 受け取る可能性のある相手。同じコードが重複しないようにする。
  const codes = [
    s_(order, "agency_code"),
    s_(order, "niji_code"),
    s_(order, "zeroth_code"),
    s_(order, "referrer_code"),
  ].filter(Boolean);
  const unique = [...new Set(codes)];
  if (unique.length === 0) return 0;

  const agencies = await select<Row>(
    `agencies?select=code,rank,channel&code=in.(${unique.map((c) => `"${c}"`).join(",")})`,
  );

  const rows: Record<string, unknown>[] = [];
  for (const a of agencies) {
    // 販路種別が販売代理店なら、その単価を使う（ランクは取次店のままのことがあるため）
    const rank = s_(a, "channel") === "販売代理店" ? "販売代理店" : s_(a, "rank");
    const col = amountColumn(rank);
    if (!col) continue;
    const unit = n_(product, col);
    if (unit <= 0) continue;

    rows.push({
      order_id: order["id"],
      agency_code: s_(a, "code"),
      agency_rank: rank,
      month,
      amount: unit * quantity,
      kind: s_(a, "code") === s_(order, "referrer_code") ? "紹介報酬" : "販売報酬",
      status: "未確定",
    });
  }

  if (rows.length === 0) return 0;
  await insert("rewards", rows);
  await audit("system", "報酬計上", { type: "order", key: String(orderId) }, {
    件数: rows.length,
    合計: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
  });
  return rows.length;
}

/**
 * 配送完了で報酬を確定させる。
 * 2026-08-07 会議「報酬確定を配送完了ベースにする」。
 */
export async function confirmRewards(orderId: string | number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await update<Row>(
    `rewards?order_id=eq.${encodeURIComponent(String(orderId))}&status=eq.${encodeURIComponent("未確定")}`,
    { status: "確定", confirmed_on: today },
  );
  if (rows.length > 0) {
    await audit("system", "報酬確定", { type: "order", key: String(orderId) }, {
      件数: rows.length,
    });
  }
  return rows.length;
}

/**
 * キャンセルになったときに、計上済みの報酬を相殺する。
 *
 * すでに支払った分を消すと帳簿が合わなくなるため、
 * 元の行は残したまま、同額のマイナスを立てる（赤伝票）。
 */
export async function reverseRewards(
  orderId: string | number,
  reason: string,
): Promise<number> {
  const rows = await select<Row>(
    `rewards?select=*&order_id=eq.${encodeURIComponent(String(orderId))}&amount=gt.0`,
  );
  if (rows.length === 0) return 0;

  const month = new Date().toISOString().slice(0, 7);
  const negatives = rows.map((r) => ({
    order_id: r["order_id"],
    agency_code: s_(r, "agency_code"),
    agency_rank: s_(r, "agency_rank"),
    month,                       // 取消は当月に立てる（翌月の支払から差し引く）
    amount: -n_(r, "amount"),
    kind: "取消",
    status: "確定",
    confirmed_on: new Date().toISOString().slice(0, 10),
    cancel_reason: reason,
  }));
  await insert("rewards", negatives);

  // 元の行にも取消の印をつける
  await update(
    `rewards?order_id=eq.${encodeURIComponent(String(orderId))}&amount=gt.0`,
    { status: "取消", cancel_reason: reason },
  );

  await audit("system", "報酬の取消", { type: "order", key: String(orderId) }, {
    件数: negatives.length,
    理由: reason,
  });
  return negatives.length;
}

/**
 * 受注の出荷状況が変わったときに呼ぶ。
 * 配送完了なら確定、キャンセルなら取消。
 */
export async function onShipStatusChanged(
  orderId: string | number,
  status: string,
): Promise<void> {
  if (status === "出荷済") {
    await confirmRewards(orderId);
  } else if (status === "キャンセル") {
    await reverseRewards(orderId, "受注のキャンセル");
  }
}

export type MonthlyReward = {
  agencyCode: string;
  month: string;
  confirmed: number;
  pending: number;
  total: number;
};

/** 代理店ごと・月ごとの報酬をまとめる（支払通知の作成用）。 */
export async function monthlyRewards(
  codes: string[],
  month?: string,
): Promise<MonthlyReward[]> {
  const list = codes.filter(Boolean);
  if (list.length === 0) return [];
  const filters = [`agency_code=in.(${list.map((c) => `"${c}"`).join(",")})`];
  if (month) filters.push(`month=eq.${month}`);
  const rows = await select<Row>(`rewards?select=*&${filters.join("&")}`);

  const map = new Map<string, MonthlyReward>();
  for (const r of rows) {
    const key = `${s_(r, "agency_code")}|${s_(r, "month")}`;
    const cur =
      map.get(key) ??
      { agencyCode: s_(r, "agency_code"), month: s_(r, "month"), confirmed: 0, pending: 0, total: 0 };
    const amt = n_(r, "amount");
    const st = s_(r, "status");
    if (st === "確定" || st === "支払済") cur.confirmed += amt;
    else if (st === "未確定") cur.pending += amt;
    if (st !== "取消") cur.total += amt;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}
