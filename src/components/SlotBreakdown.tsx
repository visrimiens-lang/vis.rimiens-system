import { Badge, cn } from "@/components/ui";
import type { SlotBreakdown as Breakdown } from "@/lib/slots";

/**
 * 直下に登録できるスタッフの枠。
 *
 * 2026-08-22 から枠は「スタッフ100名」の1本。
 * それまでは販路種別ごとに 販売10／サロン30／個人30／取次30 の4本に分けて
 * 横棒を4つ出していたが、エリア統括の下が全員スタッフになり分ける意味がなくなった。
 */
export function SlotBreakdown({ data }: { data: Breakdown }) {
  const unlimited = data.limit <= 0;
  const pct = unlimited ? 0 : Math.min(100, (data.used / data.limit) * 100);

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink-800 pb-4">
        <div>
          <div className="tabnum text-3xl font-semibold tracking-tight text-ink-50">
            {data.used}
            <span className="text-lg text-ink-500">
              {unlimited ? " 名" : ` / ${data.limit} 名`}
            </span>
          </div>
          <div className="mt-1 text-sm text-ink-300">
            {unlimited
              ? "上限は設けていません（特別枠）。"
              : `配下に登録できるのは ${data.limit} 名までです。`}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs leading-relaxed text-ink-500">
          {data.isFull ? <Badge tone="warn">枠が埋まりました</Badge> : null}
          <span>
            停止・解約になった方は
            <br />
            枠を使いません。
          </span>
        </div>
      </div>

      {unlimited ? null : (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                data.isFull ? "bg-warn-500" : "bg-gold-500",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 text-right text-xs text-ink-500">
            {data.isFull ? "増枠の申請が必要です" : `あと ${data.remaining} 名`}
          </div>
        </div>
      )}

      {data.members.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.members.map((m) => (
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
