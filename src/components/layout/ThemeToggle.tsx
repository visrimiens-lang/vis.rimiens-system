"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/components/ui";

/**
 * 画面の明るさの切り替え（暗い配色 ／ 明るい配色）。
 *
 * 選んだ配色は、この端末のブラウザに覚えさせる（localStorage）。
 * サーバーには送らないので、同じアカウントでも端末ごとに変えられる。
 * 何も選んでいないときは、パソコン・スマホ側の設定に従う。
 *
 * 実際の色は globals.css の :root[data-theme="light"] で入れ替えている。
 * ここは <html> の目印を書き換えるだけ。
 */

export const THEME_KEY = "vis-theme";

type Theme = "light" | "dark";

function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle({ className }: { className?: string }) {
  // 最初の描画はサーバーと合わせる。実際の値は下の useEffect で読む。
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
      return;
    }
    setTheme(
      window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
    );
  }, []);

  const choose = (next: Theme) => {
    setTheme(next);
    apply(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // 記憶できなくても切り替えそのものは効く（プライベートブラウズなど）
    }
  };

  const btn = (value: Theme, label: string, Icon: typeof Sun) => {
    const on = theme === value;
    return (
      <button
        type="button"
        onClick={() => choose(value)}
        aria-label={label}
        aria-pressed={on}
        title={label}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full transition",
          on
            ? "bg-ink-950 text-gold-400 ring-2 ring-gold-500"
            : "text-ink-400 hover:text-ink-100",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    );
  };

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-900 p-1",
        className,
      )}
    >
      {btn("light", "明るい配色にする", Sun)}
      {btn("dark", "暗い配色にする", Moon)}
    </div>
  );
}
