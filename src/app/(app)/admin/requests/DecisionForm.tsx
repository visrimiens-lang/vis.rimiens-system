"use client";

import { useActionState, useState } from "react";
import {
  approveAction,
  rejectAction,
  type AdminSlotActionState,
} from "@/actions/admin-slot-actions";
import { Notice } from "@/components/ui";

const initial: AdminSlotActionState = {};

const primaryBtn =
  "rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 承認 / 却下の操作。
 * 承認は「新しい上限」を数字で入れてから押す（既定は 現在の上限 + 10 社）。
 * 却下は押し間違いを防ぐため、いったん確認を挟む。
 */
export function DecisionForm({
  recordId,
  suggestedLimit,
  minLimit,
}: {
  recordId: string;
  /** 数値入力の初期値。現在の上限 + 10 社。 */
  suggestedLimit: number;
  /** すでに登録されている社数。これより小さい上限にはできない。 */
  minLimit: number;
}) {
  const [approveState, approve, approving] = useActionState(approveAction, initial);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, initial);
  const [confirming, setConfirming] = useState(false);

  const busy = approving || rejecting;
  const done = Boolean(approveState.ok || rejectState.ok);
  const error = approveState.error || rejectState.error;
  const ok = approveState.ok || rejectState.ok;

  return (
    <div className="border-t border-ink-800 px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <form action={approve} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="recordId" value={recordId} />
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
              新しい上限
            </span>
            <span className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                name="newLimit"
                defaultValue={suggestedLimit}
                min={Math.max(1, minLimit)}
                max={200}
                step={1}
                inputMode="numeric"
                disabled={busy || done}
                className="tabnum w-24 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-50 transition hover:border-ink-600 disabled:opacity-60"
              />
              <span className="text-sm text-ink-400">社</span>
            </span>
          </label>
          <button type="submit" disabled={busy || done} className={primaryBtn}>
            {approving ? "承認中…" : "承認する"}
          </button>
        </form>

        {confirming ? (
          <form action={reject} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="recordId" value={recordId} />
            <span className="text-sm text-ink-300">この申請を却下しますか？</span>
            <button type="submit" disabled={busy || done} className={dangerBtn}>
              {rejecting ? "却下中…" : "はい、却下する"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy || done}
              className={quietBtn}
            >
              やめる
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || done}
            className={quietBtn}
          >
            却下する
          </button>
        )}
      </div>

      {error ? (
        <div className="mt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}

      {ok ? (
        <div className="mt-3">
          <Notice tone="info">{ok}</Notice>
        </div>
      ) : null}

      {!error && !ok ? (
        <p className="mt-2.5 text-xs leading-relaxed text-ink-400">
          既定は「現在の上限 + 10 社」です。承認すると、この代理店はすぐに新しい枠まで登録できるようになります。
          却下しても上限は変わらず、代理店はあらためて申請できます。
        </p>
      ) : null}
    </div>
  );
}
