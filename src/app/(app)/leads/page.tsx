import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { currentMonth, recentMonths, scopeCodes } from "@/lib/orders";
import {
  LEAD_LIMIT,
  isClosed,
  jstDate,
  leadMonth,
  listLeads,
  summarizeLeads,
  type Lead,
} from "@/lib/leads";
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
} from "@/components/ui";
import { LeadMonthFilter } from "./MonthFilter";

export const metadata = { title: "トスアップ状況｜VIS 代理店ポータル" };

/** "YYYY-MM" か "all" だけを受け付ける。それ以外は今月に落とす。 */
function normalizeMonth(raw: string | undefined, fallback: string): string {
  if (raw === "all") return "all";
  if (raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return fallback;
}

/** 全期間表示のときだけ年を添える。 */
function showDate(ymd: string, withYear: boolean): string {
  if (!ymd) return "—";
  return withYear ? `${ymd.slice(0, 4)}/${jpDate(ymd)}` : jpDate(ymd);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const { month: monthParam } = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);
  const month = normalizeMonth(monthParam, thisMonth);
  const allPeriod = month === "all";
  const periodLabel = allPeriod ? "全期間" : jpMonthLabel(month);

  let self: Agency | null = null;
  let members: Agency[] = [];
  let allLeads: Lead[] = [];
  let error: string | null = null;

  try {
    self = await findAgencyByCode(viewer.code);
    if (!self) {
      error = `代理店一覧にあなたのコード（${viewer.code}）が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      const descendants = await listDescendants(self.code);
      members = [self, ...descendants];
      allLeads = await listLeads(scopeCodes(self, descendants));
    }
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "トスアップの情報を取得できませんでした。時間をおいて画面を読み込み直してください。";
  }

  // 配下がいる（＝取次店を束ねている）ときは、誰からの紹介かを出す。
  const showReferrer = members.length > 1;

  const header = (
    <PageHeader
      title="トスアップ状況"
      description={
        showReferrer
          ? "専用フォームからご紹介いただいたお客様の進み具合です。ご自身と配下の取次店ぶんをまとめて表示しています。"
          : "専用フォームからご紹介いただいたお客様の進み具合です。ご成約になると成約日と受注番号が入ります。"
      }
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">{error}</Notice>
      </div>
    );
  }

  const rows = allPeriod ? allLeads : allLeads.filter((l) => leadMonth(l) === month);
  const summary = summarizeLeads(rows);
  const nameByCode = new Map(members.map((m) => [m.code, m.name]));
  const truncated = allLeads.length >= LEAD_LIMIT;

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <LeadMonthFilter month={month} months={months} defaultMonth={thisMonth} />
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="トスアップ件数"
          value={String(summary.total)}
          unit="件"
          hint={`${periodLabel}にご紹介いただいた件数`}
        />
        <StatTile
          label="成約件数"
          value={String(summary.closed)}
          unit="件"
          tone="gold"
          hint="お申し込みまで進んだ件数"
        />
        <StatTile
          label="成約率"
          value={summary.closeRate === null ? "—" : `${Math.round(summary.closeRate * 100)}%`}
          hint={
            summary.closeRate === null
              ? "トスアップがまだないため算出できません"
              : `${summary.closed}件 ÷ ${summary.total}件`
          }
        />
      </div>

      <Card title={`ご紹介いただいたお客様（${periodLabel}）`}>
        {rows.length === 0 ? (
          allLeads.length === 0 ? (
            <EmptyState
              title="まだトスアップがありません"
              description="専用フォームからお客様をご紹介いただくと、ここに進捗が表示されます。"
            />
          ) : (
            <EmptyState
              title={`${periodLabel}のトスアップはありません`}
              description="期間を「全期間」に切り替えると、これまでにご紹介いただいたお客様を確認できます。"
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>トスアップ日</Th>
                <Th>お客様名</Th>
                <Th>電話番号</Th>
                {showReferrer ? <Th>紹介元</Th> : null}
                <Th>ステータス</Th>
                <Th>成約日</Th>
                <Th>受注番号</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.recordId}>
                  <Td numeric>{showDate(jstDate(l.tossedAt), allPeriod)}</Td>
                  <Td>{l.customerName || "—"}</Td>
                  <Td numeric>{l.phone || "—"}</Td>
                  {showReferrer ? (
                    <Td>
                      {l.referrerCode ? (
                        <>
                          <Badge tone="gold">{l.referrerCode}</Badge>
                          <div className="mt-1 text-xs text-ink-400">
                            {nameByCode.get(l.referrerCode) ??
                              (l.referrerCode === self?.code ? "自分" : "代理店一覧に該当なし")}
                          </div>
                        </>
                      ) : (
                        <Badge>紹介元なし</Badge>
                      )}
                    </Td>
                  ) : null}
                  <Td>
                    <StatusBadge status={l.status} />
                  </Td>
                  <Td numeric>{showDate(l.closedAt, allPeriod)}</Td>
                  <Td numeric>
                    {l.orderNo ? (
                      l.orderNo
                    ) : (
                      <span className="text-ink-400">{isClosed(l) ? "確認中" : "—"}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {truncated ? (
        <Notice tone="warn">
          ご紹介いただいた件数が多いため、新しい順に{LEAD_LIMIT}
          件までを表示しています。それより前のご紹介は本部にお問い合わせください。
        </Notice>
      ) : null}

      <Notice tone="info">
        ステータスは本部と担当代理店が商談の進み具合にあわせて更新します。「成約」になるとお申し込みが確定し、
        成約日と受注番号が入ります。成約なのに受注番号が「確認中」のままの場合は、本部側で受注との突き合わせが
        済んでいません。数日たっても変わらないときは本部にお問い合わせください。
      </Notice>
    </div>
  );
}
