"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  requestPasswordResetAction,
  type ResetFormState,
} from "@/actions/reset-actions";

const initial: ResetFormState = {};

const fieldClass =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 placeholder:text-ink-600 focus:border-gold-500 focus:outline-none";
const labelClass = "text-xs font-medium tracking-wide text-ink-300";

/**
 * パスワード再発行の申し込み。ログイン不要。
 *
 * ここでパスワードを再設定させることはしない。代理店コードもメールアドレスも
 * 準公開情報のため、この画面に入力できたことは本人である証明にならない。
 * 受け付けるのは「申し込み」だけで、本人確認と発行は本部が行う。
 */
export default function ForgotPasswordPage() {
  const [state, submit, pending] = useActionState(
    requestPasswordResetAction,
    initial,
  );
  const sent = Boolean(state.ok);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-gold-500">
            眼筋トレーニングマシン
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-50">
            パスワードの再発行
          </h1>
        </div>

        <div className="rounded-xl border border-ink-800 bg-ink-900 p-6">
          {sent ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-gold-500/40 bg-gold-500/10 px-4 py-3.5 text-sm leading-relaxed text-gold-100">
                {state.ok}
              </div>
              <p className="text-sm leading-relaxed text-ink-300">
                本部からご連絡するまで、少しお時間をいただきます。
                お急ぎの場合は、本部までお電話でお問い合わせください。
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-ink-300">
                ポータルのパスワードは本部が発行してお渡ししています。
                下のご連絡先あてに、確認のうえ本部からお伝えします。
              </p>

              <form action={submit} className="mt-5 space-y-4">
                <label className="block">
                  <span className={labelClass}>代理店コード</span>
                  <input
                    name="code"
                    type="text"
                    required
                    maxLength={32}
                    placeholder="ABCD0001"
                    autoComplete="username"
                    className={fieldClass}
                  />
                </label>

                <label className="block">
                  <span className={labelClass}>
                    ご連絡先（お電話番号またはメールアドレス）
                  </span>
                  <input
                    name="contact"
                    type="text"
                    required
                    maxLength={200}
                    placeholder="090-0000-0000"
                    className={fieldClass}
                  />
                  <span className="mt-1.5 block text-xs leading-relaxed text-ink-400">
                    本部からこちらにご連絡します。代理店として登録済みのお電話番号か
                    メールアドレスをご入力ください。
                  </span>
                </label>

                <label className="block">
                  <span className={labelClass}>ご連絡事項（任意）</span>
                  <textarea
                    name="note"
                    rows={3}
                    maxLength={1000}
                    placeholder="ご担当者のお名前、連絡がつきやすい時間帯など"
                    className={`${fieldClass} resize-y`}
                  />
                </label>

                <button
                  type="submit"
                  disabled={pending}
                  className="w-full rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-60"
                >
                  {pending ? "送信中…" : "再発行を申し込む"}
                </button>
              </form>

              {state.error ? (
                <p className="mt-4 rounded-lg border border-bad-500/40 bg-bad-500/10 px-3.5 py-2.5 text-sm leading-relaxed text-bad-100">
                  {state.error}
                </p>
              ) : null}

              <p className="mt-5 border-t border-ink-800 pt-4 text-xs leading-relaxed text-ink-400">
                お申し込みの内容は本部が確認します。ご本人であることを確認できたあと、
                新しいパスワードをお伝えします。この画面でパスワードを設定することはできません。
              </p>
            </>
          )}

          <p className="mt-5 text-center text-sm">
            <Link
              href="/login"
              className="text-ink-300 underline underline-offset-4 transition hover:text-gold-300"
            >
              ログイン画面に戻る
            </Link>
          </p>
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink-600">
          目のトレーニング株式会社
        </p>
      </div>
    </main>
  );
}
