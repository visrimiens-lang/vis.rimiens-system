"use client";

import { useActionState } from "react";
import { setOrgCodeAction, type OrgCodeState } from "@/actions/org-code-actions";

/**
 * 会社に自社代理店コード（組織の英字4文字）を設定する欄。
 *
 * 2026-08-20 から、申込フォームに「自社代理店コード発行」の欄ができた。
 * それより前に登録した会社は英字を持っていないので、ここで後から設定する。
 *
 * 代理店コードそのものは変えない。すでにお渡ししたQRとログインIDが
 * 使えなくなるため（詳しくは actions/org-code-actions.ts）。
 */
export function OrgCodeForm({
  code,
  name,
  current,
}: {
  code: string;
  name: string;
  current: string;
}) {
  const [state, action, pending] = useActionState<OrgCodeState, FormData>(setOrgCodeAction, {});

  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-ink-300">
        {current ? (
          <>
            いまの自社代理店コードは <strong className="tabnum text-ink-100">{current}</strong> です。
            {name} の取次パートナー・スタッフは{" "}
            <code className="tabnum text-ink-100">{current}0001</code> の形で採番されます。
          </>
        ) : (
          <>
            自社代理店コードがまだ決まっていません。設定すると、この会社の取次パートナー・
            スタッフが「英字＋4桁」で採番されるようになり、その方は申込フォームの
            「自社コード」欄にこの英字を入れるだけで登録できます。
          </>
        )}
      </p>

      <input type="hidden" name="code" value={code} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-400">自社代理店コード</span>
          <input
            name="orgCode"
            defaultValue={current}
            maxLength={6}
            placeholder="例：MENO"
            autoCapitalize="characters"
            spellCheck={false}
            className="tabnum w-40 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm uppercase tracking-widest text-ink-100 placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-500 focus:border-ink-600"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存"}
        </button>
      </div>

      <p className="text-xs text-ink-500">
        半角大文字のアルファベット4文字（例 目のトレーニング株式会社 → MENO）。
        小文字や全角で入れても大文字に直します。同じ英字を2社では使えません。
        <strong className="text-ink-300">代理店コードとログインIDは変わりません。</strong>
      </p>

      {state.error ? <p className="break-words text-sm text-bad-100">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-good-100">{state.ok}</p> : null}
    </form>
  );
}
