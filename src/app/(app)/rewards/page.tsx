import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import {
  attachRewards,
  canComputeReward,
  currentMonth,
  effectiveRank,
  listOrders,
  recentMonths,
  scopeCodes,
  type OrderWithReward,
} from "@/lib/orders";
import type { Agency } from "@/lib/types";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import { MonthSelect } from "./MonthSelect";

/** 報酬の合計。1件でも算出できないものがあれば null（0円と書かないため）。 */
function sumReward(rows: OrderWithReward[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (r.reward === null) return null;
    total += r.reward;
  }
  return total;
}

function sumUnits(rows: OrderWithReward[]): number {
  return rows.reduce((s, r) => s + (r.quantity || 1), 0);
}

type OwnerGroup = {
  code: string;
  name: string;
  units: number;
  reward: number | null;
};

function groupByOwner(rows: OrderWithReward[], names: Map<string, string>): OwnerGroup[] {
  const buckets = new Map<string, OrderWithReward[]>();
  for (const r of rows) {
    const key = r.ownerCode || "（担当コードなし）";
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([code, list]) => ({
      code,
      name: names.get(code) ?? "—",
      units: sumUnits(list),
      reward: sumReward(list),
    }))
    .sort((a, b) => b.units - a.units || a.code.localeCompare(b.code));
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const { month: monthParam } = await searchParams;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam ?? "")
    ? monthParam!
    : currentMonth();
  const months = recentMonths(12);
  const monthOptions = months.includes(month) ? months : [month, ...months];

  let rows: OrderWithReward[] = [];
  let names = new Map<string, string>();
  let rankLabel = "";
  let rewardAvailable = true;
  let rankMissing = false;
  let errorMessage: string | null = null;

  try {
    const self = await findAgencyByCode(viewer.code);
    if (!self) {
      errorMessage = `代理店コード ${viewer.code} の登録が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      const descendants = await listDescendants(self.code);
      names = new Map([self, ...descendants].map((a) => [a.code, a.name]));
      rankLabel = effectiveRank(self);
      rewardAvailable = canComputeReward(self);
      rankMissing = rankLabel === "";

      const { raw } = await listOrders(scopeCodes(self, descendants), {
        month,
        basis: "shipped",
      });
      rows = attachRewards(raw, rankLabel).sort((a, b) =>
        (b.shippedAt || "").localeCompare(a.shippedAt || ""),
      );
    }
  } catch (e) {
    errorMessage =
      e instanceof Error
        ? e.message
        : "kintone からの読み込みに失敗しました。時間をおいて開き直してください。";
  }

  const units = sumUnits(rows);
  const salesTotal = rows.reduce((s, r) => s + r.amount, 0);
  const rewardTotal = rewardAvailable ? sumReward(rows) : null;
  const hasMissingUnit = !rewardAvailable || rows.some((r) => r.unitReward === null);
  const groups = groupByOwner(rows, names);

  // 「150台 × 62,700円」の形で見せられるのは、単価が1種類に揃っているときだけ。
  const distinctUnits = [...new Set(rows.map((r) => r.unitReward))];
  const singleUnitPrice =
    rows.length > 0 && distinctUnits.length === 1 && distinctUnits[0] !== null
      ? distinctUnits[0]
      : null;

  if (errorMessage) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="売上・報酬"
          description="配送が完了した受注だけを集計しています。"
        />
        <Notice tone="bad">売上・報酬を読み込めませんでした。{errorMessage}</Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="売上・報酬"
        description={`配送が完了した受注だけを集計しています。${jpMonthLabel(month)}に配送が完了したぶんが対象です。`}
        actions={<MonthSelect months={monthOptions} value={month} />}
      />

      <Notice tone="info">
        配送が完了した受注だけを集計しています。出荷完了日が{jpMonthLabel(month)}
        の受注が対象で、まだ出荷していない受注はここには出ません。
        {rankLabel ? `報酬額は「${rankLabel}」としての単価で計算しています。` : null}
      </Notice>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="配送完了台数"
          value={units.toLocaleString("ja-JP")}
          unit="台"
          hint={`受注 ${rows.length.toLocaleString("ja-JP")} 件ぶん`}
        />
        <StatTile label="売上合計" value={yen(salesTotal)} hint="配送完了ぶんの販売金額" />
        <StatTile
          label="報酬合計"
          value={yen(rewardTotal)}
          tone="gold"
          hint={
            singleUnitPrice !== null
              ? `${units.toLocaleString("ja-JP")}台 × ${yen(singleUnitPrice)}`
              : rewardTotal === null
                ? "一部の単価が未設定のため算出できません"
                : "この金額が振込対象です"
          }
        />
      </div>

      {hasMissingUnit ? (
        <Notice tone="warn">
          {rankMissing
            ? "代理店ランクが登録されていないため、報酬額を計算できません。本部にご確認ください。"
            : "販売代理店ぶんの1台あたり単価が商品マスタに未設定のため、金額を表示できません。本部にお問い合わせください。"}
        </Notice>
      ) : null}

      <Card title={`配送完了の明細（${jpMonthLabel(month)}）`}>
        {rows.length === 0 ? (
          <EmptyState
            title="今月はまだ配送が完了した受注がありません"
            description="報酬は商品の配送が完了した時点で確定します。出荷前の受注は顧客一覧でご確認いただけます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>配送完了日</Th>
                <Th>顧客名</Th>
                <Th>商品名</Th>
                <Th align="right">台数</Th>
                <Th align="right">単価</Th>
                <Th align="right">報酬額</Th>
                <Th>担当コード</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recordId}>
                  <Td numeric>{jpDate(r.shippedAt)}</Td>
                  <Td>{r.customerName || "—"}</Td>
                  <Td>{r.productName || "—"}</Td>
                  <Td numeric align="right">
                    {(r.quantity || 1).toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right">
                    {yen(r.unitReward)}
                  </Td>
                  <Td numeric align="right" className="text-ink-50">
                    {yen(r.reward)}
                  </Td>
                  <Td numeric>{r.ownerCode || "—"}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {units.toLocaleString("ja-JP")}
                </Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-gold-400">
                  {yen(rewardTotal)}
                </Td>
                <Td>{null}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {rows.length > 0 ? (
        <Card title="担当ごとの内訳（支払通知の作成用）">
          <Table>
            <thead>
              <tr>
                <Th>代理店コード</Th>
                <Th>名前</Th>
                <Th align="right">台数</Th>
                <Th align="right">報酬額</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.code}>
                  <Td numeric>{g.code}</Td>
                  <Td>{g.name}</Td>
                  <Td numeric align="right">
                    {g.units.toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right" className="text-ink-50">
                    {yen(g.reward)}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {units.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-400">
                  {yen(rewardTotal)}
                </Td>
              </tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
