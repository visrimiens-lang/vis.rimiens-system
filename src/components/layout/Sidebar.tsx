"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  Map,
  Megaphone,
  Monitor,
  Network,
  Settings,
  ShieldCheck,
  Users,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { logoutAction } from "@/actions/auth-actions";
import { cn } from "@/components/ui";

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
  { href: "/admin/agencies", label: "代理店管理", icon: Building2 },
  { href: "/admin/areas", label: "エリア枠", icon: Map },
  { href: "/admin/requests", label: "増枠申請", icon: ShieldCheck },
  { href: "/admin/notices", label: "お知らせ管理", icon: Megaphone },
  { href: "/admin/documents", label: "資料管理", icon: FileText },
];

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

  const render = (items: Item[], heading?: string) => (
    <div className="space-y-1">
      {heading ? (
        <div className="px-3 pb-1.5 pt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-600">
          {heading}
        </div>
      ) : null}
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
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
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <div className="border-b border-ink-800 px-5 py-5">
        <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-gold-500">
          VIS
        </div>
        <div className="mt-0.5 text-sm font-semibold text-ink-50">代理店ポータル</div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {isHq ? render(HQ_ITEMS, "本部") : render(AGENCY_ITEMS)}
      </nav>

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
    </aside>
  );
}
