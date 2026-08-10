import { Badge, cn } from "@/components/ui";
import type { SlotBreakdown as Breakdown, SlotLine } from "@/lib/slots";

/** 1種別ぶんの枠バー。埋まり具合を横棒で示す。 */
function SlotBar({ line }: { line: SlotLine }) {
  const pct = line.limit > 0 ? Math.min(100, (line.used / line.limit) * 100) : 0;
  const tone = line.isFull ? "warn" : line.used > 0 ? "gold" : "idle";

  return (
    <div className="py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink-100">{line.label}</span>
          {line.isFull ? <Badge tone="warn">枠が埋まりました</Badge> : null}
        </div>
        <div className="tabnum text-sm text-ink-300">
          <span
            className={cn(
              "text-base font-semibold",
              tone === "warn" && "text-warn-500",
              tone === "gold" && "text-gold-400",
              tone === "idle" && "text-ink-200",
            )}
          >
            {line.used}
          </span>
          <span className="text-ink-500"> / {line.limit}</span>
        </div>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            line.isFull ? "bg-warn-500" : "bg-gold-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs text-ink-500">
        <span>{line.note}</span>
        <span>{line.isFull ? "増枠の申請が必要です" : `あと ${line.remaining} 枠`}</span>
      </div>

      {line.members.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {line.members.map((m) => (
            <span
              key={m.code}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200"
              title={m.code}
            >
              {m.name || m.code}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SlotBreakdown({ data }: { data: Breakdown }) {
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink-800 pb-4">
        <div>
          <div className="tabnum text-3xl font-semibold tracking-tight text-ink-50">
            {data.totalUsed}
            <span className="text-lg text-ink-500"> / {data.totalLimit}</span>
          </div>
          <div className="mt-1 text-sm text-ink-300">
            配下に登録できる枠は全部で {data.totalLimit} です。
          </div>
        </div>
        <div className="text-xs leading-relaxed text-ink-500">
          販路種別ごとに枠が分かれています。
          <br />
          停止・解約になった代理店は枠を使いません。
        </div>
      </div>

      <div className="divide-y divide-ink-850">
        {data.lines.map((line) => (
          <SlotBar key={line.key} line={line} />
        ))}
      </div>

      {data.staff.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          このほかにスタッフが {data.staff.length} 名います（
          {data.staff.map((a) => a.name || a.code).join("、")}）。
          スタッフは代理店ではないため、枠を使いません。
        </p>
      ) : null}

      {data.unclassified.length > 0 ? (
        <div className="mt-3 rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm leading-relaxed text-warn-100">
          販路種別が入っていない配下が {data.unclassified.length} 件あり、どの枠にも数えられていません（
          {data.unclassified.map((a) => a.name || a.code).join("、")}）。
          本部にご連絡ください。
        </div>
      ) : null}
    </div>
  );
}
