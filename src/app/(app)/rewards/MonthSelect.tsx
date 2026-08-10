"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { jpMonthLabel } from "@/components/ui";

/** 対象月を切り替える。選んだ瞬間に ?month=YYYY-MM で読み直す。 */
export function MonthSelect({ months, value }: { months: string[]; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-ink-300">
      <span className="whitespace-nowrap">対象月</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => router.push(`/rewards?month=${next}`));
        }}
        className="tabnum rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm text-ink-100 transition hover:border-ink-600 disabled:opacity-60"
      >
        {months.map((m) => (
          <option key={m} value={m}>
            {jpMonthLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}
