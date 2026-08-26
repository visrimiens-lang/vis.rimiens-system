"use client";

import { useActionState, useState } from "react";
import {
  createNoticeAction,
  deleteNoticeAction,
  updateNoticeAction,
  type NoticeFormState,
} from "@/actions/notice-actions";
import { Badge, Notice } from "@/components/ui";
import type { AdminNotice } from "@/lib/content-admin";

const initial: NoticeFormState = {};

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";

const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

function Check({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 shrink-0 accent-gold-500 disabled:opacity-60"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink-100">{label}</span>
        <span className="block text-xs leading-relaxed text-ink-500">{hint}</span>
      </span>
    </label>
  );
}

/** 新規・修正で共通の入力欄。 */
function Fields({
  notice,
  defaultDate,
  disabled,
}: {
  notice?: AdminNotice;
  /** 新規のときに公開日へ入れておく日付（日本時間の今日）。 */
  defaultDate: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      <label className="block">
        <span className={labelCls}>タイトル</span>
        <input
          type="text"
          name="title"
          required
          maxLength={120}
          defaultValue={notice?.title ?? ""}
          disabled={disabled}
          placeholder="例）9月の販促キャンペーンについて"
          className={inputCls}
        />
        <span className={hintCls}>一覧に太字で並びます。ひと目で用件が分かる短い文にしてください。</span>
      </label>

      <label className="block">
        <span className={labelCls}>本文</span>
        <textarea
          name="body"
          rows={6}
          maxLength={4000}
          defaultValue={notice?.body ?? ""}
          disabled={disabled}
          placeholder="代理店の皆さまにお伝えする内容をそのままご記入ください。改行はそのまま表示されます。"
          className={`${inputCls} resize-y leading-relaxed`}
        />
        <span className={hintCls}>改行はそのまま表示されます。空欄のままでも登録できます。</span>
      </label>

      <label className="block max-w-xs">
        <span className={labelCls}>公開日</span>
        <input
          type="date"
          name="publishedAt"
          defaultValue={notice ? notice.publishedAt : defaultDate}
          disabled={disabled}
          className={`${inputCls} tabnum`}
        />
        <span className={hintCls}>
          一覧の並び順に使います。日付を先の日にしても、公開すればすぐ表示されます。
        </span>
      </label>

      <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-950/60 px-4 py-3.5">
        <Check
          name="important"
          label="重要なお知らせにする"
          hint="金色の「重要」が付き、代理店の画面で一覧の先頭に固定されます。"
          defaultChecked={notice?.important ?? false}
          disabled={disabled}
        />
        <Check
          name="published"
          label="代理店に公開する"
          hint="外すと下書きになり、本部だけが見られます。書きかけを保存したいときに使ってください。"
          defaultChecked={notice ? notice.published : true}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/** 新しいお知らせを登録するフォーム。 */
export function NoticeForm({ defaultDate }: { defaultDate: string }) {
  const [state, run, pending] = useActionState(createNoticeAction, initial);

  return (
    <div className="space-y-4 px-5 py-5">
      {/* 登録に成功したら key が変わり、入力欄が空に戻る */}
      <form key={state.savedAt ?? 0} action={run} className="space-y-4">
        <Fields defaultDate={defaultDate} disabled={pending} />
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "登録中…" : "このお知らせを登録する"}
        </button>
      </form>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </div>
  );
}

/**
 * 一覧の1件ぶん。「編集」を押すと同じ入力欄がその場で開く。
 * 削除は押し間違いを防ぐため、いったん確認を挟む。
 */
export function NoticeRow({
  notice,
  dateLabel,
  defaultDate,
}: {
  notice: AdminNotice;
  /** 「2026年8月10日」のように整形済みの公開日。 */
  dateLabel: string;
  defaultDate: string;
}) {
  const [editState, save, saving] = useActionState(updateNoticeAction, initial);
  const [deleteState, remove, removing] = useActionState(deleteNoticeAction, initial);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const busy = saving || removing;
  const deleted = Boolean(deleteState.ok);

  return (
    <li className="px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {notice.important ? <Badge tone="gold">重要</Badge> : null}
          {notice.published ? (
            <Badge tone="good">公開中</Badge>
          ) : (
            <Badge tone="neutral">下書き</Badge>
          )}
          <h3 className="min-w-0 text-sm font-semibold text-ink-50">
            {notice.title || "（タイトル未設定）"}
          </h3>
        </div>
        <div className="tabnum shrink-0 text-xs text-ink-400">{dateLabel}</div>
      </div>

      {notice.body ? (
        <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-300">
          {notice.body}
        </p>
      ) : (
        <p className="mt-2.5 text-sm text-ink-500">本文は入力されていません。</p>
      )}

      {deleted ? (
        <div className="mt-3">
          <Notice tone="info">{deleteState.ok}</Notice>
        </div>
      ) : (
        <>
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                setConfirming(false);
              }}
              disabled={busy}
              className={quietBtn}
            >
              {editing ? "編集をやめる" : "編集する"}
            </button>

            {confirming ? (
              <form action={remove} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={notice.id} />
                <span className="text-sm text-ink-300">
                  このお知らせを削除しますか？元に戻せません。
                </span>
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
            ) : (
              <button
                type="button"
                onClick={() => {
                  setConfirming(true);
                  setEditing(false);
                }}
                disabled={busy}
                className={quietBtn}
              >
                削除する
              </button>
            )}
          </div>

          {deleteState.error ? (
            <div className="mt-3">
              <Notice tone="bad">{deleteState.error}</Notice>
            </div>
          ) : null}

          {editing ? (
            <div className="mt-4 rounded-xl border border-ink-800 bg-ink-950/40 px-4 py-4">
              <form action={save} className="space-y-4">
                <input type="hidden" name="id" value={notice.id} />
                <Fields notice={notice} defaultDate={defaultDate} disabled={busy} />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={busy} className={primaryBtn}>
                    {saving ? "保存中…" : "変更を保存する"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                    className={quietBtn}
                  >
                    閉じる
                  </button>
                </div>
              </form>

              {editState.error ? (
                <div className="mt-3">
                  <Notice tone="bad">{editState.error}</Notice>
                </div>
              ) : null}
              {editState.ok ? (
                <div className="mt-3">
                  <Notice tone="info">{editState.ok}</Notice>
                </div>
              ) : null}
            </div>
          ) : null}

          {!editing && editState.ok ? (
            <div className="mt-3">
              <Notice tone="info">{editState.ok}</Notice>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
