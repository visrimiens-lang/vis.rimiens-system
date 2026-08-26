"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type FormState } from "@/actions/auth-actions";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

const initial: FormState = {};

export default function LoginPage() {
  const [state, doLogin, pending] = useActionState(loginAction, initial);

  return (
    <main className="relative flex min-h-screen items-center justify-center px-6 py-12">
      {/* ログインの画面でも配色を選べるようにしておく（明るい部屋で使う方のため） */}
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-gold-500">
            眼筋トレーニングマシン
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-50">
            VIS 代理店ポータル
          </h1>
        </div>

        <div className="rounded-xl border border-ink-800 bg-ink-900 p-6">
          <form action={doLogin} className="space-y-4">
            <label className="block">
              <span className="text-xs font-medium tracking-wide text-ink-300">
                代理店コード
              </span>
              <input
                name="loginId"
                type="text"
                required
                placeholder="ABCD0001"
                autoComplete="username"
                className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 placeholder:text-ink-600 focus:border-gold-500 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium tracking-wide text-ink-300">
                パスワード
              </span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none"
              />
            </label>

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:opacity-60"
            >
              {pending ? "確認中…" : "ログイン"}
            </button>
          </form>

          {state.error ? (
            <p className="mt-4 rounded-lg border border-bad-500/40 bg-bad-500/10 px-3.5 py-2.5 text-sm leading-relaxed text-bad-100">
              {state.error}
            </p>
          ) : null}

          <p className="mt-4 text-center text-sm">
            <Link
              href="/forgot-password"
              className="text-ink-300 underline underline-offset-4 transition hover:text-gold-300"
            >
              パスワードをお忘れの方
            </Link>
          </p>

          <p className="mt-5 border-t border-ink-800 pt-4 text-xs leading-relaxed text-ink-400">
            はじめてご利用の方へ。パスワードは本部が発行してお渡しします。
            まだお持ちでない場合は本部にご連絡ください。
          </p>
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink-600">
          目のトレーニング株式会社
        </p>
      </div>
    </main>
  );
}
