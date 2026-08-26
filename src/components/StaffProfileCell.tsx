"use client";

import { useActionState, useState } from "react";
import {
  setStaffProfileAction,
  type StaffProfileState,
} from "@/actions/staff-profile-actions";
import { STAFF_TYPES } from "@/lib/labels";

/**
 * スタッフの「所属会社名」と「種別」を、一覧の行の中でそのまま直せる欄。
 *
 * 2026-08-22 から、エリア統括代理店の下は全員スタッフとして
 * 統括の4文字コード＋4桁で登録する。誰がどの会社の人かは
 * 申込フォームからは分からないので、ここで統括自身が設定する。
 *
 * 変えられるのは本部と所属先の代理店だけ（判定はサーバー側の setStaffProfileAction）。
 * 変えられない相手には文字だけ出す。
 */
export function StaffProfileCell({
  code,
  name,
  companyName,
  staffType,
  /** 所属会社名が空のときに、代わりにうすく出す名前（上位代理店の名前） */
  fallbackName,
  editable,
}: {
  code: string;
  name: string;
  companyName: string;
  staffType: string;
  fallbackName?: string;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<StaffProfileState, FormData>(
    setStaffProfileAction,
    {},
  );

  const shownCompany = companyName || fallbackName || "";
  const body = (
    <>
      <div className={companyName ? "text-ink-100" : "text-ink-400"}>
        {shownCompany || "所属を設定してください"}
      </div>
      <div className="mt-0.5 text-xs text-ink-500">{staffType || "種別 未設定"}</div>
    </>
  );

  if (!editable) return <div>{body}</div>;

  if (!open) {
    return (
      /* print-keep：紙では押せないが、所属会社と種別は残す（globals.css の @media print） */
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="print-keep text-left underline decoration-dotted underline-offset-4"
        title="押すと変えられます"
      >
        {body}
        {state.ok ? <div className="mt-1 text-xs text-good-100">{state.ok}</div> : null}
      </button>
    );
  }

  return (
    <form action={action} className="w-56 space-y-1.5">
      <input type="hidden" name="code" value={code} />
      <label className="block text-xs text-ink-400">{name} の所属会社名</label>
      <input
        name="companyName"
        defaultValue={companyName}
        maxLength={100}
        placeholder="例：○○商事株式会社（個人の方は空欄）"
        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
      />
      <label className="block text-xs text-ink-400">種別</label>
      <select
        name="staffType"
        defaultValue={staffType}
        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100 focus:border-ink-600"
      >
        <option value="">未設定</option>
        {STAFF_TYPES.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
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
        報酬の明細を、この会社名でまとめて見られるようになります。
      </p>
      {state.error ? (
        <p className="break-words text-xs text-bad-100">{state.error}</p>
      ) : null}
      {state.ok ? <p className="text-xs text-good-100">{state.ok}</p> : null}
    </form>
  );
}
