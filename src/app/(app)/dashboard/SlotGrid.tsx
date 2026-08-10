import type { SlotSummary } from "@/lib/agencies";

/** 「株式会社◯◯」の頭を落として、マスに入る長さの見出しを作る。 */
function shortName(name: string): string {
  const trimmed = name
    .replace(/^(株式会社|有限会社|合同会社|一般社団法人|合資会社)\s*/, "")
    .replace(/(株式会社|有限会社|合同会社)$/, "")
    .trim();
  return trimmed || name || "—";
}

/**
 * 枠の埋まり具合を四角のマスで見せる。
 * 埋まっているマスは会社名の頭、空きマスは点線。
 */
export function SlotGrid({ slot }: { slot: SlotSummary }) {
  const cellCount = Math.max(slot.limit, slot.used, 1);
  const cells = Array.from({ length: cellCount }, (_, i) => slot.members[i] ?? null);

  return (
    <div className="grid grid-cols-5 gap-2 md:grid-cols-10">
      {cells.map((member, i) =>
        member ? (
          <div
            key={member.code || `filled-${i}`}
            title={`${member.name}（${member.code}）`}
            className="flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg border border-gold-500/40 bg-gold-500/10 px-1 py-1"
          >
            <span className="w-full truncate text-center text-[11px] font-medium leading-tight text-gold-300">
              {shortName(member.name)}
            </span>
            <span className="tabnum w-full truncate text-center text-[9px] leading-tight text-ink-400">
              {member.code}
            </span>
          </div>
        ) : (
          <div
            key={`empty-${i}`}
            className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-ink-700 text-[10px] text-ink-600"
          >
            空き
          </div>
        ),
      )}
    </div>
  );
}
