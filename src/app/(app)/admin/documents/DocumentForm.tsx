"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  createDocumentAction,
  deleteDocumentAction,
  togglePublishAction,
  type DocumentActionState,
} from "@/actions/document-actions";
import { Notice } from "@/components/ui";

const initial: DocumentActionState = {};

const primaryBtn =
  "rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-3 py-1.5 text-xs font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60";

/** 画面に出すだけの簡易表示。細かい単位は本部側では要らない。 */
function megabytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/**
 * 資料を追加するフォーム。
 *
 * 上限を超えたファイルは送信前に止める。10MB を送ってから断られると
 * 待ち時間が無駄になるため。サーバー側でも同じ上限を見ている。
 */
export function DocumentForm({
  categories,
  maxBytes,
}: {
  categories: readonly string[];
  maxBytes: number;
}) {
  const [state, run, pending] = useActionState(createDocumentAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);

  // 追加できたら入力を空に戻す。続けて何枚も上げる使い方を想定している。
  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setPicked(null);
    }
  }, [state.ok, state.at]);

  const tooBig = picked !== null && picked.size > maxBytes;

  return (
    <form ref={formRef} action={run} className="space-y-4 px-5 py-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium tracking-wide text-ink-400">資料名</span>
          <input
            name="name"
            type="text"
            required
            maxLength={100}
            placeholder="例：VIS 販促チラシ（A4・2026年8月版）"
            disabled={pending}
            className={inputCls}
          />
          <span className="mt-1.5 block text-xs text-ink-500">
            代理店の画面にはこの名前で表示されます。
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-medium tracking-wide text-ink-400">カテゴリ</span>
          <select name="category" defaultValue={categories[0]} disabled={pending} className={inputCls}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-xs text-ink-500">
            代理店の資料ページは、このカテゴリごとに分かれて並びます。
          </span>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium tracking-wide text-ink-400">
          説明（任意）
        </span>
        <textarea
          name="description"
          rows={3}
          maxLength={1000}
          placeholder="例：店頭配布用のチラシです。印刷は各社でお願いします。"
          disabled={pending}
          className={`${inputCls} resize-y leading-relaxed`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium tracking-wide text-ink-400">ファイル</span>
        <input
          name="file"
          type="file"
          required
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            setPicked(f ? { name: f.name, size: f.size } : null);
          }}
          className="mt-1.5 block w-full cursor-pointer rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-200 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-100 hover:border-ink-600 disabled:opacity-60"
        />
        <span className="mt-1.5 block text-xs text-ink-500">
          PDF・画像・Word・Excel など。1ファイル {Math.round(maxBytes / 1024 / 1024)}MB まで。
        </span>
      </label>

      {picked ? (
        <p className={`text-xs ${tooBig ? "text-bad-100" : "text-ink-400"}`}>
          選択中: {picked.name}（{megabytes(picked.size)}）
        </p>
      ) : null}

      {tooBig ? (
        <Notice tone="bad">
          このファイルは {Math.round(maxBytes / 1024 / 1024)}MB を超えています。
          画像なら解像度を下げる、PDF なら分割するなどしてから、もう一度お選びください。
        </Notice>
      ) : null}

      <button type="submit" disabled={pending || tooBig} className={primaryBtn}>
        {pending ? "アップロード中…" : "この資料を追加する"}
      </button>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </form>
  );
}

/**
 * 一覧の各行の操作。公開/非公開の切り替えと削除。
 * 削除は取り消せないので、いったん確認を挟む。
 */
export function DocumentRowActions({
  id,
  name,
  published,
}: {
  id: string;
  name: string;
  published: boolean;
}) {
  const [toggleState, toggle, toggling] = useActionState(togglePublishAction, initial);
  const [deleteState, remove, removing] = useActionState(deleteDocumentAction, initial);
  const [confirming, setConfirming] = useState(false);

  const busy = toggling || removing;
  const gone = Boolean(deleteState.ok);
  const error = toggleState.error || deleteState.error;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center justify-end gap-2">
        <form action={toggle}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="publish" value={published ? "false" : "true"} />
          <button type="submit" disabled={busy || gone} className={quietBtn}>
            {toggling ? "変更中…" : published ? "非公開にする" : "公開する"}
          </button>
        </form>

        {confirming ? null : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || gone}
            className={quietBtn}
            aria-label={`${name || "この資料"}を削除する`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {confirming && !gone ? (
        <form action={remove} className="flex flex-wrap items-center justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <span className="text-xs text-ink-300">削除すると元に戻せません。</span>
          <button type="submit" disabled={busy} className={dangerBtn}>
            {removing ? "削除中…" : "はい、削除する"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className={quietBtn}
          >
            やめる
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="max-w-xs text-left">
          <Notice tone="bad">{error}</Notice>
        </div>
      ) : null}

      {!error && toggleState.ok ? (
        <p className="max-w-xs text-left text-xs leading-relaxed text-ink-400">
          {toggleState.ok}
        </p>
      ) : null}
    </div>
  );
}
