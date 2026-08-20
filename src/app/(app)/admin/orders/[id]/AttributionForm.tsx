"use client";

import { useActionState, useState } from "react";
import {
  setOrderAttributionAction,
  type AttributionState,
} from "@/actions/attribution-actions";

/**
 * 受注の「売った代理店」を入れ直して、報酬を立て直す欄。
 *
 * 決済のときに ?ref= が届かなかった受注は、売上の付け先が空のまま入る。
 * この画面から代理店コードを1つ入れれば、所属をたどって
 * 2次・ゼロ次・紹介元まで組み立て直し、報酬を計上し直す。
 *
 * スタッフや取次パートナーのコードを入れても、決済のときと同じ扱いで
 * 所属先の会社に売上が付く。
 */
export function AttributionForm({
  id,
  current,
}: {
  id: string;
  current: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AttributionState, FormData>(
    setOrderAttributionAction,
    {},
  );

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:border-ink-600 hover:bg-ink-900"
        >
          {current ? "売った代理店を入れ直す" : "売った代理店を登録する"}
        </button>
        {state.ok ? <p className="mt-2 text-xs text-good-100">{state.ok}</p> : null}
        {state.error ? (
          <p className="mt-2 break-words text-xs text-bad-100">{state.error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={action} className="mt-3 max-w-md space-y-2 rounded-xl border border-ink-800 bg-ink-950/40 p-3">
      <input type="hidden" name="id" value={id} />
      <label className="block">
        <span className="text-xs text-ink-400">代理店コード</span>
        <input
          name="agencyCode"
          defaultValue={current}
          maxLength={20}
          placeholder="例：MENO0001"
          autoCapitalize="characters"
          spellCheck={false}
          className="tabnum mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm uppercase text-ink-100 placeholder:normal-case placeholder:text-ink-500 focus:border-ink-600"
        />
      </label>
      <p className="text-xs text-ink-500">
        スタッフや取次パートナーのコードでも構いません。決済のときと同じ決まりで、
        売上は所属先の会社に付き、2次・ゼロ次・紹介元まで自動でたどります。
        <strong className="text-ink-300">保存すると報酬を計上し直します</strong>
        （前に立てた分は取り消してから入れ直します）。
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存して報酬を立て直す"}
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
