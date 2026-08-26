"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { jpMonthLabel } from "@/components/ui";

/** 担当コードの選択肢。count は選択中の期間での受注件数。 */
export type OwnerOption = {
  code: string;
  name: string;
  count: number;
  isSelf: boolean;
};

const SELECT_CLASS =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60";

function buildHref(month: string, code: string): string {
  const params = new URLSearchParams();
  params.set("month", month);
  if (code !== "all") params.set("code", code);
  return `/customers?${params.toString()}`;
}

export function CustomerFilters({
  month,
  months,
  code,
  options,
  defaultMonth,
}: {
  /** "all" または "YYYY-MM" */
  month: string;
  months: string[];
  /** "all" または担当コード */
  code: string;
  options: OwnerOption[];
  /** 既定（今月） */
  defaultMonth: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (nextMonth: string, nextCode: string) => {
    startTransition(() => {
      router.push(buildHref(nextMonth, nextCode));
    });
  };

  const self = options.filter((o) => o.isSelf);
  const others = options.filter((o) => !o.isSelf);
  const totalCount = options.reduce((s, o) => s + o.count, 0);
  const filtered = month !== defaultMonth || code !== "all";

  const label = (o: OwnerOption) =>
    `${o.code}${o.name ? `　${o.name}` : ""}（${o.count}件）`;

  return (
    <div className="flex flex-wrap items-end gap-4 px-5 py-4">
      <label className="block w-44">
        <span className="text-xs font-medium tracking-wide text-ink-300">期間</span>
        <select
          value={month}
          disabled={pending}
          onChange={(e) => go(e.target.value, code)}
          className={SELECT_CLASS}
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

      <label className="block w-72">
        <span className="text-xs font-medium tracking-wide text-ink-300">担当コード</span>
        <select
          value={code}
          disabled={pending}
          onChange={(e) => go(month, e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="all">すべての担当（{totalCount}件）</option>
          {self.length ? (
            <optgroup label="自分">
              {self.map((o) => (
                <option key={o.code} value={o.code}>
                  {label(o)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {others.length ? (
            <optgroup label="スタッフ">
              {others.map((o) => (
                <option key={o.code} value={o.code}>
                  {label(o)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>

      {filtered ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => go(defaultMonth, "all")}
          className="pb-2.5 text-xs text-ink-400 underline underline-offset-4 transition hover:text-ink-200 disabled:opacity-60"
        >
          今月・全担当に戻す
        </button>
      ) : null}

      {pending ? (
        <span className="pb-2.5 text-xs text-ink-400">読み込み中…</span>
      ) : null}
    </div>
  );
}
