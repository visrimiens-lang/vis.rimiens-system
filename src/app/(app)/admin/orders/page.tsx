import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAllAgencies } from "@/lib/agencies";
import { select } from "@/lib/db";
import { currentMonth, recentMonths, unitRewardFor } from "@/lib/orders";
import type { Agency, Order } from "@/lib/types";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  cn,
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import { OrderFilters, type CodeOption, type ShipOption } from "./OrderFilters";

export const metadata = { title: "受注一覧（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 本部は全代理店の受注を見る必要がある。
 * src/lib/orders.ts の listOrders は「渡したコードに一致するものだけ」を返すため、
 * 代理店マスタに載っていないコードの受注（＝紹介元が特定できていない受注）が
 * 落ちてしまう。本部にとってはそれこそ真っ先に見つけたい受注なので、
 * この画面だけは絞り込みなしで取得する。lib 側は変更しない。
 * ------------------------------------------------------------------ */

/** App10「出荷状況」の選択肢。受注が1件も無い状態でも絞り込めるように持っておく。 */
const SHIPPING_STATUSES = ["出荷待ち", "出荷手配中", "出荷済", "キャンセル"];

const PAGE_SIZE = 500;
const MAX_PAGES = 5;

type AdminOrder = Order & {
  /** ゼロ次代理店コード（集計用） */
  zeroCode: string;
  /** 2次代理店に支払う1台あたりの金額。受注に入っていなければ null。 */
  secondaryUnit: number | null;
  /** 上記 × 台数。算出できなければ null。 */
  secondaryTotal: number | null;
};

type Row = Record<string, unknown>;
const str = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const num = (r: Row, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

function toAdminOrder(r: Row): AdminOrder {
  const referrer = str(r, "referrer_code");
  const agencyCode = str(r, "agency_code");
  const quantity = num(r, "quantity") || 1;
  // 空欄と 0 円は意味が違う。空欄なら「まだ決まっていない」ので金額を出さない。
  const unit = unitRewardFor(r, "2次代理店");
  return {
    recordId: str(r, "id"),
    date: str(r, "ordered_on"),
    customerName: str(r, "customer_name"),
    productName: str(r, "product_name"),
    amount: num(r, "amount"),
    quantity,
    phone: str(r, "phone"),
    shippingStatus: str(r, "ship_status"),
    shippedAt: str(r, "shipped_on"),
    paymentMethod: str(r, "payment_method"),
    matchStatus: str(r, "match_status"),
    agencyCode,
    secondaryCode: str(r, "niji_code"),
    referrerCode: referrer,
    trackingNo: str(r, "tracking_no"),
    ownerCode: referrer || agencyCode,
    zeroCode: str(r, "zeroth_code"),
    secondaryUnit: unit,
    secondaryTotal: unit === null ? null : unit * quantity,
  };
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

/** 全代理店ぶんの受注を取得する。month が null なら全期間。 */
async function fetchAllOrders(
  month: string | null,
): Promise<{ rows: AdminOrder[]; truncated: boolean }> {
  const filters = ["order=ordered_on.desc,id.desc"];
  if (month) {
    const { from, to } = monthRange(month);
    filters.push(`ordered_on=gte.${from}`, `ordered_on=lte.${to}`);
  }
  const [rows, products] = await Promise.all([
    select<Row>(`orders?select=*&${filters.join("&")}`),
    select<Row>("products?select=name,amount_so,amount_niji,amount_hanbai,amount_toritsugi,reward_target"),
  ]);
  const priceOf = new Map<string, Row>();
  for (const p of products) priceOf.set(str(p, "name"), p);

  const enriched = rows.map((r) => {
    const p = priceOf.get(str(r, "product_name"));
    const off = !p || str(p, "reward_target") === "対象外";
    return {
      ...r,
      _unit_so: off ? null : p!["amount_so"] ?? null,
      _unit_niji: off ? null : p!["amount_niji"] ?? null,
      _unit_hanbai: off ? null : p!["amount_hanbai"] ?? null,
      _unit_toritsugi: off ? null : p!["amount_toritsugi"] ?? null,
    } as Row;
  });
  return { rows: enriched.map(toAdminOrder), truncated: false };
}

/** 受注に記録されている代理店コードすべて（重複を除く）。 */
function codesOf(o: AdminOrder): string[] {
  return [...new Set([o.agencyCode, o.secondaryCode, o.referrerCode, o.zeroCode])].filter(
    Boolean,
  );
}

/**
 * 集計・振込確認のまとめ先。
 * 受注には集計用の「2次代理店コード」が入るので、まずそれを使う。
 * 入っていない受注は、受注に記録された代理店コードでまとめる。
 */
function payeeCodeOf(o: AdminOrder): string {
  return o.secondaryCode || o.agencyCode || "";
}

type AgencyTotals = {
  code: string;
  name: string;
  orderCount: number;
  units: number;
  sales: number;
  payable: number | null;
};

function sumPayable(rows: AdminOrder[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (r.secondaryTotal === null) return null;
    total += r.secondaryTotal;
  }
  return total;
}

function groupByPayee(rows: AdminOrder[], names: Map<string, string>): AgencyTotals[] {
  const buckets = new Map<string, AdminOrder[]>();
  for (const r of rows) {
    const key = payeeCodeOf(r);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([code, list]) => ({
      code,
      name: names.get(code) ?? "",
      orderCount: list.length,
      units: list.reduce((s, r) => s + (r.quantity || 1), 0),
      sales: list.reduce((s, r) => s + r.amount, 0),
      payable: sumPayable(list),
    }))
    .sort((a, b) => b.units - a.units || b.sales - a.sales || a.code.localeCompare(b.code));
}

/** "YYYY-MM" か "all" だけを受け付ける。それ以外は今月に落とす。 */
function normalizeMonth(raw: string | undefined, fallback: string): string {
  if (raw === "all") return "all";
  if (raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return fallback;
}

/** 全期間表示のときだけ年を添える。 */
function orderDate(v: string, withYear: boolean): string {
  if (!v) return "—";
  return withYear ? `${v.slice(0, 4)}/${jpDate(v)}` : jpDate(v);
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; code?: string; ship?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);
  const month = normalizeMonth(params.month, thisMonth);
  const monthOptions = month === "all" || months.includes(month) ? months : [month, ...months];
  const selectedCode = params.code?.trim() ? params.code.trim() : "all";
  const selectedShip = params.ship?.trim() ? params.ship.trim() : "all";
  const allPeriod = month === "all";
  const periodLabel = allPeriod ? "全期間" : jpMonthLabel(month);

  let periodOrders: AdminOrder[] = [];
  let agencies: Agency[] = [];
  let truncated = false;
  let error: string | null = null;

  try {
    const [orderResult, agencyList] = await Promise.all([
      fetchAllOrders(allPeriod ? null : month),
      listAllAgencies(),
    ]);
    periodOrders = orderResult.rows;
    truncated = orderResult.truncated;
    agencies = agencyList;
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "受注を読み込めませんでした。時間をおいて画面を開き直してください。";
  }

  const header = (
    <PageHeader
      title="受注一覧（全代理店）"
      description="全代理店の受注をまとめて確認できます。期間・代理店コード・出荷状況で絞り込めます。"
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          受注を読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  const nameByCode = new Map(agencies.map((a) => [a.code, a.name]));

  /* --- 絞り込みの選択肢は、期間で絞ったあとの受注から作る --- */
  const codeCounts = new Map<string, number>();
  const shipCounts = new Map<string, number>();
  for (const o of periodOrders) {
    for (const c of codesOf(o)) codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
    if (o.shippingStatus) {
      shipCounts.set(o.shippingStatus, (shipCounts.get(o.shippingStatus) ?? 0) + 1);
    }
  }

  // 受注が0件でも代理店を選べるように、代理店マスタの正規代理店（コード区分00）も並べる。
  const codeSet = new Set<string>(codeCounts.keys());
  for (const a of agencies) if (a.codeKind === "00" && a.code) codeSet.add(a.code);
  if (selectedCode !== "all") codeSet.add(selectedCode);

  const codeOptions: CodeOption[] = [...codeSet]
    .map((code) => ({
      code,
      name: nameByCode.get(code) ?? "",
      count: codeCounts.get(code) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const shipSet = new Set<string>(SHIPPING_STATUSES);
  for (const s of shipCounts.keys()) shipSet.add(s);
  if (selectedShip !== "all") shipSet.add(selectedShip);
  const shipOptions: ShipOption[] = [...shipSet].map((value) => ({
    value,
    count: shipCounts.get(value) ?? 0,
  }));

  /* --- 絞り込み --- */
  const rows = periodOrders.filter((o) => {
    if (selectedCode !== "all" && !codesOf(o).includes(selectedCode)) return false;
    if (selectedShip !== "all" && o.shippingStatus !== selectedShip) return false;
    return true;
  });

  const orderCount = rows.length;
  const unitTotal = rows.reduce((s, o) => s + (o.quantity || 1), 0);
  const salesTotal = rows.reduce((s, o) => s + o.amount, 0);
  const shippedCount = rows.filter((o) => o.shippingStatus === "出荷済").length;
  const payableTotal = sumPayable(rows);
  const needsCheck = rows.filter((o) => o.matchStatus === "要確認");
  const groups = groupByPayee(rows, nameByCode);
  const missingPayable = groups.some((g) => g.payable === null);
  const selectedName = selectedCode === "all" ? "" : (nameByCode.get(selectedCode) ?? "");

  const filterLabel = [
    periodLabel,
    selectedCode === "all" ? null : selectedCode,
    selectedShip === "all" ? null : selectedShip,
  ]
    .filter(Boolean)
    .join("・");

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <OrderFilters
          month={month}
          months={monthOptions}
          defaultMonth={thisMonth}
          code={selectedCode}
          codeOptions={codeOptions}
          ship={selectedShip}
          shipOptions={shipOptions}
          periodCount={periodOrders.length}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="受注件数"
          value={orderCount.toLocaleString("ja-JP")}
          unit="件"
          hint={filterLabel}
        />
        <StatTile
          label="台数"
          value={unitTotal.toLocaleString("ja-JP")}
          unit="台"
          hint="数量の合計"
        />
        <StatTile
          label="売上合計"
          value={yen(salesTotal)}
          tone="gold"
          hint="お客様のお支払額の合計"
        />
        <StatTile
          label="出荷済"
          value={shippedCount.toLocaleString("ja-JP")}
          unit="件"
          hint={
            orderCount > 0
              ? `未出荷 ${(orderCount - shippedCount).toLocaleString("ja-JP")} 件`
              : "出荷が終わった受注の数"
          }
        />
      </div>

      {truncated ? (
        <Notice tone="warn">
          件数が多いため、受注日の新しい順に 2,500 件までを表示しています。
          期間を月で絞り込むと、そのぶんはすべて表示されます。
        </Notice>
      ) : null}

      {needsCheck.length > 0 ? (
        <Notice tone="warn">
          紹介元が特定できていない受注が {needsCheck.length} 件あります（照合ステータスが「要確認」）。
          このぶんは報酬の支払先が決まっていないため、下の表では色を付けています。
          受注の紹介元をご確認のうえ、照合ステータスを更新してください。
        </Notice>
      ) : null}

      <Card
        title={`代理店ごとの集計（${filterLabel}）`}
        action={
          <span className="text-xs text-ink-400">
            台数の多い順・{groups.length.toLocaleString("ja-JP")} 社
          </span>
        }
      >
        {groups.length === 0 ? (
          <EmptyState
            title="集計できる受注がありません"
            description="受注が入ると、代理店ごとの台数・売上・支払対象額をここでまとめて確認できます。月次の振込確認はこの表をお使いください。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>代理店コード</Th>
                <Th>法人名</Th>
                <Th align="right">件数</Th>
                <Th align="right">台数</Th>
                <Th align="right">売上</Th>
                <Th align="right">支払対象額</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.code || "(未設定)"}>
                  <Td numeric className="whitespace-nowrap font-medium text-ink-100">
                    {g.code || <Badge tone="warn">コードなし</Badge>}
                  </Td>
                  <Td>
                    {g.name || (
                      <span className="text-ink-400">
                        {g.code ? "代理店マスタに該当なし" : "支払先が未確定です"}
                      </span>
                    )}
                  </Td>
                  <Td numeric align="right">
                    {g.orderCount.toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right" className="font-medium text-ink-50">
                    {g.units.toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right">
                    {yen(g.sales)}
                  </Td>
                  <Td numeric align="right" className="text-gold-300">
                    {yen(g.payable)}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">全体</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {orderCount.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {yen(salesTotal)}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-400">
                  {yen(payableTotal)}
                </Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {missingPayable ? (
        <Notice tone="warn">
          2次代理店ぶんの1台あたりの金額が入っていない受注があるため、支払対象額を出せない代理店があります。
          商品マスタの単価が受注に反映されているかご確認ください。金額が確かめられないところは「—」と表示しています。
        </Notice>
      ) : null}

      <Card
        title={`受注明細（${filterLabel}）`}
        action={
          <span className="text-xs text-ink-400">
            受注日の新しい順・{orderCount.toLocaleString("ja-JP")} 件
          </span>
        }
      >
        {orderCount === 0 ? (
          <EmptyState
            title={
              selectedCode === "all" && selectedShip === "all"
                ? "この期間の受注はまだありません"
                : "この条件に合う受注はありません"
            }
            description={
              selectedCode === "all" && selectedShip === "all"
                ? "お客様の決済が完了すると、受注がここに自動で表示されます。反映は数分以内です。期間を「全期間」に切り替えると、過去のぶんも確認できます。"
                : `${selectedCode === "all" ? "" : `代理店 ${selectedCode}${selectedName ? `（${selectedName}）` : ""}`}${
                    selectedShip === "all" ? "" : `${selectedCode === "all" ? "" : "・"}出荷状況「${selectedShip}」`
                  } に当てはまる受注は${periodLabel}にはありません。絞り込みを「すべて」に戻すと全代理店の受注を確認できます。`
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>受注日</Th>
                <Th>注文者名</Th>
                <Th>商品名</Th>
                <Th align="right">台数</Th>
                <Th align="right">金額</Th>
                <Th>代理店コード</Th>
                <Th>担当コード</Th>
                <Th>出荷状況</Th>
                <Th>照合ステータス</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const payee = payeeCodeOf(o);
                const attention = o.matchStatus === "要確認";
                return (
                  <tr key={o.recordId} className={cn(attention && "bg-warn-500/10")}>
                    <Td numeric className="whitespace-nowrap">
                      {orderDate(o.date, allPeriod)}
                    </Td>
                    <Td>{o.customerName || "—"}</Td>
                    <Td>{o.productName || "—"}</Td>
                    <Td numeric align="right">
                      {(o.quantity || 1).toLocaleString("ja-JP")}
                    </Td>
                    <Td numeric align="right">
                      {yen(o.amount)}
                    </Td>
                    <Td>
                      {payee ? (
                        <div className="min-w-0">
                          <div className="tabnum truncate font-medium text-ink-100">{payee}</div>
                          <div className="truncate text-xs text-ink-400">
                            {nameByCode.get(payee) ?? "代理店マスタに該当なし"}
                          </div>
                        </div>
                      ) : (
                        <Badge tone="warn">コードなし</Badge>
                      )}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {o.ownerCode || <span className="text-ink-400">—</span>}
                    </Td>
                    <Td>
                      <StatusBadge status={o.shippingStatus} />
                    </Td>
                    <Td>
                      <StatusBadge status={o.matchStatus} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td className="font-semibold text-ink-100">
                  {orderCount.toLocaleString("ja-JP")}件
                </Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-300">
                  {yen(salesTotal)}
                </Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        代理店コードは、受注に記録された集計用の2次代理店コードです。入っていない受注は、受注に記録された代理店コードでまとめています。
        担当コードは、取次の紹介コードがある受注ではそのコード、無い受注では代理店コードです。
        支払対象額は「2次代理店ぶんの1台あたりの金額 × 台数」で計算しています。
      </Notice>
    </div>
  );
}
