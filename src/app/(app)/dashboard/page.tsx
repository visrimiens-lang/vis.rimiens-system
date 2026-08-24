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
} from "@/lib/agencies";
import {
  areaUsage,
  breakdownSlots,
  slotModelOf,
  type SlotBreakdown as SlotBreakdownData,
} from "@/lib/slots";
import { listAllAgencies } from "@/lib/agencies";
import { select } from "@/lib/db";
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
  Table,
  Td,
  Th,
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import { Progress } from "@/components/Progress";
import { AutoRefresh } from "@/components/AutoRefresh";
import { rankLabel } from "@/lib/labels";

/**
 * 自動更新の間隔（秒）。
 * ダッシュボードは設計書どおり30秒。顧客一覧より頻度を落としてあるのは、
 * この画面が集計（今月の受注・売上・枠）中心で、1件ずつの動きを追う画面ではないため。
 */
const REFRESH_SECONDS = 30;

/** 直近の受注1件。進み具合を出すために審査結果と配達完了日も持たせる。 */
type RecentOrder = OrderWithReward & { reviewResult: string; deliveredOn: string };

type Row = Record<string, unknown>;

const text = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/**
 * 売上にも報酬の見込みにも数えない受注か。
 *
 * キャンセルされた受注と、信販の審査が通らなかった受注は入金にならない。
 * 数に入れたままだと、月末に本部から届く金額と画面の金額が食い違う。
 * 件数だけは別に出して、消えたことに気づけるようにする。
 */
function isStopped(r: Row): boolean {
  return text(r, "ship_status") === "キャンセル" || text(r, "review_result") === "否決";
}

type Loaded = {
  self: Agency;
  summary: MonthlySummary;
  /** 今月ぶんのうち、キャンセル・審査否決で集計から外した件数。 */
  stoppedCount: number;
  slot: SlotSummary;
  breakdown: SlotBreakdownData;
  /** 枠の単位。エリア枠は「社」、スタッフ枠は「名」。 */
  slotUnit: string;
  /** 枠のカードを出すか（配下を持てない相手には出さない）。 */
  showSlots: boolean;
  recent: RecentOrder[];
};

async function load(code: string, month: string): Promise<Loaded | null> {
  const self = await findAgencyByCode(code);
  if (!self) return null;

  const [descendants, slot, direct] = await Promise.all([
    listDescendants(code),
    getSlotSummary(self),
    listDirectChildren(code),
  ]);
  // 総販売代理店の配下は統括代理店なので、スタッフ枠ではなく全国60社のエリア枠で見る。
  let breakdown = breakdownSlots(self, direct);
  if (slotModelOf(self) === "area") {
    const usage = areaUsage(await listAllAgencies());
    breakdown = {
      limit: usage.total.limit,
      used: usage.total.used,
      remaining: Math.max(0, usage.total.limit - usage.total.used),
      isFull: usage.total.used >= usage.total.limit,
      members: usage.rows.flatMap((r) => r.members),
    };
  }
  /** 枠の単位。エリア枠は「社」、スタッフ枠は「名」。 */
  const slotUnit = slotModelOf(self) === "area" ? "社" : "名";
  /*
   * 取次パートナー・スタッフ・取次店ランクの3次代理店は配下を持てない。
   * 枠の話そのものが当てはまらないので、枠のカードも数字も出さない。
   */
  const showSlots = slotModelOf(self) !== "none";
  const codes = scopeCodes(self, descendants);

  // 今月ぶん（数字の集計用）と、期間を絞らないぶん（直近の受注一覧用）。
  const [thisMonth, allTime] = await Promise.all([
    listOrders(codes, { month }),
    listOrders(codes),
  ]);

  // 今月ぶんの集計は、キャンセルと審査否決を除いた受注だけで行う。
  const live = thisMonth.raw.filter((r) => !isStopped(r));
  const orders = attachRewards(live, effectiveRank(self));

  // 審査結果とお客様の紐づけは Order には入っていないので、
  // 元の行から拾って進み具合の判定に回す。
  const reviewById = new Map<string, string>();
  const customerIdByOrder = new Map<string, string>();
  for (const r of allTime.raw) {
    const id = text(r, "id");
    if (!id) continue;
    reviewById.set(id, text(r, "review_result"));
    const customerId = text(r, "customer_id");
    if (customerId) customerIdByOrder.set(id, customerId);
  }

  const latest = attachRewards(allTime.raw, effectiveRank(self)).slice(0, 5);

  // 配達が終わった日は顧客台帳のほうに入っている。
  // 顧客一覧と同じ進み具合になるよう、ここでも引いてくる。
  // 画面に出すのは5件だけなので、その5件ぶんだけ問い合わせる。
  const deliveredByCustomer = new Map<string, string>();
  const customerIds = [
    ...new Set(
      latest
        .map((o) => customerIdByOrder.get(o.recordId) ?? "")
        .filter((id) => /^\d+$/.test(id)),
    ),
  ];
  if (customerIds.length > 0) {
    try {
      const rows = await select<Row>(
        `customers?select=id,delivered_on&id=in.(${customerIds.join(",")})`,
      );
      for (const c of rows) {
        const day = text(c, "delivered_on");
        if (day) deliveredByCustomer.set(text(c, "id"), day);
      }
    } catch {
      // 配達完了日が読めなくても、出荷までの進み具合は表示できるので続ける
    }
  }

  return {
    breakdown,
    slotUnit,
    showSlots,
    self,
    summary: summarize(orders, month),
    stoppedCount: thisMonth.raw.length - live.length,
    slot,
    recent: latest.map((o) => ({
      ...o,
      reviewResult: reviewById.get(o.recordId) ?? "",
      deliveredOn:
        deliveredByCustomer.get(customerIdByOrder.get(o.recordId) ?? "") ?? "",
    })),
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
        {/* 通信が一時的に途切れただけのことが多いので、この画面でも自動更新は続ける。
            会場で待っているうちに自然に直れば、操作しなくても表示が戻る。 */}
        <PageHeader
          title="ダッシュボード"
          description={`${jpMonthLabel(month)}の状況`}
          actions={<AutoRefresh seconds={REFRESH_SECONDS} label="ダッシュボード" />}
        />
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

  const { self, summary, stoppedCount, slot, breakdown, slotUnit, showSlots, recent } = data;

  // スタッフ（コード区分 02）には報酬の金額を出さない。
  // 2026-04-23 の打ち合わせで「金額が見えるのは親アカウントだけ」と決まっている。
  const isStaff = self.codeKind === "02";
  const showReward = !isStaff;

  // 自分のランクに対応する単価が App10 にあるかどうか。
  // 「販売代理店」ぶんのフィールドは未整備のため null が返る。
  const rewardAvailable = canComputeReward(self);
  const rankMissing = effectiveRank(self) === "";
  const rewardTotal = rewardAvailable ? summary.rewardTotal : null;

  // 画面に出す呼び方は labels.ts に寄せる（データベースの値は「2次代理店」のまま）。
  const rankText = rankLabel(self.rank || self.channel, self.codeKind);
  // 報酬の単価を引くときのランク。販路種別が「販売代理店」ならそちらが使われる。
  const rewardRankText = rankLabel(effectiveRank(self));

  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        description={`${self.name}（${self.code}）／ ${jpMonthLabel(month)}の状況です。自分の分と配下の分を合わせて集計しています。`}
        actions={
          <>
            <Badge tone="gold">{rankText}</Badge>
            <AutoRefresh seconds={REFRESH_SECONDS} label="ダッシュボード" />
          </>
        }
      />

      {/* 1. 今月の要約 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="今月の受注"
          value={String(summary.orderCount)}
          unit="件"
          hint={`${summary.unitCount}台 ／ 出荷済 ${summary.shippedCount}件${
            stoppedCount > 0 ? ` ／ 中止 ${stoppedCount}件は除く` : ""
          }`}
        />
        <StatTile
          label="今月の売上"
          value={yen(summary.salesTotal)}
          hint={
            stoppedCount > 0
              ? "ご自身と配下の販売金額の合計（中止分を除く）"
              : "ご自身と配下の販売金額の合計"
          }
        />
        {showReward ? (
          <StatTile
            label="今月の報酬見込み"
            value={rewardTotal === null ? "—" : yen(rewardTotal)}
            tone="gold"
            hint={
              rewardAvailable
                ? `${rewardRankText}としての単価 × 台数。確定額は本部の締め後に確定します。`
                : "単価が未設定のため計算できません"
            }
          />
        ) : (
          <StatTile
            label="今月の出荷済"
            value={String(summary.shippedCount)}
            unit="件"
            hint="発送が終わった受注の件数"
          />
        )}
        {showSlots ? (
          <StatTile
            label="枠の空き"
            value={breakdown.limit <= 0 ? "—" : String(breakdown.remaining)}
            unit={slotUnit}
            tone={breakdown.isFull ? "warn" : "default"}
            hint={
              breakdown.limit <= 0
                ? "上限は設けていません（特別枠）"
                : `${breakdown.limit}${slotUnit}のうち ${breakdown.used}${slotUnit} が登録済み`
            }
          />
        ) : null}
      </div>

      {showReward ? (
        !rewardAvailable ? (
          <Notice tone="warn">
            {rankMissing
              ? "代理店ランクが登録されていないため、報酬額を計算できません。本部にご確認ください。"
              : "販売代理店分の単価がマスタ未設定のため金額を表示できません。本部にお問い合わせください。"}
          </Notice>
        ) : null
      ) : (
        <Notice tone="info">
          報酬の金額は所属先の代理店にお問い合わせください。
          この画面では、件数と売上金額、配送の進み具合のみ表示しています。
        </Notice>
      )}

      {stoppedCount > 0 ? (
        <Notice tone="warn">
          今月の受注のうち {stoppedCount} 件は、キャンセルまたは信販の審査が通らなかったため、
          上の件数・売上{showReward ? "・報酬見込み" : ""}には数えていません。
          <Link
            href="/customers"
            className="ml-1.5 font-medium underline underline-offset-2 hover:text-gold-300"
          >
            顧客一覧で内容を確認する
          </Link>
        </Notice>
      ) : null}

      {/* 2. 枠の状況。配下を持てない相手（取次パートナー・スタッフ・3次代理店）には出さない */}
      {showSlots ? (
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
                {breakdown.limit <= 0
                  ? `いま ${breakdown.used}${slotUnit} を登録しています（上限なし）。`
                  : breakdown.isFull
                    ? "枠がいっぱいです。"
                    : `${breakdown.limit}${slotUnit}のうち ${breakdown.used}${slotUnit} を使っています。`}
              </span>
              {slot.requestStatus && slot.requestStatus !== "なし" ? (
                <Badge tone={slot.requestStatus === "申請中" ? "warn" : "neutral"}>
                  増枠申請：{slot.requestStatus}
                </Badge>
              ) : null}
            </div>

            {breakdown.isFull ? (
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

      ) : null}

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
                <Th>進み具合</Th>
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
                    <Progress
                      compact
                      reviewResult={o.reviewResult}
                      shipStatus={o.shippingStatus}
                      deliveredOn={o.deliveredOn}
                    />
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
