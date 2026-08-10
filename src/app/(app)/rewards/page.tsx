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
  // スタッフ（コード区分 02）には報酬の金額を出さない。
  // 2026-04-23 の打ち合わせで「金額が見えるのは親アカウントだけ」と決まっている。
  let isStaff = false;

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
      isStaff = self.codeKind === "02";

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

  // 金額を出してよいのは親アカウントだけ。スタッフには件数と売上だけ見せる。
  const showReward = !isStaff;

  const units = sumUnits(rows);
  const salesTotal = rows.reduce((s, r) => s + r.amount, 0);
  const rewardTotal = showReward && rewardAvailable ? sumReward(rows) : null;
  const hasMissingUnit =
    showReward && (!rewardAvailable || rows.some((r) => r.unitReward === null));
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
          description="出荷が完了した受注だけを集計しています。"
        />
        <Notice tone="bad">売上・報酬を読み込めませんでした。{errorMessage}</Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={showReward ? "売上・報酬" : "売上"}
        description={
          showReward
            ? `出荷が完了した受注だけを集計しています。${jpMonthLabel(month)}に出荷が完了したぶんが対象です。`
            : `ご自身が売った件数と売上金額です。${jpMonthLabel(month)}に出荷が完了したぶんが対象です。`
        }
        actions={<MonthSelect months={monthOptions} value={month} />}
      />

      <Notice tone="info">
        出荷が完了した受注だけを集計しています。出荷完了日が{jpMonthLabel(month)}
        の受注が対象で、まだ出荷していない受注はここには出ません。
        お客様のお手元に届く「配達完了」より前の段階で対象になるため、
        顧客一覧の進み具合とは表示がずれることがあります。
        {showReward && rankLabel
          ? `報酬額は「${rankLabel}」としての単価で計算しています。`
          : null}
      </Notice>

      {showReward ? null : (
        <Notice tone="info">
          報酬の金額は所属先の代理店にお問い合わせください。
          この画面では、ご自身が売った件数と売上金額のみ表示しています。
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="出荷完了台数"
          value={units.toLocaleString("ja-JP")}
          unit="台"
          hint={`受注 ${rows.length.toLocaleString("ja-JP")} 件ぶん`}
        />
        <StatTile label="売上合計" value={yen(salesTotal)} hint="出荷完了ぶんの販売金額" />
        {showReward ? (
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
        ) : (
          <StatTile
            label="受注件数"
            value={rows.length.toLocaleString("ja-JP")}
            unit="件"
            hint="出荷が完了した受注の件数"
          />
        )}
      </div>

      {hasMissingUnit ? (
        <Notice tone="warn">
          {rankMissing
            ? "代理店ランクが登録されていないため、報酬額を計算できません。本部にご確認ください。"
            : "販売代理店ぶんの1台あたり単価が商品マスタに未設定のため、金額を表示できません。本部にお問い合わせください。"}
        </Notice>
      ) : null}

      <Card title={`出荷完了の明細（${jpMonthLabel(month)}）`}>
        {rows.length === 0 ? (
          <EmptyState
            title="この月はまだ出荷が完了した受注がありません"
            description="報酬は商品の出荷が完了した時点で確定します。出荷前の受注は顧客一覧でご確認いただけます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>出荷完了日</Th>
                <Th>顧客名</Th>
                <Th>商品名</Th>
                <Th align="right">台数</Th>
                <Th align="right">販売金額</Th>
                {showReward ? <Th align="right">単価</Th> : null}
                {showReward ? <Th align="right">報酬額</Th> : null}
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
                    {yen(r.amount)}
                  </Td>
                  {showReward ? (
                    <Td numeric align="right">
                      {yen(r.unitReward)}
                    </Td>
                  ) : null}
                  {showReward ? (
                    <Td numeric align="right" className="text-ink-50">
                      {yen(r.reward)}
                    </Td>
                  ) : null}
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
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {yen(salesTotal)}
                </Td>
                {showReward ? <Td>{null}</Td> : null}
                {showReward ? (
                  <Td numeric align="right" className="font-semibold text-gold-400">
                    {yen(rewardTotal)}
                  </Td>
                ) : null}
                <Td>{null}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {rows.length > 0 ? (
        <Card
          title={
            showReward ? "担当ごとの内訳（支払通知の作成用）" : "担当ごとの内訳（台数）"
          }
        >
          <Table>
            <thead>
              <tr>
                <Th>代理店コード</Th>
                <Th>名前</Th>
                <Th align="right">台数</Th>
                {showReward ? <Th align="right">報酬額</Th> : null}
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
                  {showReward ? (
                    <Td numeric align="right" className="text-ink-50">
                      {yen(g.reward)}
                    </Td>
                  ) : null}
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
                {showReward ? (
                  <Td numeric align="right" className="font-semibold text-gold-400">
                    {yen(rewardTotal)}
                  </Td>
                ) : null}
              </tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
