"use client";

import { useActionState, useState } from "react";
import { dismissInboxAction, type InboxActionState } from "@/actions/inbox-actions";

/**
 * 受信箱の1件を「対応済み」にするボタン。
 *
 * 決済から届いたものは送り元から届き直さないので、取り込み直せない。
 * 本部が中身を見て手当てを終えたら、ここで片付ける。
 * 何をしたかを必ず書いてもらい、記録に残す。
 */
export function DismissButton({ id }: { id: number | string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    dismissInboxAction,
    {},
  );

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition hover:border-ink-600 hover:bg-ink-900"
        >
          対応済みにする
        </button>
        {state.ok ? <p className="mt-1 text-xs text-good-100">{state.ok}</p> : null}
      </div>
    );
  }

  return (
    <form action={action} className="w-56 space-y-1.5">
      <input type="hidden" name="id" value={String(id)} />
      <label className="block text-xs text-ink-400">どう手当てしたか（記録に残ります）</label>
      <input
        name="note"
        required
        maxLength={200}
        placeholder="例）受注の帰属を手で入れて報酬を計上した"
        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
      />
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:bg-ink-900 disabled:opacity-50"
        >
          {pending ? "保存中…" : "対応済みにする"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-900"
        >
          やめる
        </button>
      </div>
      {state.error ? <p className="break-words text-xs text-bad-100">{state.error}</p> : null}
      {state.ok ? <p className="text-xs text-good-100">{state.ok}</p> : null}
    </form>
  );
}
