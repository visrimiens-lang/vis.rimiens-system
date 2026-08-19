"use client";

import { useActionState, useState } from "react";
import { freezeQrAction, unfreezeQrAction, type QrActionState } from "@/actions/qr-actions";

/**
 * スタッフ一覧から、そのスタッフのQRを止める／戻すためのボタン。
 *
 * 止めると当システムからのご案内（QR1・QR2）が消え、
 * QR2 の発行申請は「差戻し」に戻る。稼働状況は変えないので、
 * ポータルには入れて売上や報酬の確認は続けられる。
 *
 * ★ すでにお渡し済み・印刷済みのQRは、読み取り先が当システムの外
 *   （公式LINE・決済フォーム）にあるため、この操作では読み取れなくならない。
 *   回収とお客様へのご連絡は別途必要。画面にもそう書いてある。
 */
export function StopButton({
  code,
  name,
  frozen,
}: {
  code: string;
  name: string;
  frozen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [freezeState, freeze, freezing] = useActionState<QrActionState, FormData>(
    freezeQrAction,
    {},
  );
  const [unfreezeState, unfreeze, unfreezing] = useActionState<QrActionState, FormData>(
    unfreezeQrAction,
    {},
  );
  const state = frozen ? unfreezeState : freezeState;

  if (frozen) {
    return (
      <form action={unfreeze}>
        <input type="hidden" name="code" value={code} />
        <button
          type="submit"
          disabled={unfreezing}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:border-ink-600 hover:bg-ink-900 disabled:opacity-50"
        >
          {unfreezing ? "戻しています…" : "利用を再開する"}
        </button>
        {state.error ? (
          <p className="mt-1 break-words text-xs text-bad-100">{state.error}</p>
        ) : null}
        {state.ok ? <p className="mt-1 text-xs text-good-100">{state.ok}</p> : null}
      </form>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-bad-400/40 px-3 py-1.5 text-xs text-bad-100 transition hover:border-bad-400/70 hover:bg-bad-500/10"
      >
        QRを止める
      </button>
    );
  }

  return (
    <form action={freeze} className="w-56 space-y-1.5">
      <input type="hidden" name="code" value={code} />
      <label className="block text-xs text-ink-400">
        止める理由（記録に残ります）
      </label>
      <input
        name="reason"
        required
        maxLength={200}
        placeholder={`例）${name} さんの利用停止`}
        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
      />
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={freezing}
          className="rounded-lg border border-bad-400/40 px-3 py-1.5 text-xs text-bad-100 transition hover:bg-bad-500/10 disabled:opacity-50"
        >
          {freezing ? "止めています…" : "止める"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-900"
        >
          やめる
        </button>
      </div>
      {state.error ? (
        <p className="break-words text-xs text-bad-100">{state.error}</p>
      ) : null}
      {state.ok ? <p className="text-xs text-good-100">{state.ok}</p> : null}
    </form>
  );
}
