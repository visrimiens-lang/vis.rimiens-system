"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  loadResetRequestsAction,
  resolveResetAction,
  type ResetFormState,
} from "@/actions/reset-actions";
import type { ResetRequest } from "@/lib/reset";
import { Card, EmptyState, Notice, Table, Td, Th } from "@/components/ui";

const initial: ResetFormState = {};

const doneBtn =
  "rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "whitespace-nowrap rounded-lg border border-ink-700 px-3.5 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-3.5 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

type Loaded =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; items: ResetRequest[] };

/**
 * ログイン画面から届いた「パスワード再発行の申し込み」を本部が確認するカード。
 *
 * 申し込みが実在の代理店から来たかどうかは、この一覧だけでは分からない
 * （申し込み画面は誰でも開けるため）。必ず連絡先へ折り返して本人を確認してから、
 * 同じ画面の「ポータルのログイン情報を発行」でパスワードを発行する運用にする。
 *
 * 一覧はこのカードが自分で読み込む。差し込む側は <ResetRequests /> と書くだけでよい。
 */
export function ResetRequests() {
  const [state, setState] = useState<Loaded>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const result = await loadResetRequestsAction();
      setState(
        result.ok
          ? { phase: "ready", items: result.items }
          : { phase: "error", message: result.message },
      );
    } catch {
      setState({
        phase: "error",
        message:
          "パスワード再発行の申し込みを読み込めませんでした。通信の状態をご確認のうえ、もう一度お試しください。",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const count = state.phase === "ready" ? state.items.length : null;

  return (
    <Card
      title={
        count === null
          ? "パスワード再発行の申し込み"
          : `パスワード再発行の申し込み　${count} 件`
      }
      action={
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.phase === "loading"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-300 transition hover:border-ink-600 hover:text-ink-50 disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {state.phase === "loading" ? "読み込み中…" : "最新にする"}
        </button>
      }
    >
      {state.phase === "loading" ? (
        <div className="px-5 py-14 text-center text-sm text-ink-400">
          申し込みを読み込んでいます…
        </div>
      ) : state.phase === "error" ? (
        <div className="px-5 py-5">
          <Notice tone="bad">{state.message}</Notice>
        </div>
      ) : state.items.length === 0 ? (
        <EmptyState
          title="未対応の申し込みはありません"
          description="代理店がログイン画面の「パスワードをお忘れの方」から申し込むと、ここに届きます。"
        />
      ) : (
        <>
          <div className="px-5 pt-5">
            <Notice tone="warn">
              代理店コードもメールアドレスも、QR の案内などに載る情報です。
              この申し込みが届いただけでは本人確認になりません。
              かならずご連絡先へ折り返してご本人を確かめてから、下の
              「ポータルのログイン情報を発行」でパスワードを発行してください。
            </Notice>
          </div>
          <div className="mt-5">
            <Table>
              <thead>
                <tr>
                  <Th>代理店コード</Th>
                  <Th>ご連絡先</Th>
                  <Th>申し込み日時</Th>
                  <Th>対応</Th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((request) => (
                  <RequestRow key={request.id} request={request} />
                ))}
              </tbody>
            </Table>
          </div>
          <p className="px-5 py-4 text-xs leading-relaxed text-ink-400">
            パスワードをお伝えしたら「対応済みにする」を押してください。一覧から消えます。
            心当たりのない申し込みは「取り下げる」で閉じてください。パスワードは発行されません。
          </p>
        </>
      )}
    </Card>
  );
}

/* ---------- 1件ぶん ---------- */

function RequestRow({ request }: { request: ResetRequest }) {
  const [state, run, pending] = useActionState(resolveResetAction, initial);
  const [confirming, setConfirming] = useState(false);
  const settled = Boolean(state.ok);

  return (
    <tr>
      <Td numeric className="whitespace-nowrap align-top font-medium text-ink-100">
        {request.agencyCode || "—"}
      </Td>
      <Td className="align-top">
        <div className="min-w-0">
          <div className="break-all text-ink-100">{request.contact || "—"}</div>
          {request.note ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-400">
              {request.note}
            </div>
          ) : null}
        </div>
      </Td>
      <Td numeric className="whitespace-nowrap align-top">
        {formatWhen(request.createdAt)}
      </Td>
      <Td className="align-top">
        {settled ? (
          <span className="text-sm text-ink-300">{state.ok}</span>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <form action={run}>
                <input type="hidden" name="id" value={request.id} />
                <input type="hidden" name="status" value="done" />
                <button type="submit" disabled={pending} className={doneBtn}>
                  {pending ? "保存中…" : "対応済みにする"}
                </button>
              </form>

              {confirming ? (
                <form action={run} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={request.id} />
                  <input type="hidden" name="status" value="rejected" />
                  <span className="text-sm text-ink-300">取り下げますか？</span>
                  <button type="submit" disabled={pending} className={dangerBtn}>
                    はい
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={pending}
                    className={quietBtn}
                  >
                    やめる
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={pending}
                  className={quietBtn}
                >
                  取り下げる
                </button>
              )}
            </div>

            {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
          </div>
        )}
      </Td>
    </tr>
  );
}

/**
 * 申し込み日時の表示。
 * 一覧はブラウザ側で読み込むので、見ている人の時刻でそのまま表示してよい。
 */
function formatWhen(iso: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 16).replace("T", " ");
  return at.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
