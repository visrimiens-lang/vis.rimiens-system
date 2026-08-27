"use client";

import { useActionState, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setPayUnitAction, type PayUnitState } from "@/actions/pay-unit-actions";
import { PAY_ITEMS, PAY_ITEM_HINT, PAY_ITEM_LABEL, type PayItem } from "@/lib/pay-items";

/**
 * 「この相手にいくら払うか」を品目ごとに決める欄。
 *
 * ■ なぜ品目ごとに分けたか
 *
 * 以前は1台あたりの額を1つだけ持っていたので、本体もオプションも同じ扱いだった。
 * 実際にはオプションの取り分は本体と別に決めるため、本体価格・OP①・OP②・
 * 1年後定期の4つを代理店ごとに持てるようにした（2026-08-27）。
 *
 * 受注1件の支払額は、その受注に含まれている品目の額を足して数量を掛ける
 * （lib/pay-defaults.ts の payoutForOrder）。
 *
 * ■ 空欄と 0 の違い
 *
 * 本体を空欄にするとランクの既定（3次 50,000／取次 25,000）に戻る。
 * OP①・OP②・1年後定期には既定を置いていないので、空欄は「払わない」。
 * わざと 0 円にしたいときは 0 と書く（空欄とは別に保存される）。
 *
 * 変えられるのは本部と直上の代理店だけ（判定はサーバー側の setPayUnitAction）。
 */

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

export function PayUnitCell({
  code,
  name,
  value,
  op1,
  op2,
  padYearly,
  fallback,
  note,
  editable,
}: {
  code: string;
  name: string;
  /** 本体価格。個別に決めてあれば数値、未設定なら null */
  value: number | null;
  op1: number | null;
  op2: number | null;
  padYearly: number | null;
  /** 本体が未設定のときに実際に使われる額（推奨の税抜単価。lib/pay-defaults.ts） */
  fallback: number | null;
  note: string;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PayUnitState, FormData>(setPayUnitAction, {});

  /*
   * モーダルは body の直下に出す。
   *
   * この欄は表の中にあり、表は横スクロールのために overflow を持っている
   * （components/ui.tsx の Table → .scroll-x）。そのまま置くと
   * position: fixed が効かず、モーダルが表の中に閉じ込められて見切れる。
   * サーバー側では document を触れないので、画面に出てから差し込む。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 開いている間は Esc で閉じられるようにし、背面が動かないようにする
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, [open]);

  const current: Record<PayItem, number | null> = {
    body: value,
    op1,
    op2,
    padYearly,
  };

  // 保存できたらモーダルを閉じる。控えの文言は閉じたあとの欄に出す。
  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  const bodyShown =
    value !== null ? yen(value) : fallback !== null ? yen(fallback) : "—";
  const extras = (["op1", "op2", "padYearly"] as PayItem[]).filter(
    (i) => current[i] !== null,
  );

  const summary = (
    <>
      <div className={value !== null ? "text-ink-100" : "text-ink-400"}>{bodyShown}</div>
      <div className="mt-0.5 text-xs text-ink-500">
        {value !== null ? "本体・個別に設定" : "本体・既定のまま"}
      </div>
      {extras.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {extras.map((i) => (
            <div key={i} className="text-xs text-ink-400">
              {PAY_ITEM_LABEL[i]} {yen(current[i] as number)}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  if (!editable) return <div>{summary}</div>;

  return (
    <div>
      {/* print-keep：紙では押せないが、金額そのものは残す（globals.css の @media print） */}
      <div className="print-keep">{summary}</div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 rounded-lg border border-ink-700 px-2.5 py-1 text-xs text-ink-200 transition hover:bg-ink-900"
      >
        金額修正
      </button>
      {state.ok ? <div className="mt-1 text-xs text-good-100">{state.ok}</div> : null}

      {open && mounted
        ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={`${name} に払う額`}
        >
          {/* 背景を押したら閉じる。中身を押したときは閉じない。 */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default"
          />
          <form
            action={action}
            className="relative my-auto max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-2xl border border-ink-700 bg-ink-950 p-5 text-left shadow-2xl"
          >
            <input type="hidden" name="code" value={code} />

            <div>
              <h2 className="text-base font-semibold text-ink-50">
                {name} に払う額
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-400">
                受注に含まれている品目の額を足して、数量を掛けたものがお支払額になります。
                金額はすべて税抜きです（支払通知書が小計に消費税を足します）。
              </p>
            </div>

            <div className="space-y-3">
              {PAY_ITEMS.map((item) => (
                <label key={item} className="block">
                  <span className="text-xs font-medium text-ink-200">
                    {PAY_ITEM_LABEL[item]}
                    <span className="ml-1.5 font-normal text-ink-500">
                      {PAY_ITEM_HINT[item]}
                    </span>
                  </span>
                  <input
                    name={
                      item === "body"
                        ? "amount"
                        : item === "op1"
                          ? "amountOp1"
                          : item === "op2"
                            ? "amountOp2"
                            : "amountPadYearly"
                    }
                    inputMode="numeric"
                    defaultValue={current[item] !== null ? String(current[item]) : ""}
                    placeholder={
                      item === "body"
                        ? fallback !== null
                          ? `空欄なら ${fallback.toLocaleString("ja-JP")}（既定）`
                          : "空欄なら既定"
                        : "空欄ならこの品目では払わない"
                    }
                    className="tabnum mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
                  />
                </label>
              ))}

              <label className="block">
                <span className="text-xs font-medium text-ink-200">理由</span>
                <input
                  name="note"
                  defaultValue={note}
                  maxLength={200}
                  placeholder="インボイス未登録 など"
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-600"
                />
              </label>
            </div>

            <p className="text-xs leading-relaxed text-ink-500">
              本体を空にすると既定に戻ります。OP①・OP②・1年後定期を空にすると、
              その品目では払わない扱いになります。0 円にしたいときは 0 と入れてください。
              <br />
              本部の報酬台帳はさかのぼって変わりませんが、「売上・報酬」のお支払額の表示は、
              過去の月もいまの額で計算し直されます。
            </p>

            {state.error ? (
              <p className="break-words text-xs text-bad-100">{state.error}</p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-300 transition hover:bg-ink-900"
              >
                やめる
              </button>
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:opacity-50"
              >
                {pending ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}
