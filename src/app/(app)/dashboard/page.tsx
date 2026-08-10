import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { currentViewer } from "@/lib/auth";
import {
  findAgencyByCode,
  getSlotSummary,
  listDescendants,
  type SlotSummary,
  listDirectChildren,
  slotLimitsOf,
} from "@/lib/agencies";
import {
  areaUsage,
  breakdownSlots,
  slotModelOf,
  type SlotBreakdown as SlotBreakdownData,
} from "@/lib/slots";
import { listAllAgencies } from "@/lib/agencies";
import { SlotBreakdown } from "@/components/SlotBreakdown";
import {
  attachRewards,
  canComputeReward,
  currentMonth,
  effectiveRank,
  listOrders,
  scopeCodes,
  summarize,
  type MonthlySummary,
  type OrderWithReward,
} from "@/lib/orders";
import type { Agency } from "@/lib/types";
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
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import { SlotGrid } from "./SlotGrid";

type Loaded = {
  self: Agency;
  summary: MonthlySummary;
  slot: SlotSummary;
  breakdown: SlotBreakdownData;
  recent: OrderWithReward[];
};

async function load(code: string, month: string): Promise<Loaded | null> {
  const self = await findAgencyByCode(code);
  if (!self) return null;

  const [descendants, slot, direct] = await Promise.all([
    listDescendants(code),
    getSlotSummary(self),
    listDirectChildren(code),
  ]);
  // 総販売代理店の配下は統括代理店なので、100枠ではなく全国60社のエリア枠で見る。
  let breakdown = breakdownSlots(self, direct, slotLimitsOf(self));
  if (slotModelOf(self) === "area") {
    const usage = areaUsage(await listAllAgencies());
    breakdown = {
      lines: usage.rows.map((r) => ({
        key: r.area as never,
        label: r.area,
        note: "統括代理店の枠",
        limit: r.limit,
        used: r.used,
        remaining: r.remaining,
        isFull: r.isFull,
        members: r.members,
      })),
      totalLimit: usage.total.limit,
      totalUsed: usage.total.used,
      anyFull: usage.rows.some((r) => r.isFull),
      unclassified: [],
      staff: [],
    };
  }
  const codes = scopeCodes(self, descendants);

  // 今月ぶん（数字の集計用）と、期間を絞らないぶん（直近の受注一覧用）。
  const [thisMonth, allTime] = await Promise.all([
    listOrders(codes, { month }),
    listOrders(codes),
  ]);

  const orders = attachRewards(thisMonth.raw, effectiveRank(self));
  return {
    breakdown,
    self,
    summary: summarize(orders, month),
    slot,
    recent: attachRewards(allTime.raw, effectiveRank(self)).slice(0, 5),
  };
}

export default async function DashboardPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const month = currentMonth();

  let data: Loaded | null = null;
  let loadError: string | null = null;
  try {
    data = await load(viewer.code, month);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "原因不明のエラーが発生しました。";
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="ダッシュボード" description={`${jpMonthLabel(month)}の状況`} />
        <Notice tone="bad">
          データの取得に失敗しました。{loadError}
          <br />
          しばらく待ってから画面を再読み込みしてください。続く場合は本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <PageHeader title="ダッシュボード" description={`${jpMonthLabel(month)}の状況`} />
        <Notice tone="bad">
          代理店コード「{viewer.code}」の登録情報が見つかりませんでした。
          本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  const { self, summary, slot, breakdown, recent } = data;

  // 自分のランクに対応する単価が App10 にあるかどうか。
  // 「販売代理店」ぶんのフィールドは未整備のため null が返る。
  const rewardAvailable = canComputeReward(self);
  const rankMissing = effectiveRank(self) === "";
  const rewardTotal = rewardAvailable ? summary.rewardTotal : null;
  const rankLabel = self.rank || self.channel || "ランク未設定";

  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        description={`${self.name}（${self.code}）／ ${jpMonthLabel(month)}の状況です。自分ぶんと配下ぶんを合わせて集計しています。`}
        actions={<Badge tone="gold">{rankLabel}</Badge>}
      />

      {/* 1. 今月の要約 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="今月の受注"
          value={String(summary.orderCount)}
          unit="件"
          hint={`${summary.unitCount}台 ／ 出荷済 ${summary.shippedCount}件`}
        />
        <StatTile
          label="今月の売上"
          value={yen(summary.salesTotal)}
          hint="ご自身と配下の販売金額の合計"
        />
        <StatTile
          label="今月の報酬見込み"
          value={rewardTotal === null ? "—" : yen(rewardTotal)}
          tone="gold"
          hint={
            rewardAvailable
              ? `${rankLabel}としての単価 × 台数。確定額は本部の締め後に確定します。`
              : "単価が未設定のため計算できません"
          }
        />
        <StatTile
          label="枠の空き"
          value={String(breakdown.totalLimit - breakdown.totalUsed)}
          unit="社"
          tone={breakdown.anyFull ? "warn" : "default"}
          hint={`全${breakdown.totalLimit}枠中${breakdown.totalUsed}枠が登録済み`}
        />
      </div>

      {!rewardAvailable ? (
        <Notice tone="warn">
          {rankMissing
            ? "代理店ランクが登録されていないため、報酬額を計算できません。本部にご確認ください。"
            : "販売代理店ぶんの単価がマスタ未設定のため金額を表示できません。本部にお問い合わせください。"}
        </Notice>
      ) : null}

      {/* 2. 枠の状況 */}
      <Card
        title={slotModelOf(self) === "area" ? "エリア枠（統括代理店）" : "配下の枠"}
        action={
          <Link
            href="/organization"
            className="text-xs text-ink-300 transition hover:text-gold-300"
          >
            組織を見る →
          </Link>
        }
      >
        <SlotBreakdown data={breakdown} />

        <div className="space-y-3 border-t border-ink-800 px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-300">
            <span>
              {breakdown.anyFull
                ? "埋まっている枠があります。"
                : `全部で ${breakdown.totalLimit} 枠のうち ${breakdown.totalUsed} 枠を使っています。`}
            </span>
            {slot.requestStatus && slot.requestStatus !== "なし" ? (
              <Badge tone={slot.requestStatus === "申請中" ? "warn" : "neutral"}>
                増枠申請：{slot.requestStatus}
              </Badge>
            ) : null}
          </div>

          {breakdown.anyFull ? (
            slot.requestStatus === "申請中" ? (
              <Notice tone="info">
                増枠を申請中です。本部の承認をお待ちください。
              </Notice>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/organization"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3.5 py-2 text-sm font-medium text-gold-300 transition hover:bg-gold-500/20"
                >
                  増枠を申請する
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <span className="text-xs text-ink-400">
                  新しく登録するには、先に本部の承認が必要です。
                </span>
              </div>
            )
          ) : null}
        </div>

      </Card>

      {/* 3. 直近の受注 */}
      <Card
        title="直近の受注"
        action={
          <Link
            href="/customers"
            className="text-xs text-ink-300 transition hover:text-gold-300"
          >
            すべて見る →
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyState
            title="まだ受注がありません"
            description="QR2 の決済が完了すると、ここに自動で表示されます。ご自身の受注と、配下の代理店・取次店の受注がまとめて並びます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>日付</Th>
                <Th>顧客名</Th>
                <Th>担当コード</Th>
                <Th align="right">金額</Th>
                <Th>出荷状況</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.recordId}>
                  <Td numeric>{jpDate(o.date)}</Td>
                  <Td>{o.customerName || "—"}</Td>
                  <Td numeric className="text-ink-300">
                    {o.ownerCode || "—"}
                  </Td>
                  <Td numeric align="right">
                    {yen(o.amount)}
                  </Td>
                  <Td>
                    <StatusBadge status={o.shippingStatus} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
