"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { jpMonthLabel } from "@/components/ui";

/** トスアップ一覧の対象月。選んだ瞬間に読み直す。 */
export function LeadMonthFilter({
  month,
  months,
  defaultMonth,
}: {
  /** "all" または "YYYY-MM" */
  month: string;
  months: string[];
  /** 既定（今月） */
  defaultMonth: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (next: string) => {
    startTransition(() => router.push(`/leads?month=${next}`));
  };

  return (
    <div className="flex flex-wrap items-end gap-4 px-5 py-4">
      <label className="block w-48">
        <span className="text-xs font-medium tracking-wide text-ink-300">期間</span>
        <select
          value={month}
          disabled={pending}
          onChange={(e) => go(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60"
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {jpMonthLabel(m)}
              {m === defaultMonth ? "（今月）" : ""}
            </option>
          ))}
          <option value="all">全期間</option>
        </select>
      </label>

      {month !== defaultMonth ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => go(defaultMonth)}
          className="pb-2.5 text-xs text-ink-400 underline underline-offset-4 transition hover:text-ink-200 disabled:opacity-60"
        >
          今月に戻す
        </button>
      ) : null}

      {pending ? <span className="pb-2.5 text-xs text-ink-400">読み込み中…</span> : null}
    </div>
  );
}
