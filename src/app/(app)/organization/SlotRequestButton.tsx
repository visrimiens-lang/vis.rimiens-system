"use client";

import { useActionState } from "react";
import { requestSlotIncreaseAction, type SlotActionState } from "@/actions/slot-actions";
import { Notice } from "@/components/ui";

const initial: SlotActionState = {};

/**
 * 増枠申請ボタン。
 * すでに申請中のときは押せない。結果は useActionState でその場に出す。
 */
export function SlotRequestButton({ alreadyRequested }: { alreadyRequested: boolean }) {
  const [state, submit, pending] = useActionState(requestSlotIncreaseAction, initial);
  const sent = Boolean(state.ok);
  const disabled = alreadyRequested || sent || pending;

  return (
    <div className="w-full sm:w-72">
      <form action={submit}>
        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300"
        >
          {pending
            ? "送信中…"
            : alreadyRequested || sent
              ? "申請中です"
              : "増枠を申請する"}
        </button>
      </form>

      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}

      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}

      {!state.error && !state.ok ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          {alreadyRequested
            ? "本部の確認が終わるまで、次の申請はできません。"
            : "本部が内容を確認したうえで、枠の上限を変更します。"}
        </p>
      ) : null}
    </div>
  );
}
