import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAllAgencies } from "@/lib/agencies";
import { areaUsage } from "@/lib/slots";
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
  cn,
} from "@/components/ui";

export default async function AreaQuotaPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  let all;
  try {
    all = await listAllAgencies();
  } catch (e) {
    return (
      <div className="space-y-6">
        <PageHeader title="エリア枠" description="エリアごとの統括代理店の枠です。" />
        <Notice tone="bad">
          代理店マスタを読み込めませんでした。
          {e instanceof Error ? e.message : "時間をおいてもう一度お試しください。"}
        </Notice>
      </div>
    );
  }

  const { rows, total, excluded } = areaUsage(all);

  return (
    <div className="space-y-6">
      <PageHeader
        title="エリア枠"
        description="エリア統括代理店（2次代理店）は全国で60社までです。エリアごとの上限と、いま何社入っているかを表示しています。"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="全国の枠"
          value={String(total.limit)}
          unit="社"
          hint="6エリアの合計"
        />
        <StatTile
          label="登録済み"
          value={String(total.used)}
          unit="社"
          tone="gold"
          hint="稼働中の統括代理店"
        />
        <StatTile
          label="残り"
          value={String(total.remaining)}
          unit="社"
          tone={total.remaining === 0 ? "warn" : "default"}
          hint={total.remaining === 0 ? "全国の枠が埋まっています" : "まだ登録できます"}
        />
      </div>

      <Card title="エリアごとの内訳">
        <Table>
          <thead>
            <tr>
              <Th>エリア</Th>
              <Th align="right">登録済</Th>
              <Th align="right">上限</Th>
              <Th align="right">残り</Th>
              <Th>状況</Th>
              <Th>登録されている統括代理店</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.area}>
                <Td>
                  <span className="font-medium text-ink-100">{r.area}</span>
                </Td>
                <Td numeric align="right">
                  <span
                    className={cn(
                      "font-semibold",
                      r.isFull ? "text-warn-500" : "text-ink-100",
                    )}
                  >
                    {r.used}
                  </span>
                </Td>
                <Td numeric align="right">
                  {r.limit}
                </Td>
                <Td numeric align="right">
                  {r.remaining}
                </Td>
                <Td>
                  {r.isFull ? (
                    <Badge tone="warn">満枠</Badge>
                  ) : r.used === 0 ? (
                    <Badge>未登録</Badge>
                  ) : (
                    <Badge tone="good">空きあり</Badge>
                  )}
                </Td>
                <Td>
                  {r.members.length === 0 ? (
                    <span className="text-ink-500">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {r.members.map((m) => (
                        <span
                          key={m.code}
                          className="rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-xs text-ink-200"
                        >
                          {m.name || m.code}
                        </span>
                      ))}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="font-semibold text-ink-100">合計</Td>
              <Td numeric align="right" className="font-semibold text-gold-400">
                {total.used}
              </Td>
              <Td numeric align="right" className="font-semibold text-ink-100">
                {total.limit}
              </Td>
              <Td numeric align="right" className="font-semibold text-ink-100">
                {total.remaining}
              </Td>
              <Td> </Td>
              <Td> </Td>
            </tr>
          </tbody>
        </Table>
      </Card>

      {excluded.length > 0 ? (
        <Card title="枠から除外している統括代理店">
          <div className="px-5 py-4">
            <p className="text-sm leading-relaxed text-ink-300">
              エリア区分が「本部」の統括代理店は、全国60社の枠には数えていません（2026-07-09の決定）。
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {excluded.map((m) => (
                <span
                  key={m.code}
                  className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200"
                >
                  {m.name || m.code}
                  <span className="ml-1.5 text-ink-500">{m.code}</span>
                </span>
              ))}
            </div>
          </div>
        </Card>
      ) : null}

      {rows.every((r) => r.used === 0) ? (
        <EmptyState
          title="エリア区分が入っている統括代理店がまだありません"
          description="代理店マスタでエリア区分を設定すると、ここに反映されます。"
        />
      ) : null}
    </div>
  );
}
