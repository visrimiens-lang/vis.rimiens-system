"use client";

import { useActionState, useEffect, useState } from "react";
import { Ban, Check, Copy, Download, QrCode, ShieldAlert } from "lucide-react";
import {
  approveQr2Action,
  freezeQrAction,
  issueQrAction,
  rejectQr2Action,
  unfreezeQrAction,
  type QrActionState,
} from "@/actions/qr-actions";
import {
  OFFICIAL_LINE_URL,
  QR2_APPLIED,
  QR2_APPROVED,
  QR2_REJECTED,
  QR2_UNAPPLIED,
  TRAINING_PASSED,
  isTossPartner,
  qrImageUrl,
  readQrAgency,
  tossUpUrl,
  type QrSource,
} from "@/lib/qr";
import { Badge, Card, Notice, StatusBadge, cn, jpDate } from "@/components/ui";

const initial: QrActionState = {};

const primaryBtn =
  "inline-flex items-center gap-2 rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "inline-flex items-center gap-2 rounded-lg border border-ink-700 px-3.5 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const dangerBtn =
  "inline-flex items-center gap-2 rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 停止（凍結）したことを見分けるための目印。
 * ★ 保存する側（actions/qr-actions.ts）にも同じ文字列を置いてある。
 *   片方だけ変えるとこの画面が停止中を見分けられなくなるので、必ず両方そろえること。
 */
const FREEZE_MARK = "【QR停止】";

/** いま停止中か。停止は「差戻し」の欄を目印付きで使っている。 */
function isFrozen(qr2Status: string, rejectedNote: string): boolean {
  return qr2Status === QR2_REJECTED && rejectedNote.startsWith(FREEZE_MARK);
}

/** 停止したときの理由。目印を外して読む。 */
function freezeReasonOf(rejectedNote: string): string {
  return rejectedNote.slice(FREEZE_MARK.length).trim();
}

/**
 * 本部が代理店へお渡しするQRを発行する画面。
 *
 *   QR1 … 体験・デモのご案内（公式LINEの友だち追加）
 *   QR2 … ご契約・お支払いのご案内。研修に合格し、本部が承認した相手だけ。
 *
 * 取次パートナーには個別のQRを出さない。共通の公式LINEと、
 * お客様をご紹介いただくフォームをご案内する（2026-08-07 会議で確定）。
 */
export function QrPanel({ agency }: { agency: QrSource }) {
  const a = readQrAgency(agency);

  if (!a.code) {
    return (
      <Card title="QRのご案内">
        <div className="px-5 py-5">
          <Notice tone="bad">
            代理店コードを読み込めませんでした。画面を読み込み直してもこのままの場合は、
            代理店の登録内容をご確認ください。
          </Notice>
        </div>
      </Card>
    );
  }

  if (isTossPartner(a)) {
    return <TossPartnerGuide code={a.code} name={a.name} />;
  }

  // コンプライアンス対応で止めている最中かどうか。止めている間は発行も承認もできない。
  const frozen = isFrozen(a.qr2Status, a.qr2RejectedNote);
  const freezeReason = frozen ? freezeReasonOf(a.qr2RejectedNote) : "";

  return (
    <Card title="QRのご案内（発行・停止）">
      <div className="divide-y divide-ink-800">
        <Qr1Section
          code={a.code}
          issuedUrl={a.qr1Url}
          suspended={a.status === "停止・解約"}
          frozen={frozen}
        />
        <Qr2Section
          code={a.code}
          issuedUrl={a.qr2Url}
          trainingStatus={a.trainingStatus}
          trainingPassedOn={a.trainingPassedOn}
          qr2Status={a.qr2Status}
          requestedOn={a.qr2RequestedOn}
          rejectedNote={a.qr2RejectedNote}
          suspended={a.status === "停止・解約"}
          frozen={frozen}
        />
        <FreezeSection
          code={a.code}
          name={a.name}
          issued={Boolean(a.qr1Url || a.qr2Url)}
          frozen={frozen}
          reason={freezeReason}
        />
      </div>
    </Card>
  );
}

/* ─────────── 取次パートナー ─────────── */

/**
 * 取次パートナーには個別のQRを発行しない。
 * 共通の公式LINEと、ご紹介（トスアップ）用の専用URLをご案内する。
 */
function TossPartnerGuide({ code, name }: { code: string; name: string }) {
  const toss = tossUpUrl(code);
  return (
    <Card title="取次パートナーへのご案内">
      <div className="space-y-5 px-5 py-5">
        <Notice tone="info">
          取次パートナーには、個別のQR（QR1・QR2）は発行しません。
          お客様への最初のご案内は<strong className="text-ink-100">共通の公式LINE</strong>
          をお使いいただき、ご紹介いただいたお客様は
          <strong className="text-ink-100">ご紹介フォーム</strong>から送っていただきます。
          ご契約とお支払いは、担当の代理店が引き継ぎます。
        </Notice>

        <UrlBlock
          title="共通の公式LINE"
          description={`お客様に友だち追加していただく、全社共通のご案内です。${name || code} 専用のQRはありません。`}
          url={OFFICIAL_LINE_URL}
          fileName="VIS_公式LINE"
        />

        {toss ? (
          <UrlBlock
            title="ご紹介（トスアップ）フォーム"
            description="この取次店コードが入った専用URLです。ここから送られたお客様は、この取次店からのご紹介として記録されます。"
            url={toss}
            fileName={`${code}_ご紹介フォーム`}
          />
        ) : (
          <Notice tone="warn">
            ご紹介フォームのURLがまだ設定されていません。本部で使っているフォームのURLを
            設定に登録すると、この取次店コード入りの専用URLをここに表示できます。
            それまでは、本部から個別にご案内してください。
          </Notice>
        )}
      </div>
    </Card>
  );
}

/* ─────────── QR1 ─────────── */

function Qr1Section({
  code,
  issuedUrl,
  suspended,
  frozen,
}: {
  code: string;
  issuedUrl: string;
  suspended: boolean;
  /** コンプライアンス対応でこの代理店のQRを止めているか。 */
  frozen: boolean;
}) {
  const [state, run, pending] = useActionState(issueQrAction, initial);
  const url = frozen ? "" : state.url || issuedUrl;

  return (
    <section className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
            <QrCode className="h-4 w-4 text-gold-400" />
            QR1　体験・デモのご案内
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-300">
            お客様に公式LINEを友だち追加していただくご案内です。研修の合否にかかわらずお渡しできます。
            友だち追加は LINE の中で完結するため、
            <strong className="text-ink-100">このご案内からは誰のご紹介かを記録できません</strong>。
            紹介元は、ご契約のご案内（QR2）のお支払いフォームで記録されます。
            体験の段階から紹介元を残したいときは、体験の事前登録フォームの「紹介コード」に
            この代理店コードをご記入いただいてください。
          </p>
        </div>
        <Badge tone={frozen ? "bad" : url ? "good" : "neutral"}>
          {frozen ? "停止中" : url ? "発行済み" : "未発行"}
        </Badge>
      </div>

      {suspended ? (
        <Notice tone="warn">
          この代理店は停止・解約のため、新しいご案内は発行できません。
          発行が必要な場合は、先に稼働状況を戻してください。
        </Notice>
      ) : null}

      {frozen ? (
        <Notice tone="bad">
          この代理店のQRは停止中です。発行し直すには、下の「QRの停止」欄で停止を解除してください。
        </Notice>
      ) : null}

      {url ? (
        <UrlBlock
          title="体験のご案内（QR1）"
          description="このQRとURLを、代理店にお渡しください。"
          url={url}
          fileName={`${code}_QR1_体験のご案内`}
        />
      ) : null}

      <form action={run} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="code" value={code} />
        <input type="hidden" name="kind" value="qr1" />
        <button
          type="submit"
          disabled={pending || suspended || frozen}
          className={primaryBtn}
        >
          <QrCode className="h-4 w-4" />
          {pending ? "発行中…" : url ? "QR1を作り直す" : "QR1を発行"}
        </button>
        {url ? (
          <span className="text-xs text-ink-400">
            作り直してもURLは同じです。お渡しした案内はそのままお使いいただけます。
          </span>
        ) : null}
      </form>

      <Result state={state} />
    </section>
  );
}

/* ─────────── QR2 ─────────── */

function Qr2Section({
  code,
  issuedUrl,
  trainingStatus,
  trainingPassedOn,
  qr2Status,
  requestedOn,
  rejectedNote,
  suspended,
  frozen,
}: {
  code: string;
  issuedUrl: string;
  trainingStatus: string;
  trainingPassedOn: string;
  qr2Status: string;
  requestedOn: string;
  rejectedNote: string;
  suspended: boolean;
  /** コンプライアンス対応でこの代理店のQRを止めているか。 */
  frozen: boolean;
}) {
  const [issueState, issue, issuing] = useActionState(issueQrAction, initial);
  const [approveState, approve, approving] = useActionState(approveQr2Action, initial);
  const [rejectState, reject, rejecting] = useActionState(rejectQr2Action, initial);
  const [rejectOpen, setRejectOpen] = useState(false);

  const passed = trainingStatus === TRAINING_PASSED;
  const url = frozen ? "" : issueState.url || issuedUrl;
  const busy = issuing || approving || rejecting;

  return (
    <section className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
            <QrCode className="h-4 w-4 text-gold-400" />
            QR2　ご契約・お支払いのご案内
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-300">
            お客様がご契約とお支払いに進むためのご案内です。
            <strong className="text-ink-100">研修に合格した方だけ</strong>にお渡しでき、
            発行には本部の承認が必要です。
          </p>
        </div>
        <Badge tone={frozen ? "bad" : url ? "good" : "neutral"}>
          {frozen ? "停止中" : url ? "発行済み" : "未発行"}
        </Badge>
      </div>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-ink-800 bg-ink-850/60 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-ink-400">研修</dt>
          <dd>
            <StatusBadge status={trainingStatus || "未受講"} />
          </dd>
          {passed && trainingPassedOn ? (
            <dd className="tabnum text-xs text-ink-400">合格 {jpDate(trainingPassedOn)}</dd>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-ink-400">発行の申請</dt>
          <dd>
            <StatusBadge status={qr2Status} />
          </dd>
          {requestedOn ? (
            <dd className="tabnum text-xs text-ink-400">申請 {jpDate(requestedOn)}</dd>
          ) : null}
        </div>
      </dl>

      {suspended ? (
        <Notice tone="warn">
          この代理店は停止・解約のため、ご契約のご案内は発行できません。
        </Notice>
      ) : null}

      {/*
        上から順に、発行できない理由の重い方から出す。
        1. 停止中（コンプライアンス対応で止めている）
        2. 研修に合格していない
        どちらでもなければ、承認と発行の欄を出す。
      */}
      {frozen ? (
        <Notice tone="bad">
          この代理店のQRは停止中です。ご契約のご案内（QR2）は発行できません。
          止めた理由の確認と解除は、下の「QRの停止」欄から行ってください。
          解除しても、発行の承認からのやり直しになります。
        </Notice>
      ) : !passed ? (
        <Notice tone="warn">
          研修に合格していません（現在：{trainingStatus || "未受講"}）。
          ご契約のご案内（QR2）は、研修に合格した方にのみお渡しできます。
          研修の結果を登録してから、あらためてこの画面をご確認ください。
        </Notice>
      ) : (
        <div className="space-y-4">
          {/* いまの状況の説明 */}
          {qr2Status === QR2_APPROVED ? (
            <Notice tone="info">
              本部の承認が済んでいます。下の「
              {url ? "QR2を作り直す" : "QR2を発行"}」からご案内を
              {url ? "作り直せます" : "発行できます"}。
            </Notice>
          ) : qr2Status === QR2_APPLIED ? (
            <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3">
              <p className="text-sm leading-relaxed text-warn-100">
                ご契約のご案内（QR2）の発行を申請されています。内容を確かめて、
                承認するか見送るかを選んでください。
              </p>
            </div>
          ) : qr2Status === QR2_REJECTED ? (
            <div className="space-y-2 rounded-lg border border-bad-500/40 bg-bad-500/10 px-4 py-3">
              <p className="text-sm leading-relaxed text-bad-100">
                この代理店へのご契約のご案内（QR2）は、いまは見送っています。
                お渡しできる状態が整ったら、「発行を承認する」を押してください。
              </p>
              {rejectedNote ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">
                  <span className="text-ink-400">見送った理由：</span>
                  {rejectedNote}
                </p>
              ) : null}
            </div>
          ) : qr2Status === QR2_UNAPPLIED ? (
            <Notice tone="info">
              研修には合格していますが、本部の承認がまだです。
              代理店から発行のご依頼を受けたら（お電話・メール・研修の場でも構いません）、
              内容を確かめて「発行を承認する」を押してください。承認するとQR2を発行できます。
            </Notice>
          ) : (
            <Notice tone="warn">
              発行の承認の状況（現在：{qr2Status}）を読み取れませんでした。
              代理店の登録内容をご確認のうえ、お渡しして差し支えなければ
              「発行を承認する」を押してください。
            </Notice>
          )}

          {/* 承認と見送り。申請が届いていなくても本部の判断で進められる。 */}
          <div className="flex flex-wrap items-center gap-3">
            {qr2Status !== QR2_APPROVED ? (
              <form action={approve}>
                <input type="hidden" name="code" value={code} />
                <button type="submit" disabled={busy || suspended} className={primaryBtn}>
                  {approving ? "承認中…" : "発行を承認する"}
                </button>
              </form>
            ) : null}
            {!rejectOpen ? (
              <button
                type="button"
                onClick={() => setRejectOpen(true)}
                disabled={busy}
                className={quietBtn}
              >
                {qr2Status === QR2_APPROVED
                  ? "承認を取り消す"
                  : qr2Status === QR2_REJECTED
                    ? "見送りの理由を書き直す"
                    : "発行を見送る"}
              </button>
            ) : null}
          </div>

          {rejectOpen ? (
            <form action={reject} className="space-y-3">
              <input type="hidden" name="code" value={code} />
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
                  {qr2Status === QR2_APPROVED ? "承認を取り消す理由" : "見送る理由"}
                </span>
                <textarea
                  name="note"
                  rows={3}
                  required
                  maxLength={500}
                  defaultValue={qr2Status === QR2_REJECTED ? rejectedNote : ""}
                  placeholder="例：研修の受講記録が確認できませんでした。受講のうえ、あらためてご相談ください。"
                  disabled={busy}
                  className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm leading-relaxed text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60"
                />
              </label>
              <p className="text-xs leading-relaxed text-ink-400">
                ここに書いた文面は、そのまま相手に伝わります。何が整えばお渡しできるかが
                分かるように書いてください。
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" disabled={busy} className={dangerBtn}>
                  {rejecting
                    ? "保存中…"
                    : qr2Status === QR2_APPROVED
                      ? "この理由で承認を取り消す"
                      : "この理由で見送る"}
                </button>
                <button
                  type="button"
                  onClick={() => setRejectOpen(false)}
                  disabled={busy}
                  className={quietBtn}
                >
                  やめる
                </button>
              </div>
            </form>
          ) : null}
        </div>
      )}

      {url ? (
        <UrlBlock
          title="ご契約のご案内（QR2）"
          description="このQRとURLは、研修に合格し承認を受けた方だけにお渡しください。"
          url={url}
          fileName={`${code}_QR2_ご契約のご案内`}
        />
      ) : null}

      {passed && qr2Status === QR2_APPROVED ? (
        <form action={issue} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="code" value={code} />
          <input type="hidden" name="kind" value="qr2" />
          <button type="submit" disabled={busy || suspended} className={primaryBtn}>
            <QrCode className="h-4 w-4" />
            {issuing ? "発行中…" : url ? "QR2を作り直す" : "QR2を発行"}
          </button>
          {url ? (
            <span className="text-xs text-ink-400">
              作り直してもURLは同じです。お渡しした案内はそのままお使いいただけます。
            </span>
          ) : null}
        </form>
      ) : null}

      <Result state={approveState} />
      <Result state={rejectState} />
      <Result state={issueState} />
    </section>
  );
}

/* ─────────── QRの停止（コンプライアンス対応） ─────────── */

/**
 * 出しているQRを止める欄と、その解除。
 *
 * 広告の出し方や説明の仕方に問題が見つかったときに、本部がその場で
 * 新しいお客様の流入を止められるようにする（コンプライアンス対応）。
 * 稼働状況は変えないので、ポータルへのログインや受注・報酬の確認はこれまでどおり。
 * 代理店そのものを止めるときは、上の「稼働状況の切り替え」を使う。
 */
function FreezeSection({
  code,
  name,
  issued,
  frozen,
  reason,
}: {
  code: string;
  name: string;
  /** いずれかのご案内を発行済みか。発行していなければ止める対象がない。 */
  issued: boolean;
  frozen: boolean;
  /** 止めたときの理由。 */
  reason: string;
}) {
  const [freezeState, freeze, freezing] = useActionState(freezeQrAction, initial);
  const [unfreezeState, unfreeze, unfreezing] = useActionState(unfreezeQrAction, initial);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [unfreezeOpen, setUnfreezeOpen] = useState(false);

  const who = name || code;

  // 保存が終わって画面が新しくなったら、開いていた入力欄を閉じる
  useEffect(() => {
    setFreezeOpen(false);
    setUnfreezeOpen(false);
  }, [frozen]);

  return (
    <section className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
            <ShieldAlert className={cn("h-4 w-4", frozen ? "text-bad-100" : "text-gold-400")} />
            QRの停止
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-300">
            広告の出し方や説明の仕方に問題が見つかったときなど、
            この代理店へのご案内をすぐに止めるための操作です。
            稼働状況は変わりません（ポータルへのログインや、受注・報酬の確認はこれまでどおりです）。
          </p>
        </div>
        {frozen ? <Badge tone="bad">停止中</Badge> : null}
      </div>

      {frozen ? (
        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-bad-500/60 bg-bad-500/15 px-4 py-3">
            <p className="text-sm font-semibold text-bad-100">
              停止中です（理由：{reason || "記録が残っていません"}）
            </p>
            <p className="text-sm leading-relaxed text-bad-100">
              体験のご案内（QR1）とご契約のご案内（QR2）のURLは消してあります。
              この画面からも、代理店へのご案内メールからもお渡しできません。
              いつ・誰が・どの理由で止めたかは、下の「操作の記録」でご確認いただけます。
            </p>
          </div>

          <Notice tone="warn">
            すでにお客様のお手元にあるQR（印刷物・画面の保存）は、読み取り先が当システムの外
            （公式LINE・お支払いのフォーム）にあるため、この操作では読み取れなくなりません。
            出回っているQRの回収と、お客様へのご案内は別途お願いします。
          </Notice>

          {!unfreezeOpen ? (
            <button
              type="button"
              onClick={() => setUnfreezeOpen(true)}
              disabled={unfreezing}
              className={primaryBtn}
            >
              停止を解除して再発行できる状態にする
            </button>
          ) : (
            <ConfirmReasonForm
              code={code}
              action={unfreeze}
              pending={unfreezing}
              label="停止を解除する理由（必須）"
              placeholder="例：ご本人と面談し、広告の表現を修正いただいたことを確認しました。"
              hint={
                "解除しても、止める前のURLは戻りません。体験のご案内（QR1）は発行し直し、" +
                "ご契約のご案内（QR2）は「発行を承認する」からやり直しになります。" +
                "何を確かめて再開したのかを、必ず残してください。"
              }
              confirmQuestion={(v) =>
                `${who} のQRの停止を解除します（理由：${v}）。解除後は、ご案内を発行し直してください。よろしいですか？`
              }
              submitLabel="はい、停止を解除する"
              pendingLabel="解除中…"
              tone="primary"
              onCancel={() => setUnfreezeOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-ink-800 bg-ink-850/60 px-4 py-3">
            <p className="text-sm font-medium text-ink-100">停止すると、こうなります</p>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-300">
              <li>
                ・体験のご案内（QR1）とご契約のご案内（QR2）のURLを消します。この画面からも、
                ご案内メールからもお渡しできなくなります。
              </li>
              <li>
                ・ご契約のご案内（QR2）は「差戻し」に戻ります。再開するときは、
                本部の承認と発行をやり直していただきます。
              </li>
              <li>
                ・稼働状況は変えません。ポータルへのログインはこれまでどおりできます
                （代理店そのものを止めるときは、上の「稼働状況の切り替え」をお使いください）。
              </li>
              <li>
                ・すでにお客様のお手元にあるQRは、読み取り先が当システムの外にあるため、
                この操作では読み取れなくなりません。回収とお客様へのご案内は別途お願いします。
              </li>
            </ul>
          </div>

          {!issued ? (
            <Notice tone="info">
              この代理店にはまだご案内を発行していないため、止める対象がありません。
              これから発行しないようにしたい場合は、上の「発行を見送る」をお使いください。
            </Notice>
          ) : !freezeOpen ? (
            <button
              type="button"
              onClick={() => setFreezeOpen(true)}
              disabled={freezing}
              className={dangerBtn}
            >
              <Ban className="h-4 w-4" />
              このQRを停止する
            </button>
          ) : (
            <ConfirmReasonForm
              code={code}
              action={freeze}
              pending={freezing}
              label="停止する理由（必須）"
              placeholder="例：効果を断定する表現でSNS広告を出しているとのご指摘があり、確認が済むまで停止します。"
              hint={
                "後から「なぜ止めたのか」を確かめられるよう、必ず記録に残します。" +
                "この画面にも表示されますので、事実が分かるように書いてください。"
              }
              confirmQuestion={(v) =>
                `${who} のQRを停止します（理由：${v}）。発行済みのご案内URLは消え、解除しても同じURLは戻りません。よろしいですか？`
              }
              submitLabel="はい、いますぐ停止する"
              pendingLabel="停止中…"
              tone="danger"
              onCancel={() => setFreezeOpen(false)}
            />
          )}
        </div>
      )}

      <Result state={freezeState} />
      <Result state={unfreezeState} />
    </section>
  );
}

/**
 * 理由を書いてから、もう一度確かめて実行するフォーム。
 *
 * 停止も解除も取り消しにくい操作なので、押し間違いで進んでしまわないよう
 * 「よろしいですか？」を必ず1回はさむ。理由が空のままでは先へ進めない。
 */
function ConfirmReasonForm({
  code,
  action,
  pending,
  label,
  placeholder,
  hint,
  confirmQuestion,
  submitLabel,
  pendingLabel,
  tone,
  onCancel,
}: {
  code: string;
  action: (formData: FormData) => void;
  pending: boolean;
  label: string;
  placeholder: string;
  hint: string;
  /** 確認の問いかけ。入力された理由を受け取って文にする。 */
  confirmQuestion: (reason: string) => string;
  submitLabel: string;
  pendingLabel: string;
  tone: "danger" | "primary";
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const ready = reason.trim().length > 0;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="code" value={code} />
      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
          {label}
        </span>
        <textarea
          name="reason"
          rows={3}
          required
          maxLength={400}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            // 書き換えたら、確認はやり直してもらう
            setConfirming(false);
          }}
          placeholder={placeholder}
          disabled={pending}
          className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm leading-relaxed text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60"
        />
      </label>
      <p className="text-xs leading-relaxed text-ink-400">{hint}</p>

      {confirming ? (
        <div className="space-y-3 rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3">
          <p className="text-sm leading-relaxed text-warn-100">{confirmQuestion(reason.trim())}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending || !ready}
              className={tone === "danger" ? dangerBtn : primaryBtn}
            >
              {pending ? pendingLabel : submitLabel}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={quietBtn}
            >
              理由を書き直す
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending || !ready}
            className={quietBtn}
          >
            {ready ? "入力した内容を確かめる" : "理由を入力してください"}
          </button>
          <button type="button" onClick={onCancel} disabled={pending} className={quietBtn}>
            やめる
          </button>
        </div>
      )}
    </form>
  );
}

/* ─────────── 共通の部品 ─────────── */

/** 発行したURLと、そのQR画像。コピーと保存ができる。 */
function UrlBlock({
  title,
  description,
  url,
  fileName,
}: {
  title: string;
  description: string;
  url: string;
  fileName: string;
}) {
  const image = qrImageUrl(url);

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850/60 p-4">
      <div className="flex flex-wrap items-start gap-5">
        {image ? (
          <div className="shrink-0 rounded-lg bg-white p-2">
            {/* QR画像はこの画面の中で作っている（外部のQR作成サービスには送らない） */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={`${title}のQRコード`} className="h-36 w-36" />
          </div>
        ) : null}

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-sm font-medium text-ink-100">{title}</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-400">{description}</p>
          </div>

          <div className="scroll-x rounded-md border border-ink-700 bg-ink-950 px-3 py-2">
            <span className="font-mono text-xs whitespace-nowrap text-gold-300 select-all">
              {url}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={url} />
            {image ? (
              <a href={image} download={`${fileName}.svg`} className={quietBtn}>
                <Download className="h-4 w-4" />
                QR画像を保存
              </a>
            ) : null}
          </div>

          {!image ? (
            <p className="text-xs leading-relaxed text-warn-100">
              QRの画像を作れませんでした。上のURLをそのままお伝えください。
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={cn(quietBtn, done && "border-good-500/50 text-good-100")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setFailed(false);
            setDone(true);
            window.setTimeout(() => setDone(false), 2000);
          } catch {
            setFailed(true);
          }
        }}
      >
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {done ? "コピーしました" : "URLをコピー"}
      </button>
      {failed ? (
        <span className="text-xs text-warn-100">
          コピーできませんでした。URLの文字を選んでコピーしてください。
        </span>
      ) : null}
    </span>
  );
}

/** 操作の結果。うまくいったこと・できなかったことを日本語で出す。 */
function Result({ state }: { state: QrActionState }) {
  if (state.error) return <Notice tone="bad">{state.error}</Notice>;
  if (state.ok) return <Notice tone="info">{state.ok}</Notice>;
  return null;
}
