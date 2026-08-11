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
  "rounded-lg bg-gold-500 px-3 py-2 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-3 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabel =
  "text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400";
const inputCls =
  "mt-1 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-sm text-ink-50 transition hover:border-ink-600 disabled:opacity-60";

/** 承認するときに選べる枠。値はデータベースの販路種別の文字列そのまま。 */
export type DecisionKind = {
  /** データベースに保存されている販路種別（サーバー側で照合する） */
  key: string;
  /** 画面に出す呼び方 */
  label: string;
  /** いまの上限 */
  limit: number;
  /** いま埋まっている数 */
  used: number;
  /** 上限まで埋まっているか */
  isFull: boolean;
};

/**
 * 一覧の各行に置く「承認 / 却下」の操作。
 *
 * ・申請そのものには「どの枠か」が入っていない（データベースの申請欄は
 *   申請中／承認済／却下の3値だけ）。そこで本部が枠を選んでから承認する。
 * ・選んだ枠に合わせて「新しい上限」の初期値（いまの上限 + 10）と
 *   下限（すでに埋まっている数）が入れ替わる。
 * ・却下は押し間違いを防ぐため、いったん確認を挟む。
 */
export function DecisionForm({
  recordId,
  kinds,
  defaultKind,
  note,
}: {
  recordId: string;
  /** 選べる枠の一覧。並び順がそのまま選択肢の順になる */
  kinds: DecisionKind[];
  /** 最初に選んでおく枠（満枠になっているものがあればそれ） */
  defaultKind: string;
  /** 枠の考え方が違う相手（総販売代理店）のときに添える補足 */
  note?: string;
}) {
  const [approveState, approve, approving] = useActionState(approveAction, initial);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, initial);
  const [kind, setKind] = useState(defaultKind);
  const [confirming, setConfirming] = useState(false);

  const busy = approving || rejecting;
  const done = Boolean(approveState.ok || rejectState.ok);
  const error = approveState.error || rejectState.error;
  const ok = approveState.ok || rejectState.ok;

  const current = kinds.find((k) => k.key === kind) ?? kinds[0];
  const suggested = current ? current.limit + 10 : 10;
  const minLimit = current ? Math.max(1, current.used) : 1;

  return (
    <div className="min-w-[17rem]">
      <div className="flex flex-wrap items-end gap-2">
        <form action={approve} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="recordId" value={recordId} />

          <label className="block">
            <span className={fieldLabel}>増やす枠</span>
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={busy || done}
              className={`${inputCls} block w-44`}
            >
              {kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label} {k.used}/{k.limit}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className={fieldLabel}>新しい上限</span>
            <span className="mt-1 flex items-center gap-1.5">
              {/* 枠を選び直したら初期値も入れ替える（key を変えて作り直す） */}
              <input
                key={`limit:${kind}`}
                type="number"
                name="newLimit"
                defaultValue={suggested}
                min={minLimit}
                max={200}
                step={1}
                inputMode="numeric"
                disabled={busy || done}
                className={`tabnum w-16 ${inputCls}`}
              />
              <span className="text-sm text-ink-400">社</span>
            </span>
          </label>

          <button type="submit" disabled={busy || done} className={primaryBtn}>
            {approving ? "承認中…" : "承認"}
          </button>
        </form>

        {confirming ? (
          <form action={reject} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="recordId" value={recordId} />
            <span className="text-sm text-ink-300">却下しますか？</span>
            <button type="submit" disabled={busy || done} className={dangerBtn}>
              {rejecting ? "却下中…" : "はい"}
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
            却下
          </button>
        )}
      </div>

      {error ? (
        <div className="mt-2.5">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}

      {ok ? (
        <div className="mt-2.5">
          <Notice tone="info">{ok}</Notice>
        </div>
      ) : null}

      {!error && !ok && note ? (
        <p className="mt-2 max-w-md text-xs leading-relaxed text-warn-100">{note}</p>
      ) : null}
    </div>
  );
}
