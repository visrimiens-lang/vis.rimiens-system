"use client";

import { useActionState, useState } from "react";
import {
  updateOrderAction,
  updateShipmentAction,
  type OrderActionState,
} from "@/actions/order-actions";
import { Card, Notice } from "@/components/ui";

const initial: OrderActionState = {};

const primaryBtn =
  "rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2.5 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";
const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";

const SHIP_STATUSES = ["出荷待ち", "出荷手配中", "出荷済", "キャンセル"];
const REVIEW_RESULTS = ["承認", "否決", "電話確認待ち"];
const MATCH_STATUSES = ["照合済", "要確認", "直販"];

/** 紹介元コードの入力候補。 */
export type ReferrerOption = { code: string; name: string };

export function ShipForm({
  orderId,
  shipStatus,
  trackingNo,
  shippedOn,
  reviewResult,
  creditRefNo,
  matchStatus,
  referrerCode,
  referrerOptions,
}: {
  orderId: string;
  shipStatus: string;
  trackingNo: string;
  shippedOn: string;
  reviewResult: string;
  creditRefNo: string;
  matchStatus: string;
  referrerCode: string;
  referrerOptions: ReferrerOption[];
}) {
  return (
    <div className="space-y-6">
      <ShipmentSection
        orderId={orderId}
        shipStatus={shipStatus}
        trackingNo={trackingNo}
        shippedOn={shippedOn}
      />
      <ReviewSection
        orderId={orderId}
        reviewResult={reviewResult}
        creditRefNo={creditRefNo}
        matchStatus={matchStatus}
        referrerCode={referrerCode}
        referrerOptions={referrerOptions}
      />
    </div>
  );
}

/* ═══════════════════════ 出荷の手配 ═══════════════════════ */

/**
 * 出荷状況・送り状番号・出荷日を変える。
 *
 * 出荷済にすると報酬が確定し、キャンセルにすると報酬が取り消される。
 * どちらも後戻りしにくいので、押す前に何が起きるかを画面に出しておく。
 */
function ShipmentSection({
  orderId,
  shipStatus,
  trackingNo,
  shippedOn,
}: {
  orderId: string;
  shipStatus: string;
  trackingNo: string;
  shippedOn: string;
}) {
  const [state, run, pending] = useActionState(updateShipmentAction, initial);
  const [status, setStatus] = useState(shipStatus || "出荷待ち");
  const [tracking, setTracking] = useState(trackingNo);
  const [agreed, setAgreed] = useState(false);

  const shipping = status === "出荷済";
  const cancelling = status === "キャンセル" && shipStatus !== "キャンセル";
  const missingTracking = shipping && !tracking.trim();
  const blocked = missingTracking || (cancelling && !agreed);

  return (
    <Card title="出荷を手配する">
      <form action={run} className="space-y-4 px-5 py-5">
        <input type="hidden" name="orderId" value={orderId} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className={labelCls}>出荷状況</span>
            <select
              name="shipStatus"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setAgreed(false);
              }}
              disabled={pending}
              className={inputCls}
            >
              {SHIP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className={hintCls}>
              出荷済にすると、この受注の報酬が確定します。
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>送り状番号（ヤマト）</span>
            <input
              name="trackingNo"
              type="text"
              inputMode="numeric"
              maxLength={30}
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="例：4123-4567-8901"
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <span className={hintCls}>
              ハイフンや空白は入っていても構いません。保存するときに取り除きます。
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>出荷日</span>
            <input
              name="shippedOn"
              type="date"
              defaultValue={shippedOn}
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <span className={hintCls}>
              空のまま出荷済にすると、今日の日付が入ります。
            </span>
          </label>
        </div>

        {missingTracking ? (
          <Notice tone="warn">
            出荷済にするには送り状番号が必要です。まだ送り状ができていない場合は「出荷手配中」で保存してください。
          </Notice>
        ) : null}

        {cancelling ? (
          <Notice tone="bad">
            <p>
              キャンセルにすると、この受注から発生した報酬がすべて取り消されます
              （同額のマイナスを立てて相殺します）。取り消した報酬は元に戻せません。
            </p>
            <label className="mt-2.5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="confirmCancel"
                value="true"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                disabled={pending}
                className="h-4 w-4 rounded border-ink-600 bg-ink-950 accent-bad-500"
              />
              <span>報酬が取り消されることを確認しました</span>
            </label>
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || blocked}
            className={cancelling ? dangerBtn : primaryBtn}
          >
            {pending
              ? "保存中…"
              : cancelling
                ? "キャンセルとして保存する"
                : "この内容で保存する"}
          </button>
          <span className="text-xs text-ink-500">
            現在の出荷状況は「{shipStatus || "未設定"}」です。
          </span>
        </div>

        {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
      </form>
    </Card>
  );
}

/* ═══════════════════ 審査結果と紹介元の直し ═══════════════════ */

/**
 * 信販の審査結果と、売上をどの代理店に付けるか（照合）を直す。
 *
 * 紹介元コードは報酬の支払先そのものなので、
 * 代理店マスタに無いコードは保存時に断られる。
 */
function ReviewSection({
  orderId,
  reviewResult,
  creditRefNo,
  matchStatus,
  referrerCode,
  referrerOptions,
}: {
  orderId: string;
  reviewResult: string;
  creditRefNo: string;
  matchStatus: string;
  referrerCode: string;
  referrerOptions: ReferrerOption[];
}) {
  const [state, run, pending] = useActionState(updateOrderAction, initial);
  const [match, setMatch] = useState(matchStatus || "直販");
  const [referrer, setReferrer] = useState(referrerCode);

  const trimmed = referrer.trim();
  const needsReferrer = match === "照合済" && !trimmed;
  const extraReferrer = match === "直販" && Boolean(trimmed);
  const known = referrerOptions.find((o) => o.code === trimmed);

  return (
    <Card title="審査結果と紹介元を直す">
      <form action={run} className="space-y-4 px-5 py-5">
        <input type="hidden" name="orderId" value={orderId} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={labelCls}>審査結果</span>
            <select
              name="reviewResult"
              defaultValue={reviewResult}
              disabled={pending}
              className={inputCls}
            >
              <option value="">未設定</option>
              {REVIEW_RESULTS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <span className={hintCls}>信販会社からの回答を選びます。</span>
          </label>

          <label className="block">
            <span className={labelCls}>信販受付番号</span>
            <input
              name="creditRefNo"
              type="text"
              maxLength={60}
              defaultValue={creditRefNo}
              placeholder="信販会社から届いた番号"
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <span className={hintCls}>
              問い合わせのときに使う番号です。無ければ空のままで構いません。
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>照合の状態</span>
            <select
              name="matchStatus"
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              disabled={pending}
              className={inputCls}
            >
              {MATCH_STATUSES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <span className={hintCls}>
              照合済＝紹介元が確定 / 要確認＝調査中 / 直販＝紹介なし
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>紹介元コード</span>
            <input
              name="referrerCode"
              type="text"
              list="referrer-candidates"
              maxLength={20}
              value={referrer}
              onChange={(e) => setReferrer(e.target.value)}
              placeholder="例：RIM0003"
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <datalist id="referrer-candidates">
              {referrerOptions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </datalist>
            <span className={hintCls}>
              {trimmed
                ? known
                  ? `${known.name || "（名称未登録）"}`
                  : "この番号は候補にありません。保存するときに代理店マスタと照らし合わせます。"
                : "お客様を紹介した取次店のコードを入れます。"}
            </span>
          </label>
        </div>

        {needsReferrer ? (
          <Notice tone="warn">
            「照合済」は紹介元がはっきりしている受注に付けます。紹介元コードを入れるか、
            まだ分からない場合は「要確認」、紹介がない場合は「直販」を選んでください。
          </Notice>
        ) : null}

        {extraReferrer ? (
          <Notice tone="warn">
            「直販」は紹介元がいない受注です。紹介元コードを空にするか、
            紹介元がある場合は「照合済」を選んでください。
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || needsReferrer || extraReferrer}
            className={primaryBtn}
          >
            {pending ? "保存中…" : "この内容で保存する"}
          </button>
          <span className="text-xs text-ink-500">
            紹介元を変えても、すでに計上された報酬は自動では作り直されません。
          </span>
        </div>

        {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
        {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
      </form>
    </Card>
  );
}
