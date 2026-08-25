"use client";

import { useActionState, useState } from "react";
import { setPayUnitAction, type PayUnitState } from "@/actions/pay-unit-actions";

/**
 * 「この相手にいくら払うか」を、一覧の行の中でそのまま直せる欄。
 *
 * 既定（推奨の税抜単価。lib/pay-defaults.ts）のときは既定の額をうすく出し、
 * 個別に決めてあるときはその額をはっきり出す。
 * 空にして保存すると既定に戻る。
 *
 * 変えられるのは本部と直上の代理店だけ（判定はサーバー側の setPayUnitAction）。
 * 変えられない相手には数字だけ出す。
 */
export function PayUnitCell({
  code,
  name,
  value,
  fallback,
  note,
  editable,
}: {
  code: string;
  name: string;
  /** 個別に決めてある額。未設定なら null */
  value: number | null;
  /** 未設定のときに実際に使われる額（推奨の税抜単価。lib/pay-defaults.ts） */
  fallback: number | null;
  note: string;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PayUnitState, FormData>(setPayUnitAction, {});

  const shown =
    value !== null
      ? `¥${value.toLocaleString("ja-JP")}`
      : fallback !== null
        ? `¥${fallback.toLocaleString("ja-JP")}`
        : "—";

  if (!editable) {
    return (
      <div>
        <div className={value !== null ? "text-ink-100" : "text-ink-400"}>{shown}</div>
        {value !== null ? (
          <div className="mt-0.5 text-xs text-gold-500">個別</div>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left"
        title="押すと変えられます"
      >
        <div
          className={
            value !== null
              ? "underline decoration-dotted underline-offset-4 text-ink-100"
              : "underline decoration-dotted underline-offset-4 text-ink-400"
          }
        >
          {shown}
        </div>
        <div className="mt-0.5 text-xs text-ink-500">
          {value !== null ? "個別に設定" : "既定のまま"}
        </div>
        {state.ok ? <div className="mt-1 text-xs text-good-100">{state.ok}</div> : null}
      </button>
    );
  }

  return (
    <form action={action} className="w-52 space-y-1.5">
      <input type="hidden" name="code" value={code} />
      <label className="block text-xs text-ink-400">
        {name} に払う額（1台あたり・税抜き）
      </label>
      <input
        name="amount"
        inputMode="numeric"
        defaultValue={value !== null ? String(value) : ""}
        placeholder={fallback !== null ? `空欄なら ${fallback.toLocaleString("ja-JP")}` : "空欄なら既定"}
        className="tabnum w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
      />
      <input
        name="note"
        defaultValue={note}
        maxLength={200}
        placeholder="理由（インボイス未登録 など）"
        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
      />
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:bg-ink-900"
        >
          やめる
        </button>
      </div>
      <p className="text-xs text-ink-500">
        空にすると既定に戻ります。本部の報酬台帳はさかのぼって変わりませんが、
        「売上・報酬」のお支払額の表示は、過去の月もいまの額で計算し直されます。
      </p>
      {state.error ? (
        <p className="break-words text-xs text-bad-100">{state.error}</p>
      ) : null}
      {state.ok ? <p className="text-xs text-good-100">{state.ok}</p> : null}
    </form>
  );
}
