"use client";

import { useActionState } from "react";
import { changePasswordAction, type FormState } from "@/actions/auth-actions";
import { Notice } from "@/components/ui";

const initial: FormState = {};

function Field({
  label,
  name,
  hint,
}: {
  label: string;
  name: string;
  hint?: string;
}) {
  return (
    <label className="block max-w-sm">
      <span className="text-xs font-medium tracking-wide text-ink-400">{label}</span>
      <input
        name={name}
        type="password"
        required
        autoComplete="new-password"
        className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none"
      />
      {hint ? <span className="mt-1.5 block text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

export function PasswordForm() {
  const [state, run, pending] = useActionState(changePasswordAction, initial);

  return (
    <form action={run} className="space-y-4 px-5 py-5">
      <Field label="現在のパスワード" name="current" />
      <Field
        label="新しいパスワード"
        name="next"
        hint="10文字以上。代理店コードは含められません。"
      />
      <Field label="新しいパスワード（確認）" name="confirm" />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:opacity-60"
      >
        {pending ? "変更中…" : "パスワードを変更する"}
      </button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </form>
  );
}
