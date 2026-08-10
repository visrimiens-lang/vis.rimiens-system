"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

/**
 * 代理店一覧の検索窓。
 * 送信すると /admin/agencies?tab=…&keyword=… に移動するだけの小さな部品。
 * 表そのものはサーバー側で絞り込んでいる。
 */
export function AgencySearch({
  tab,
  keyword,
}: {
  tab: string;
  keyword: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(keyword);

  const go = (next: string) => {
    const params = new URLSearchParams();
    if (tab && tab !== "agency") params.set("tab", tab);
    const k = next.trim();
    if (k) params.set("keyword", k);
    const qs = params.toString();
    router.push(qs ? `/admin/agencies?${qs}` : "/admin/agencies");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go(value);
      }}
      className="flex items-center gap-2"
      role="search"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          name="keyword"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="法人名・コードで探す"
          aria-label="法人名または代理店コードで検索"
          className="w-56 rounded-lg border border-ink-700 bg-ink-900 py-2 pl-9 pr-8 text-sm text-ink-100 placeholder:text-ink-400 focus:border-ink-600"
        />
        {value ? (
          <button
            type="button"
            aria-label="検索条件を消す"
            onClick={() => {
              setValue("");
              go("");
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 transition hover:text-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <button
        type="submit"
        className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 transition hover:bg-ink-700"
      >
        検索
      </button>
    </form>
  );
}
