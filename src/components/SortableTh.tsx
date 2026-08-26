import Link from "next/link";
import type { ReactNode } from "react";
import { Th, cn } from "@/components/ui";
import {
  ALL,
  buildSortHref,
  type FilterOption,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";

/* ------------------------------------------------------------------
 * 一覧まわりの小さな部品。
 *
 * ・押すと並び替わる見出し（SortableTh）
 * ・絞り込みの入力欄（FilterBar / FilterSelect / FilterText）
 * ・「◯件中◯件を表示しています」の案内（FilterSummary）
 *
 * どれもリンクと普通のフォームでできているので、画面はサーバー
 * コンポーネントのままでよい（"use client" は要らない）。
 * 見た目は @/components/ui のものに合わせてあり、独自の色は作らない。
 * ------------------------------------------------------------------ */

/* ---------- 押すと並び替わる見出し ---------- */

/** いまの並び順を伝える文言。専門用語を出さずに、次に何が起きるかを書く。 */
function sortTitle(label: string, active: boolean, desc: boolean): string {
  if (!active) return `${label}で並び替える`;
  return desc
    ? `いまは${label}の大きい順です。押すと小さい順になります`
    : `いまは${label}の小さい順です。押すと大きい順になります`;
}

export function SortableTh({
  column,
  label,
  sort,
  basePath,
  params,
  align = "left",
}: {
  /** この見出しが担当する列の名前 */
  column: string;
  /** 画面に出す見出しの文言 */
  label: string;
  /** いまの並び順 */
  sort: SortState;
  /** 遷移先のパス（例: "/admin/agencies"） */
  basePath: string;
  /** いまのクエリ。並び替えても絞り込みが外れないよう引き継ぐ */
  params: SearchParams;
  align?: "left" | "right" | "center";
}) {
  const active = sort.column === column;
  const href = buildSortHref(basePath, params, column, sort);

  return (
    <Th align={align}>
      <Link
        href={href}
        title={sortTitle(label, active, sort.desc)}
        aria-label={sortTitle(label, active, sort.desc)}
        className={cn(
          /*
            -mx-4 -my-2.5 px-4 py-2.5 で、Th のふちまでを押せる範囲にする。
            これが無いと押せるのは文字の高さ（約16px）だけで、
            スマホでは狙いにくく、隣の列の並び替えを押してしまう。
          */
          "-mx-4 -my-2.5 inline-flex items-center gap-1 px-4 py-2.5 transition",
          align === "right" && "flex-row-reverse",
          active ? "text-gold-300" : "text-ink-400 hover:text-ink-100",
        )}
      >
        <span>{label}</span>
        <span aria-hidden className={cn("text-[10px]", active ? "text-gold-400" : "text-ink-600")}>
          {active ? (sort.desc ? "↓" : "↑") : "↕"}
        </span>
      </Link>
    </Th>
  );
}

/* ---------- 絞り込みの入力欄 ---------- */

const selectCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 focus:border-gold-500 focus:outline-none";
const textCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 placeholder:text-ink-500 focus:border-gold-500 focus:outline-none";
const labelCls = "text-xs font-medium tracking-wide text-ink-300";

/**
 * 絞り込みの箱。
 * 送信ボタンを押すと、選んだ内容がそのまま URL のクエリになる（GET）。
 * hidden には、絞り込みで消したくないもの（タブや並び順）を渡す。
 */
export function FilterBar({
  action,
  hidden = {},
  children,
}: {
  /** 送信先のパス（例: "/admin/orders"） */
  action: string;
  /** 引き継ぎたいクエリ。空のものは送らない */
  hidden?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  return (
    /* data-filter は印刷のときに丸ごと隠すための目印（globals.css の @media print） */
    <form
      method="get"
      action={action}
      data-filter=""
      className="flex flex-wrap items-end gap-4 px-5 py-4"
    >
      {Object.entries(hidden).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      {children}
    </form>
  );
}

export function FilterSelect({
  name,
  label,
  value,
  options,
  allLabel = "すべて",
  width = "w-44",
  showCount = true,
}: {
  name: string;
  label: string;
  /** いま選ばれている値。"all" なら絞り込んでいない */
  value: string;
  options: FilterOption[];
  allLabel?: string;
  width?: string;
  /** 選択肢に件数を添えるか。件数に意味が無い選び方（期間など）では false にする */
  showCount?: boolean;
}) {
  return (
    <label className={cn("block", width)}>
      <span className={labelCls}>{label}</span>
      {/* key を付けて、いまの条件が変わったら選び直しの部品を作り直す。
          こうしないと「条件を外す」を押したときに、選んだ内容が画面に残ってしまう。 */}
      <select key={`${name}:${value}`} name={name} defaultValue={value} className={selectCls}>
        <option value={ALL}>{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {showCount ? `（${o.count}）` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterText({
  name,
  label,
  value,
  placeholder,
  width = "w-60",
}: {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  width?: string;
}) {
  return (
    <label className={cn("block", width)}>
      <span className={labelCls}>{label}</span>
      {/* 選び直しの部品と同じ理由で key を付ける。
          「条件を外す」を押したときに、打ち込んだ文字が残らないようにする。 */}
      <input
        key={`${name}:${value}`}
        type="search"
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        className={textCls}
      />
    </label>
  );
}

/** 絞り込みの実行ボタンと、条件を外すリンク。 */
export function FilterActions({
  clearHref,
  filtered,
  submitLabel = "この条件で絞り込む",
  clearLabel = "条件を外す",
}: {
  clearHref: string;
  /** いま何かで絞り込んでいるか。true のときだけ「条件を外す」を出す */
  filtered: boolean;
  submitLabel?: string;
  clearLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3 pb-0.5">
      <button
        type="submit"
        className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-ink-100 transition hover:bg-ink-700"
      >
        {submitLabel}
      </button>
      {filtered ? (
        <Link
          href={clearHref}
          // 指で押せる高さを確保する（文字だけだと約16px しかない）
          className="inline-flex min-h-9 items-center px-1 text-xs text-ink-400 underline underline-offset-4 transition hover:text-ink-200"
        >
          {clearLabel}
        </Link>
      ) : null}
    </div>
  );
}

/* ---------- 「◯件中◯件を表示しています」 ---------- */

export function FilterSummary({
  total,
  shown,
  unit = "件",
  clearHref,
  note,
}: {
  /** 絞り込む前の件数 */
  total: number;
  /** 絞り込んだあとの件数 */
  shown: number;
  /** 数え方（件・名・台・社） */
  unit?: string;
  clearHref: string;
  /** どんな条件で絞っているかの補足 */
  note?: string;
}) {
  return (
    <p className="text-sm text-ink-300">
      {total.toLocaleString("ja-JP")}
      {unit}中 {shown.toLocaleString("ja-JP")}
      {unit}を表示しています。
      {note ? <span className="text-ink-400">（{note}）</span> : null}
      <Link
        href={clearHref}
        className="ml-1.5 underline underline-offset-2 hover:text-gold-300"
      >
        条件を外す
      </Link>
    </p>
  );
}
