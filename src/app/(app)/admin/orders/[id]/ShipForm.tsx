"use client";

import { useActionState, useState } from "react";
import {
  updateOrderAction,
  updateShipmentAction,
  type OrderActionState,
} from "@/actions/order-actions";
import { Card, Notice } from "@/components/ui";
import { jpDateTime } from "@/lib/jst";
import {
  PAYMENT_STATUSES,
  isLoanMethod,
  paymentMethodLabel,
  paymentStatusOf,
} from "@/lib/payment-status";

const initial: OrderActionState = {};

const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2.5 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";
const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";

const SHIP_STATUSES = ["出荷待ち", "出荷手配中", "出荷済", "キャンセル"];
const REVIEW_RESULTS = ["承認", "否決", "電話確認待ち"];
const MATCH_STATUSES = ["照合済", "要確認", "直販"];

/**
 * 紹介元コード・担当スタッフのコードの入力候補。
 *
 * kind は代理店マスタのコード区分（00=会社 / 01=取次パートナー / 02=スタッフ）。
 * 渡されていれば、担当スタッフの候補をスタッフだけに絞る。
 */
export type ReferrerOption = { code: string; name: string; kind?: string };

export function ShipForm({
  orderId,
  shipStatus,
  trackingNo,
  shippedOn,
  deliveredOn,
  reviewResult,
  creditRefNo,
  matchStatus,
  referrerCode,
  referrerOptions,
  staffCode = "",
  staffOptions,
  paymentMethod = "",
  paymentStatus = "",
  aplusUrlSentAt = "",
}: {
  orderId: string;
  shipStatus: string;
  trackingNo: string;
  shippedOn: string;
  /** 顧客台帳の配達完了日。進捗を「配達完了」まで進めるのに使う。 */
  deliveredOn: string;
  reviewResult: string;
  creditRefNo: string;
  matchStatus: string;
  /** 決済方法（Stripe / 振込 / アプラス など）。お支払い欄の説明に使う。 */
  paymentMethod?: string;
  /** アプラスの申込URLを送った日時。未送付は空 */
  aplusUrlSentAt?: string;
  /** お支払いの状況（着金待ち / 決済完了）。列ができる前の受注は空。 */
  paymentStatus?: string;
  referrerCode: string;
  referrerOptions: ReferrerOption[];
  /** いま記録されている担当スタッフのコード。渡されなければ空欄で始まる。 */
  staffCode?: string;
  /** 担当スタッフの入力候補。渡されなければ紹介元の候補を流用する。 */
  staffOptions?: ReferrerOption[];
}) {
  return (
    <div className="space-y-6">
      <ShipmentSection
        orderId={orderId}
        shipStatus={shipStatus}
        trackingNo={trackingNo}
        shippedOn={shippedOn}
        deliveredOn={deliveredOn}
      />
      <ReviewSection
        orderId={orderId}
        reviewResult={reviewResult}
        paymentMethod={paymentMethod}
        paymentStatus={paymentStatus}
        aplusUrlSentAt={aplusUrlSentAt}
        creditRefNo={creditRefNo}
        matchStatus={matchStatus}
        referrerCode={referrerCode}
        referrerOptions={referrerOptions}
        staffCode={staffCode}
        staffOptions={staffOptions}
      />
    </div>
  );
}

/* ═══════════════════════ 出荷の手配 ═══════════════════════ */

/**
 * 出荷状況・送り状番号・出荷日を変える。
 *
 * 配達完了日を入れると報酬が確定し、キャンセルにすると報酬が取り消される。
 * どちらも後戻りしにくいので、押す前に何が起きるかを画面に出しておく。
 */
function ShipmentSection({
  orderId,
  shipStatus,
  trackingNo,
  shippedOn,
  deliveredOn,
}: {
  orderId: string;
  shipStatus: string;
  trackingNo: string;
  shippedOn: string;
  deliveredOn: string;
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
              出荷済にすると、お客様に送り状番号でお届け状況をご案内できます。
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

          <label className="block">
            <span className={labelCls}>配達完了日</span>
            <input
              name="deliveredOn"
              type="date"
              defaultValue={deliveredOn}
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <span className={hintCls}>
              入れると、お客様の進捗が「配達完了」になり、この受注の報酬が確定します。
              売上・報酬もこの日付の月に計上されます。空にすると戻せます。
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
 * 信販の審査結果と、売上をどの代理店に付けるか（照合）、誰が売ったか（担当スタッフ）を直す。
 *
 * 紹介元コードは報酬の支払先そのものなので、
 * 代理店マスタに無いコードは保存時に断られる。担当スタッフのコードも同じ扱いにして、
 * 打ち間違いをそのまま記録しないようにしている。
 *
 * 審査結果は報酬にも響く。否決にすると報酬が取り消されるので、
 * 押す前に何が起きるかを画面に出しておく。
 */
function ReviewSection({
  orderId,
  reviewResult,
  paymentMethod,
  paymentStatus,
  aplusUrlSentAt,
  creditRefNo,
  matchStatus,
  referrerCode,
  referrerOptions,
  staffCode,
  staffOptions,
}: {
  orderId: string;
  reviewResult: string;
  paymentMethod: string;
  paymentStatus: string;
  aplusUrlSentAt: string;
  creditRefNo: string;
  matchStatus: string;
  referrerCode: string;
  referrerOptions: ReferrerOption[];
  staffCode: string;
  staffOptions?: ReferrerOption[];
}) {
  const [state, run, pending] = useActionState(updateOrderAction, initial);
  const [match, setMatch] = useState(matchStatus || "直販");
  const [referrer, setReferrer] = useState(referrerCode);
  const [review, setReview] = useState(reviewResult);
  const [staff, setStaff] = useState(staffCode);
  const [clearStaff, setClearStaff] = useState(false);
  // 否決は報酬を取り消す。出荷の「キャンセル」と同じで、確認を入れるまで保存させない。
  const [agreedReject, setAgreedReject] = useState(false);

  const trimmed = referrer.trim();
  const needsReferrer = match === "照合済" && !trimmed;
  const extraReferrer = match === "直販" && Boolean(trimmed);
  const known = referrerOptions.find((o) => o.code === trimmed);

  // 担当スタッフの候補。コード区分が分かるときは、スタッフ（02）だけに絞る。
  const candidates = staffOptions ?? referrerOptions;
  const staffCandidates = candidates.some((o) => o.kind)
    ? candidates.filter((o) => o.kind === "02")
    : candidates;
  const staffTrimmed = staff.trim();
  const knownStaff = staffCandidates.find((o) => o.code === staffTrimmed);

  // 否決は報酬の取消につながる。承認に戻すと計上し直す。どちらも先に伝える。
  const rejecting = review === "否決" && reviewResult !== "否決";
  const restoring = review === "承認" && reviewResult === "否決";

  return (
    <Card title="審査結果と担当を直す">
      <form action={run} className="space-y-4 px-5 py-5">
        <input type="hidden" name="orderId" value={orderId} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={labelCls}>審査結果</span>
            <select
              name="reviewResult"
              value={review}
              onChange={(e) => {
                setReview(e.target.value);
                setAgreedReject(false);
              }}
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
            <span className={hintCls}>
              信販会社からの回答を選びます。否決にすると報酬が取り消されます。
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>お支払い</span>
            <select
              name="paymentStatus"
              defaultValue={paymentStatusOf(paymentMethod, paymentStatus)}
              disabled={pending}
              className={inputCls}
            >
              {PAYMENT_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <span className={hintCls}>
              {paymentMethodLabel(paymentMethod) || "決済方法が未記録"}のご注文です。
              銀行振込・アプラスは着金を確認したら「決済完了」に変えてください。
              クレジットカードは自動で決済完了になります。
            </span>
          </label>

          {/*
            アプラスの申込URLを送ったかどうか。
            アプラスはAPIで連携できず、担当者がお客様へURLをメールで送る手作業になる。
            送ったつもりで送れていないと、審査が始まらないまま着金待ちで止まってしまうため、
            送ったことをここに残して、受注一覧からも見えるようにする。
            アプラス以外のご注文では出さない（関係のない欄を増やさない）。
          */}
          {isLoanMethod(paymentMethod) ? (
            <label className="block">
              <span className={labelCls}>アプラスの申込URL</span>
              <select
                name="aplusUrlSent"
                defaultValue={aplusUrlSentAt ? "sent" : ""}
                disabled={pending}
                className={inputCls}
              >
                <option value="">未送付</option>
                <option value="sent">送付済みにする</option>
                {aplusUrlSentAt ? <option value="clear">未送付に戻す</option> : null}
              </select>
              <span className={hintCls}>
                {aplusUrlSentAt
                  ? `${jpDateTime(aplusUrlSentAt)} に送付済みです。`
                  : "お客様へ申込URLをメールでお送りしたら、送付済みにしてください。"}
                　送るまで審査は始まりません。
              </span>
            </label>
          ) : null}

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
              placeholder="例：ABCD0001"
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

          {/*
            誰が売ったか。2026-08-07 の打合せで「代理店ごとの支払いを本部が検証できない」と
            指摘された欄で、申込の取り込みでも入るが、入らないまま残る受注もある。
            本部が聞き取って埋められる場所として、ここに置いている。
          */}
          <label className="block">
            <span className={labelCls}>担当スタッフのコード</span>
            <input
              name="staffCode"
              type="text"
              list="staff-candidates"
              maxLength={20}
              value={staff}
              onChange={(e) => {
                setStaff(e.target.value);
                setClearStaff(false);
              }}
              placeholder="例：MENO0001"
              disabled={pending}
              className={`${inputCls} tabnum`}
            />
            <datalist id="staff-candidates">
              {staffCandidates.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </datalist>
            <span className={hintCls}>
              {staffTrimmed
                ? knownStaff
                  ? `${knownStaff.name || "（名称未登録）"}`
                  : "この番号は候補にありません。保存するときに代理店一覧と照らし合わせます。"
                : "実際にお客様へ販売した方のコードです。空欄のまま保存しても、いま記録されているコードは消えません。"}
            </span>
          </label>
        </div>

        {!staffTrimmed ? (
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              name="clearStaffCode"
              value="true"
              checked={clearStaff}
              onChange={(e) => setClearStaff(e.target.checked)}
              disabled={pending}
              className="h-4 w-4 rounded border-ink-600 bg-ink-950 accent-gold-500"
            />
            <span>
              担当スタッフのコードを空にする（記録されているコードを消します）
            </span>
          </label>
        ) : null}

        {rejecting ? (
          <Notice tone="bad">
            <p>
              審査結果を「否決」にすると、この受注から発生した報酬がすべて取り消されます
              （同額のマイナスを立てて相殺します）。取り消した報酬は元に戻せません。
              否決の受注は、受注一覧の売上合計・支払対象額にも数えません。
            </p>
            <label className="mt-2.5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="confirmReject"
                value="true"
                checked={agreedReject}
                onChange={(e) => setAgreedReject(e.target.checked)}
                disabled={pending}
                className="h-4 w-4 rounded border-ink-600 bg-ink-950 accent-bad-500"
              />
              <span>報酬が取り消されることを確認しました</span>
            </label>
            <label className="mt-3 block">
              <span className={labelCls}>否決の理由（任意）</span>
              <input
                name="rejectReason"
                type="text"
                maxLength={100}
                placeholder="例：信販の否決通知 No.12345"
                disabled={pending}
                className={inputCls}
              />
              <span className={hintCls}>
                報酬の取消理由として残ります。あとから「なぜ取り消したか」を追うときに使います。
              </span>
            </label>
          </Notice>
        ) : null}

        {restoring ? (
          <Notice tone="warn">
            審査結果を「承認」に戻すと、否決のときに取り消した報酬を計上し直します。
            取り消した分（マイナス）は帳簿に残したままにするため、報酬一覧には
            取消の行と計上し直した行の両方が並びます。
          </Notice>
        ) : null}

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
            disabled={pending || needsReferrer || extraReferrer || (rejecting && !agreedReject)}
            className={rejecting ? dangerBtn : primaryBtn}
          >
            {pending
              ? "保存中…"
              : rejecting
                ? "否決として保存する"
                : "この内容で保存する"}
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
