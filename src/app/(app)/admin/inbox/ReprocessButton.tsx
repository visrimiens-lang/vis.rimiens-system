"use client";

import { useActionState } from "react";
import { reprocessInboxAction, type InboxActionState } from "@/actions/inbox-actions";

/**
 * 取り込めなかった申込を、もう一度取り込むボタン。
 *
 * 受信箱には届いた内容が丸ごと残っているので、
 * 取り出しの不具合を直したあとや、招待コードの取り違えを直したあとに、
 * 送り主にもう一度送ってもらわなくても本部の操作だけで取り込み直せる。
 */
export function ReprocessButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    reprocessInboxAction,
    {},
  );

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:border-ink-600 hover:bg-ink-900 disabled:opacity-50"
      >
        {pending ? "取り込み中…" : "もう一度取り込む"}
      </button>
      {state.ok ? (
        <p className="mt-1.5 text-xs text-good-100">{state.ok}</p>
      ) : null}
      {state.error ? (
        <p className="mt-1.5 break-words text-xs text-bad-100">{state.error}</p>
      ) : null}
    </form>
  );
}
