import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import {
  DEFAULT_SLOT_LIMIT,
  countsTowardSlot,
  getSlotSummary,
  listAllAgencies,
  listPendingSlotRequests,
  type SlotSummary,
} from "@/lib/agencies";
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
} from "@/components/ui";
import { DecisionForm } from "./DecisionForm";

/** 「枠が埋まりつつある」とみなす使用率。 */
const NEAR_FULL_RATIO = 0.8;

type NearFull = {
  agency: Agency;
  limit: number;
  used: number;
  ratio: number;
};

/**
 * 申請はまだ出ていないが、枠が残りわずかな代理店を洗い出す。
 * 枠を持つのはコード区分 00（正規代理店）で、消費するのも配下の 00 だけ。
 */
function nearFullAgencies(all: Agency[]): NearFull[] {
  const childCount = new Map<string, number>();
  for (const a of all) {
    if (!a.parentCode || !countsTowardSlot(a)) continue;
    childCount.set(a.parentCode, (childCount.get(a.parentCode) ?? 0) + 1);
  }

  return all
    .filter((a) => a.codeKind === "00" && a.status !== "停止・解約")
    .map((a) => {
      const limit = a.slotLimit || DEFAULT_SLOT_LIMIT;
      const used = childCount.get(a.code) ?? 0;
      return { agency: a, limit, used, ratio: limit > 0 ? used / limit : 0 };
    })
    .filter((r) => r.ratio >= NEAR_FULL_RATIO && r.agency.slotRequestStatus !== "申請中")
    .sort((a, b) => b.ratio - a.ratio || b.used - a.used);
}

export default async function AdminRequestsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  let pending: Agency[] = [];
  let summaries: SlotSummary[] = [];
  let all: Agency[] = [];
  let loadError: string | null = null;

  try {
    [pending, all] = await Promise.all([listPendingSlotRequests(), listAllAgencies()]);
    // App9 の「登録済件数」は自動集計。実データで数え直して突き合わせる。
    summaries = await Promise.all(pending.map((a) => getSlotSummary(a)));
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "代理店の情報を取得できませんでした。時間をおいてもう一度お試しください。";
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="増枠申請"
          description="代理店から届いている販売代理店枠の増枠申請を確認し、承認または却下します。"
        />
        <Notice tone="bad">
          申請の一覧を読み込めませんでした。{loadError}
          <br />
          しばらく待ってから画面を読み込み直してください。続くようであれば kintone
          の接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  const nearFull = nearFullAgencies(all);

  return (
    <div className="space-y-6">
      <PageHeader
        title="増枠申請"
        description="代理店から届いている販売代理店枠の増枠申請を確認し、承認または却下します。承認すると、その代理店はすぐに新しい枠まで登録できるようになります。"
        actions={
          <Badge tone={pending.length > 0 ? "warn" : "neutral"}>
            承認待ち {pending.length} 件
          </Badge>
        }
      />

      {pending.length === 0 ? (
        <Card title="承認待ちの申請">
          <EmptyState
            title="増枠の申請はありません"
            description="代理店が枠の上限に達して申請すると、ここに表示されます。"
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {pending.map((a, i) => {
            const s = summaries[i];
            const mismatch = a.slotUsed !== s.used;
            return (
              <Card key={a.recordId || a.code}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-800 px-5 py-4">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-ink-50">
                      {a.name || "（名称未登録）"}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
                      <span className="tabnum">{a.code || "コード未設定"}</span>
                      <span>{a.area || "エリア未設定"}</span>
                      <span>{a.rank || "ランク未設定"}</span>
                      <span>
                        上位代理店:{" "}
                        {a.parentName || a.parentCode || "なし（総販売代理店の直下）"}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {a.specialSlot ? <Badge tone="gold">特別枠</Badge> : null}
                    <StatusBadge status="申請中" />
                  </div>
                </div>

                <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="現在の上限" value={String(s.limit)} unit="社" />
                  <StatTile
                    label="実際の登録済件数"
                    value={String(s.used)}
                    unit="社"
                    tone={s.isOver ? "warn" : "default"}
                    hint="配下の正規代理店（コード区分 00）を数え直した実数"
                  />
                  <StatTile
                    label="残りの空き"
                    value={String(s.remaining)}
                    unit="社"
                    tone={s.remaining === 0 ? "warn" : "default"}
                  />
                  <StatTile
                    label="kintone の自動集計"
                    value={String(a.slotUsed)}
                    unit="社"
                    hint={mismatch ? "実数と一致していません" : "実数と一致"}
                    tone={mismatch ? "warn" : "default"}
                  />
                </div>

                <div className="space-y-3 px-5 pb-4">
                  {mismatch ? (
                    <Notice tone="warn">
                      kintone の「登録済件数」は {a.slotUsed} 社ですが、配下をたどって数えると{" "}
                      {s.used} 社です。自動集計が更新されていない可能性があるため、
                      枠の判断は実数（{s.used} 社）で行ってください。
                    </Notice>
                  ) : null}
                  {s.others.length > 0 ? (
                    <p className="text-xs leading-relaxed text-ink-400">
                      このほかに取次・スタッフが {s.others.length} 社ぶら下がっていますが、
                      枠は消費しません。
                    </p>
                  ) : null}
                </div>

                <DecisionForm
                  recordId={a.recordId}
                  suggestedLimit={s.limit + 10}
                  minLimit={s.used}
                />
              </Card>
            );
          })}
        </div>
      )}

      <Card title="枠が埋まりつつある代理店（参考）">
        <p className="px-5 pt-4 text-sm leading-relaxed text-ink-300">
          申請はまだ出ていませんが、枠の使用率が {Math.round(NEAR_FULL_RATIO * 100)}%
          を超えている代理店です。申請を待たずに上限を調整することもできます。
        </p>
        {nearFull.length === 0 ? (
          <EmptyState
            title="枠が埋まりつつある代理店はありません"
            description="各社ともまだ枠に余裕があります。使用率が 80% を超えた代理店が出ると、ここに表示されます。"
          />
        ) : (
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>代理店</Th>
                  <Th>エリア</Th>
                  <Th>上位代理店</Th>
                  <Th align="right">登録済</Th>
                  <Th align="right">上限</Th>
                  <Th align="right">使用率</Th>
                  <Th align="center">状態</Th>
                </tr>
              </thead>
              <tbody>
                {nearFull.map(({ agency, limit, used, ratio }) => (
                  <tr key={agency.recordId || agency.code}>
                    <Td>
                      <div className="font-medium text-ink-100">
                        {agency.name || "（名称未登録）"}
                      </div>
                      <div className="tabnum text-xs text-ink-500">{agency.code}</div>
                    </Td>
                    <Td>{agency.area || "—"}</Td>
                    <Td>{agency.parentName || agency.parentCode || "—"}</Td>
                    <Td numeric align="right">
                      {used}
                    </Td>
                    <Td numeric align="right">
                      {limit}
                    </Td>
                    <Td numeric align="right">
                      {Math.round(ratio * 100)}%
                    </Td>
                    <Td align="center">
                      {used >= limit ? (
                        <Badge tone="bad">満枠</Badge>
                      ) : (
                        <Badge tone="warn">残り {limit - used} 社</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
