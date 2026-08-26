"use client";

import { useActionState } from "react";
import { updateContactAction, type ContactState } from "@/actions/contact-actions";
import { Notice } from "@/components/ui";

const initial: ContactState = {};

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm " +
  "text-ink-50 placeholder:text-ink-500 focus:border-gold-500 focus:outline-none";

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  hint,
  width = "max-w-sm",
  inputMode,
}: {
  label: string;
  name: string;
  defaultValue: string;
  placeholder?: string;
  hint?: string;
  width?: string;
  inputMode?: "tel" | "numeric";
}) {
  return (
    <label className={`block ${width}`}>
      <span className="text-xs font-medium tracking-wide text-ink-400">{label}</span>
      <input
        name={name}
        type="text"
        inputMode={inputMode}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={inputCls}
      />
      {hint ? <span className="mt-1.5 block text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

/**
 * 連絡先（郵便番号・住所・電話番号）の変更。
 *
 * 空のまま保存すると、その欄は未登録に戻る。
 * 変えていない欄はそのまま残るよう、いまの値を初期値に入れてある。
 */
export function ContactForm({
  zip,
  address,
  phone,
}: {
  zip: string;
  address: string;
  phone: string;
}) {
  const [state, run, pending] = useActionState(updateContactAction, initial);

  return (
    <form action={run} className="space-y-4 px-5 py-5">
      <Field
        label="郵便番号"
        name="zip"
        defaultValue={zip}
        placeholder="150-0043"
        inputMode="numeric"
        width="max-w-[12rem]"
      />
      <Field
        label="住所"
        name="address"
        defaultValue={address}
        placeholder="東京都渋谷区道玄坂1-18-5"
        width="max-w-xl"
        hint="建物名・部屋番号まで入れてください。"
      />
      <Field
        label="電話番号"
        name="phone"
        defaultValue={phone}
        placeholder="03-6455-3655"
        inputMode="tel"
        width="max-w-xs"
      />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:opacity-60"
      >
        {pending ? "保存中…" : "連絡先を保存する"}
      </button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </form>
  );
}
