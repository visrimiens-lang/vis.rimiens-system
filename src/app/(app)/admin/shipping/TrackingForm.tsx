"use client";

import { useActionState } from "react";
import { ClipboardPaste } from "lucide-react";
import { importTrackingAction, type TrackingState } from "@/actions/yamato-actions";
import { Notice } from "@/components/ui";

const initial: TrackingState = {};

/**
 * B2クラウドで発行した伝票番号を貼り付けて、受注に入れる。
 *
 * APIの認証キーが揃うまでは、CSVを書き出して → B2クラウドで発行 →
 * 発行結果をここに貼る、という流れで運用する。
 * 貼る形は決め打ちにしていない（B2の出力をそのままでも、2列だけでも通る）。
 */
export function TrackingForm() {
  const [state, run, pending] = useActionState(importTrackingAction, initial);

  return (
    <form action={run} className="space-y-3 px-5 py-4">
      <textarea
        name="tracking"
        rows={6}
        required
        disabled={pending}
        placeholder={"123,456789012345\n124,456789012346\n（B2クラウドの発行結果をそのまま貼っても読み取れます）"}
        className="w-full rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ClipboardPaste className="h-4 w-4" />
          {pending ? "入れています…" : "伝票番号を受注に入れる"}
        </button>
        <span className="text-xs text-ink-400">
          すでに別の伝票番号が入っている受注は、上書きせずにお知らせします。
        </span>
      </div>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
      {state.problems && state.problems.length > 0 ? (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm">
          <ul className="space-y-1.5">
            {state.problems.map((p, i) => (
              <li key={i} className="text-warn-100">
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
