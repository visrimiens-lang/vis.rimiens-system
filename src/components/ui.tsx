import { clsx } from "clsx";
import type { ReactNode } from "react";

export function cn(...parts: unknown[]) {
  return clsx(parts);
}

/* ---------- 金額・日付の表示 ---------- */

export function yen(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `¥${n.toLocaleString("ja-JP")}`;
}

export function jpDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = v.slice(0, 10).split("-");
  if (d.length !== 3) return v;
  return `${Number(d[1])}/${Number(d[2])}`;
}

export function jpMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

/* ---------- 骨組み ---------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink-800 pb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink-50">{title}</h1>
        {description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-300">{description}</p>
        ) : null}
      </div>
      {/*
        max-w-full + flex-wrap: スマホで中身（自動更新の表示など）が
        1行に収まらないとき、押し出さずに折り返すため。
        shrink-0 にすると縮まず、画面の右へ10pxほどはみ出していた。
      */}
      {actions ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function Card({
  children,
  className,
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-ink-800 bg-ink-900/70 backdrop-blur-sm",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold tracking-wide text-ink-200">{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "gold" | "warn";
}) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/70 px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={cn(
            "tabnum text-2xl font-semibold tracking-tight",
            tone === "gold" && "text-gold-400",
            tone === "warn" && "text-warn-500",
            tone === "default" && "text-ink-50",
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-sm text-ink-400">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-1.5 text-xs text-ink-400">{hint}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "gold";
}) {
  const tones = {
    neutral: "border-ink-600 bg-ink-800 text-ink-200",
    good: "border-good-500/40 bg-good-500/15 text-good-100",
    warn: "border-warn-500/40 bg-warn-500/15 text-warn-100",
    bad: "border-bad-500/40 bg-bad-500/15 text-bad-100",
    gold: "border-gold-500/40 bg-gold-500/15 text-gold-300",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** 出荷状況などのステータス文字列を、意味に応じた色のバッジにする。 */
export function StatusBadge({ status }: { status: string }) {
  if (!status) return <span className="text-ink-400">—</span>;
  const good = ["配達完了", "出荷済", "承認", "承認済", "稼働中", "合格", "支払済", "照合済", "決済完了", "審査完了"];
  const warn = ["出荷手配中", "出荷待ち", "申請中", "電話確認待ち", "未支払", "受講中", "要確認", "着金待ち", "審査中"];
  const bad = ["キャンセル", "否決", "停止・解約", "不合格", "却下", "差戻し"];
  const tone = good.includes(status)
    ? "good"
    : warn.includes(status)
      ? "warn"
      : bad.includes(status)
        ? "bad"
        : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-medium text-ink-200">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-400">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- 表 ---------- */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-ink-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-ink-400",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  numeric,
  className,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "border-b border-ink-850 px-4 py-3 text-ink-200",
        align === "right" && "text-right",
        align === "center" && "text-center",
        numeric && "tabnum",
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ---------- 注意書き ---------- */

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "bad";
  children: ReactNode;
}) {
  const tones = {
    info: "border-ink-700 bg-ink-850 text-ink-200",
    warn: "border-warn-500/40 bg-warn-500/10 text-warn-100",
    bad: "border-bad-500/40 bg-bad-500/10 text-bad-100",
  } as const;
  return (
    <div className={cn("rounded-lg border px-4 py-3 text-sm leading-relaxed", tones[tone])}>
      {children}
    </div>
  );
}
