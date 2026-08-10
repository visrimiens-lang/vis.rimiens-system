"use client";

import { useActionState, useState } from "react";
import { KeyRound } from "lucide-react";
import { issuePasswordAction, type FormState } from "@/actions/auth-actions";
import { Notice } from "@/components/ui";

const initial: FormState = {};

export function IssuePassword({
  agencies,
}: {
  agencies: { code: string; name: string; hasPassword: boolean }[];
}) {
  const [state, run, pending] = useActionState(issuePasswordAction, initial);
  const [selected, setSelected] = useState("");

  const target = agencies.find((a) => a.code === selected);

  return (
    <div className="space-y-4 px-5 py-5">
      <p className="text-sm leading-relaxed text-ink-300">
        代理店がポータルにログインするためのパスワードを発行します。
        発行したパスワードは<strong className="text-ink-100">この画面に1度だけ</strong>
        表示されます。電話や本人のメールなど、確実に本人へ届く方法でお伝えください。
      </p>

      <form action={run} className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">
          <span className="text-xs font-medium tracking-wide text-ink-400">代理店</span>
          <select
            name="code"
            required
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none"
          >
            <option value="">選択してください</option>
            {agencies.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code}　{a.name}
                {a.hasPassword ? "（発行済み）" : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={pending || !selected}
          className="inline-flex items-center gap-2 rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          <KeyRound className="h-4 w-4" />
          {pending ? "発行中…" : "パスワードを発行"}
        </button>
      </form>

      {target?.hasPassword && !state.password ? (
        <Notice tone="warn">
          {target.name} には既にパスワードが発行されています。ここで再発行すると、
          いま使われているパスワードは使えなくなります。
        </Notice>
      ) : null}

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}

      {state.password ? (
        <div className="rounded-lg border border-gold-500/40 bg-gold-500/10 px-4 py-4">
          <div className="text-sm leading-relaxed text-gold-100">{state.ok}</div>
          <div className="mt-3 rounded-md border border-gold-500/30 bg-ink-950 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-400">
              パスワード
            </div>
            <div className="tabnum mt-1 font-mono text-lg font-semibold tracking-wider text-gold-300 select-all">
              {state.password}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
