"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Boxes,
  Building2,
  ClipboardList,
  FileText,
  IdCard,
  Inbox,
  LayoutDashboard,
  LogOut,
  Map,
  Megaphone,
  Menu,
  Monitor,
  Network,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  UserRound,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { logoutAction } from "@/actions/auth-actions";
import { cn } from "@/components/ui";

/**
 * 画面の左に出るメニュー。
 *
 * パソコン（lg 以上）… 画面の左に貼り付いたまま動かない（sticky）。
 *   本文だけがスクロールし、メニューは常に見えている。
 *   項目が画面に収まらないときはメニューの中だけがスクロールする。
 *
 * スマホ・タブレット（lg 未満）… メニューはふだん隠れていて、
 *   上部バーの「メニュー」ボタンで左から出てくる（ドロワー）。
 *   240px のメニューを常に出すと、スマホでは本文の幅がほぼ残らないため。
 *   閉じ方は3つ: 暗い背景を押す / 右上の×を押す / Esc キー。
 *   ページを移動したときも自動で閉じる。
 */

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };

const AGENCY_ITEMS: Item[] = [
  { href: "/dashboard", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/customers", label: "顧客一覧", icon: Users },
  { href: "/organization", label: "組織と枠", icon: Network },
  { href: "/leads", label: "トスアップ", icon: ClipboardList },
  { href: "/rewards", label: "売上・報酬", icon: Wallet },
  { href: "/demo-machines", label: "デモ機", icon: Monitor },
  { href: "/announcements", label: "お知らせ", icon: Megaphone },
  { href: "/documents", label: "資料", icon: FileText },
  { href: "/settings", label: "アカウント設定", icon: Settings },
];

const HQ_ITEMS: Item[] = [
  { href: "/admin/orders", label: "受注一覧", icon: ShoppingCart },
  // 取り込みに失敗した申込に気づける唯一の場所。上のほうに置く。
  { href: "/admin/inbox", label: "受信箱", icon: Inbox },
  { href: "/admin/rewards", label: "報酬の支払", icon: Wallet },
  { href: "/admin/agencies", label: "代理店管理", icon: Building2 },
  // 問題のあった相手のQRを、探し回らずその場で止められる場所。代理店管理のすぐ下に置く。
  { href: "/admin/staff", label: "スタッフコード", icon: IdCard },
  { href: "/admin/customers", label: "顧客管理", icon: UserRound },
  { href: "/admin/products", label: "商品マスタ", icon: Package },
  { href: "/admin/demo", label: "デモ機管理", icon: Boxes },
  { href: "/admin/areas", label: "エリア枠", icon: Map },
  { href: "/admin/requests", label: "増枠申請", icon: ShieldCheck },
  { href: "/admin/notices", label: "お知らせ管理", icon: Megaphone },
  { href: "/admin/documents", label: "資料管理", icon: FileText },
];

function Brand() {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-gold-500">
        VIS
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold text-ink-50">
        代理店ポータル
      </div>
    </div>
  );
}

export function Sidebar({
  viewerLabel,
  viewerCode,
  isHq,
}: {
  viewerLabel: string;
  viewerCode?: string;
  isHq: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // ページを移動したら、開いていたドロワーを閉じる
  useEffect(() => setOpen(false), [pathname]);

  // ドロワーが開いている間: Esc で閉じる・背面のスクロールを止める
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const nav = (onNavigate?: () => void) => (
    <nav className="flex-1 overflow-y-auto px-3 py-4">
      <div className="space-y-1">
        {isHq ? (
          <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-600">
            本部
          </div>
        ) : null}
        {(isHq ? HQ_ITEMS : AGENCY_ITEMS).map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
                active
                  ? "bg-gold-500/12 text-gold-300"
                  : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );

  const footer = (
    <div className="border-t border-ink-800 p-3">
      <div className="px-2 pb-2">
        <div className="truncate text-sm font-medium text-ink-100">{viewerLabel}</div>
        {viewerCode ? (
          <div className="tabnum truncate text-xs text-ink-500">{viewerCode}</div>
        ) : null}
      </div>
      <form action={logoutAction}>
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-400 transition hover:bg-ink-850 hover:text-ink-100"
        >
          <LogOut className="h-4 w-4" />
          ログアウト
        </button>
      </form>
    </div>
  );

  return (
    <>
      {/* ── パソコン: 画面に貼り付いたメニュー ── */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900 lg:flex">
        <div className="border-b border-ink-800 px-5 py-5">
          <Brand />
        </div>
        {nav()}
        {footer}
      </aside>

      {/* ── スマホ: 上部バー ── */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-ink-800 bg-ink-950/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="メニューを開く"
          aria-expanded={open}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-ink-700 text-ink-200 transition hover:bg-ink-850"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* ── スマホ: ドロワー ── */}
      <div
        className={cn("fixed inset-0 z-50 lg:hidden", open ? "" : "pointer-events-none")}
        aria-hidden={!open}
      >
        {/* 暗い背景。押すと閉じる */}
        <div
          className={cn(
            "absolute inset-0 bg-black/60 transition-opacity duration-200",
            open ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="メニュー"
          className={cn(
            "absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-ink-800 bg-ink-900 shadow-2xl transition-transform duration-200",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex items-center justify-between border-b border-ink-800 py-3 pl-5 pr-3">
            <Brand />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="メニューを閉じる"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-300 transition hover:bg-ink-850 hover:text-ink-100"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {nav(() => setOpen(false))}
          {footer}
        </div>
      </div>
    </>
  );
}
