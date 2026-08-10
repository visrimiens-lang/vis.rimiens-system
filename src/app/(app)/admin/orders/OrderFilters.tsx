"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { jpMonthLabel } from "@/components/ui";

/** 代理店コードの選択肢。count は選択中の期間での受注件数。 */
export type CodeOption = { code: string; name: string; count: number };

/** 出荷状況の選択肢。count は選択中の期間での受注件数。 */
export type ShipOption = { value: string; count: number };

const SELECT_CLASS =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60";

function buildHref(month: string, code: string, ship: string): string {
  const params = new URLSearchParams();
  params.set("month", month);
  if (code !== "all") params.set("code", code);
  if (ship !== "all") params.set("ship", ship);
  return `/admin/orders?${params.toString()}`;
}

/**
 * 本部の受注一覧の絞り込み。
 * 選んだ瞬間に URL を書き換えて読み直すので、絞り込んだ状態をそのまま共有できる。
 */
export function OrderFilters({
  month,
  months,
  defaultMonth,
  code,
  codeOptions,
  ship,
  shipOptions,
  periodCount,
}: {
  /** "all" または "YYYY-MM" */
  month: string;
  months: string[];
  /** 既定（今月） */
  defaultMonth: string;
  /** "all" または代理店コード */
  code: string;
  codeOptions: CodeOption[];
  /** "all" または出荷状況 */
  ship: string;
  shipOptions: ShipOption[];
  /** 選択中の期間の受注件数（絞り込む前） */
  periodCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (nextMonth: string, nextCode: string, nextShip: string) => {
    startTransition(() => {
      router.push(buildHref(nextMonth, nextCode, nextShip));
    });
  };

  const filtered = month !== defaultMonth || code !== "all" || ship !== "all";

  return (
    <div className="flex flex-wrap items-end gap-4 px-5 py-4">
      <label className="block w-44">
        <span className="text-xs font-medium tracking-wide text-ink-300">期間</span>
        <select
          value={month}
          disabled={pending}
          onChange={(e) => go(e.target.value, code, ship)}
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
        <span className="text-xs font-medium tracking-wide text-ink-300">代理店コード</span>
        <select
          value={code}
          disabled={pending}
          onChange={(e) => go(month, e.target.value, ship)}
          className={SELECT_CLASS}
        >
          <option value="all">すべての代理店（{periodCount}件）</option>
          {codeOptions.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code}
              {o.name ? `　${o.name}` : ""}（{o.count}件）
            </option>
          ))}
        </select>
      </label>

      <label className="block w-52">
        <span className="text-xs font-medium tracking-wide text-ink-300">出荷状況</span>
        <select
          value={ship}
          disabled={pending}
          onChange={(e) => go(month, code, e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="all">すべて（{periodCount}件）</option>
          {shipOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value}（{o.count}件）
            </option>
          ))}
        </select>
      </label>

      {filtered ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => go(defaultMonth, "all", "all")}
          className="pb-2.5 text-xs text-ink-400 underline underline-offset-4 transition hover:text-ink-200 disabled:opacity-60"
        >
          今月・すべてに戻す
        </button>
      ) : null}

      {pending ? <span className="pb-2.5 text-xs text-ink-400">読み込み中…</span> : null}
    </div>
  );
}
