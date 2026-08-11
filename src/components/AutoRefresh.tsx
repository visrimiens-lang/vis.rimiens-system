"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";

/* ------------------------------------------------------------------
 * 画面をひとりでに新しくする小さな部品。
 *
 * 2026-04-23 の打ち合わせで「お客様の審査が通ったかどうかを、催事の会場で
 * その場で見たい」という要望が最も強く出ている。会場では画面を開いたまま
 * 接客に戻ることが多く、そのたびに読み込み直す操作はできない。
 * そこで、決めた間隔でこの部品が画面をそっと新しくする。
 *
 * 新しくするやり方は router.refresh()。
 * ・URL を変えないので、並び替え・絞り込み・期間の指定はそのまま残る
 *   （画面側は searchParams から条件を読んでいるが、その中身が変わらない）
 * ・ブラウザの再読み込みとは違い、変わったところだけを差し替える。
 *   画面が白くなったり、上までスクロールが戻ったりしない。
 * ・そのため、更新のたびに光る・ちらつくといった動きはあえて何も付けない。
 *   出しているのは「◯秒前に更新」という小さな文字だけ。
 *
 * 止められるようにしてある理由：
 * ・入力の途中で表が入れ替わると、打ち込んでいた内容を見失うことがある
 * ・回線の弱い会場では、通信を減らしたいことがある
 * さらに、次の間は自分から待つ。
 * ・別のタブを見ている間（document.visibilityState が "visible" でない間）
 * ・文字を打ち込んでいる間と、打ち終わってすぐの間
 * ------------------------------------------------------------------ */

/** 打ち込みが止まってから、これだけ静かになるまで更新を待つ（ミリ秒）。 */
const QUIET_MS = 3000;

/** 更新にこれ以上かかったときだけ「更新しています…」と出す（ミリ秒）。
 *  一瞬で終わる更新までいちいち知らせると、文字が点滅して目が疲れるため。 */
const BUSY_MS = 1200;

/** 間隔の下限（秒）。書き間違いで通信が増えすぎないようにする。 */
const MIN_SECONDS = 5;

/** 打ち込み中とみなす部品。 */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** いま入力欄に手を置いているか。 */
function isTyping(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return TYPING_TAGS.has(el.tagName);
}

/** 「◯秒前に更新」。時間が空いたときは分・時間に言い換える。 */
function agoLabel(seconds: number): string {
  if (seconds < 5) return "たった今更新しました";
  if (seconds < 60) return `${seconds}秒前に更新`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前に更新`;
  return `${Math.floor(minutes / 60)}時間前に更新`;
}

/** 「10秒ごと」「1分ごと」。 */
function everyLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}秒ごと`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}分ごと` : `${minutes}分${seconds % 60}秒ごと`;
}

const buttonCls =
  "rounded-lg border border-ink-700 px-2.5 py-1 text-xs font-medium text-ink-300 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-50";

export function AutoRefresh({
  seconds,
  label = "この画面",
}: {
  /** 更新の間隔（秒）。5秒より短くはできない。 */
  seconds: number;
  /** 何が新しくなるか。説明の文言に使う（例: "顧客一覧"）。 */
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /** 自動更新を動かすか。利用者が自分で止められる。 */
  const [enabled, setEnabled] = useState(true);
  /** 最後に画面が新しくなった時刻。最初の表示はいま読み込んだ内容なので今の時刻。 */
  const [updatedAt, setUpdatedAt] = useState<number>(() => Date.now());
  /** 更新を頼んだ時刻。「更新しています…」を出すかどうかの判断に使う。 */
  const [requestedAt, setRequestedAt] = useState<number>(() => Date.now());
  /** 1秒ごとに進む今の時刻。「◯秒前」の表示と、更新の頃合いの判定に使う。 */
  const [now, setNow] = useState<number>(() => Date.now());
  /** 更新の頃合いだが、打ち込み中なので待っている状態。 */
  const [waitingForInput, setWaitingForInput] = useState(false);

  const intervalMs = Math.max(MIN_SECONDS, Math.round(seconds)) * 1000;

  /** 最後に文字を打った時刻。打っている最中の判定に使う。 */
  const lastTypedAt = useRef(0);

  const refresh = useCallback(() => {
    const at = Date.now();
    setRequestedAt(at);
    // startTransition の中で呼ぶと、新しい内容が届くまで pending が立つ。
    // 前の更新が終わる前に次を重ねて頼まないための目印にする。
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  /* 打ち込みの気配を覚えておく。
     入力欄から手を離した直後も、まだ操作の続きであることが多いので少しだけ待つ。 */
  useEffect(() => {
    const mark = () => {
      lastTypedAt.current = Date.now();
    };
    document.addEventListener("keydown", mark, true);
    document.addEventListener("input", mark, true);
    return () => {
      document.removeEventListener("keydown", mark, true);
      document.removeEventListener("input", mark, true);
    };
  }, []);

  /* 1秒ごとの時計。
     裏に回っている間は何も進めない（表示も更新も止める）。 */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  /* 別のタブから戻ってきたら、次の1秒を待たずにその場で見直す。 */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  /* 更新が終わった時刻を記録する。
     頼んだ時刻ではなく、新しい内容が画面に出た時刻を「◯秒前」の起点にする。 */
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      const at = Date.now();
      setUpdatedAt(at);
      setNow(at);
      setWaitingForInput(false);
    }
    wasPending.current = pending;
  }, [pending]);

  /* 頃合いを見て更新する。時計が進むたびに（＝1秒ごとに）確かめる。 */
  useEffect(() => {
    if (!enabled) return;
    if (document.visibilityState !== "visible") return;

    const busyTyping = isTyping() || Date.now() - lastTypedAt.current < QUIET_MS;
    const due = now - updatedAt >= intervalMs;
    setWaitingForInput(busyTyping && due);

    if (!due || busyTyping || pending) return;
    refresh();
  }, [enabled, now, pending, updatedAt, intervalMs, refresh]);

  const elapsed = Math.max(0, Math.floor((now - updatedAt) / 1000));
  const busy = pending && now - requestedAt >= BUSY_MS;
  const note = busy
    ? "更新しています…"
    : enabled && waitingForInput
      ? "入力が終わるまで待っています"
      : null;
  const every = everyLabel(Math.max(MIN_SECONDS, Math.round(seconds)));

  const toggle = () => {
    setEnabled((on) => !on);
    // 再開したときに、頃合いを過ぎていればすぐ更新されるようにする。
    setNow(Date.now());
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
      title={`${label}を${every}に新しくします。別の画面を見ている間と、入力している間は止まります。`}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium",
          enabled
            ? "border-good-500/40 bg-good-500/15 text-good-100"
            : "border-ink-600 bg-ink-800 text-ink-300",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            enabled ? "bg-good-500" : "bg-ink-600",
          )}
        />
        {enabled ? `自動更新中（${every}）` : "自動更新は停止中"}
      </span>

      {/* 1秒ごとに変わる文字なので、読み上げは行わない（読み上げが止まらなくなるため）。 */}
      <span aria-live="off" className="tabnum text-ink-400">
        {agoLabel(elapsed)}
      </span>
      {note ? <span className="text-ink-400">{note}</span> : null}

      <button
        type="button"
        onClick={toggle}
        className={buttonCls}
        aria-label={
          enabled
            ? "自動更新を止める。画面はそのままになります"
            : `自動更新を再開する。${every}に新しくなります`
        }
      >
        {enabled ? "止める" : "再開する"}
      </button>

      {enabled ? null : (
        <button
          type="button"
          onClick={refresh}
          disabled={pending}
          className={buttonCls}
          aria-label="いますぐ画面を新しくする"
        >
          {pending ? "更新中…" : "今すぐ更新"}
        </button>
      )}
    </div>
  );
}
