"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import {
  QR2_APPLIED,
  QR2_APPROVED,
  QR2_REJECTED,
  QR2_UNAPPLIED,
  QR_LABEL,
  TRAINING_PASSED,
  buildQrUrl,
  qr1Blocker,
  qr2Blocker,
  readQrAgency,
  type QrAgency,
  type QrKind,
  type QrSource,
} from "@/lib/qr";

/**
 * QRの発行と、QR2 の承認・見送り。
 *
 * 画面から送られてくる値は信用しない。相手の代理店コードだけを受け取り、
 * 研修の合否も申請の状況もデータベースから引き直してから判断する。
 * 承認・見送り・発行は必ず記録に残す（誰がいつ何をしたかを後から辿るため）。
 *
 * 発行のご依頼は、代理店ポータルの申請だけでなく、電話・メール・研修の場でも届く。
 * どちらでも本部が判断できるよう、承認は「申請中」でなくても行えるようにしている。
 */

/** at は成功のたびに変わる。画面側が表示を切り替える合図に使う。 */
export type QrActionState = {
  error?: string;
  ok?: string;
  /** 発行できたときのご案内URL。画面がすぐ表示できるように返す。 */
  url?: string;
  at?: number;
};

const REJECT_NOTE_MAX = 500;

/**
 * 本部以外は一切書き換えできない。
 * フォームから代理店コードを受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer) {
    return "ログインの有効期限が切れています。もう一度ログインしてからお試しください。";
  }
  if (viewer.kind !== "hq") return "この操作は本部のアカウントからのみ行えます。";
  return null;
}

/** 記録に残す操作者の名前。 */
async function actorName(): Promise<string> {
  const viewer = await currentViewer();
  return viewer?.label || "本部";
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * 代理店コードを読む。
 * 画面の値をそのまま検索条件に使わないよう、形を確かめてから通す。
 */
function readCode(formData: FormData): string | null {
  const code = text(formData, "code");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(code) ? code : null;
}

function readKind(formData: FormData): QrKind | null {
  const kind = text(formData, "kind");
  return kind === "qr1" || kind === "qr2" ? kind : null;
}

/**
 * 代理店を1件読み、この画面で扱う形にそろえて返す。
 * 判断に使う項目（研修の合否・発行申請の状況など）を取りこぼさないよう、
 * 必ず全項目（select=*）で引く。
 */
async function loadAgency(code: string): Promise<QrAgency | null> {
  const row = await selectOne<QrSource>(
    `agencies?select=*&code=eq.${encodeURIComponent(code)}`,
  );
  return row ? readQrAgency(row) : null;
}

function failed(prefix: string, e: unknown): QrActionState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいてもう一度お試しください。`,
  };
}

const NOT_FOUND =
  "対象の代理店が見つかりませんでした。画面を読み込み直してからお試しください。";
const BAD_CODE =
  "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。";

/** 画面を最新にする。本部の一覧と、その代理店の画面の両方。 */
function refresh(code: string): void {
  revalidatePath("/admin/agencies");
  revalidatePath(`/admin/agencies/${code}`);
}

/* ═══════════════════ QRの発行 ═══════════════════ */

/**
 * QR1 / QR2 のご案内URLを作って保存する。
 *
 * QR2 は「研修に合格」かつ「本部が承認済」でなければ発行しない。
 * 取次パートナーには個別のQRを発行しない（共通の公式LINEをご案内する）。
 */
export async function issueQrAction(
  _prev: QrActionState,
  formData: FormData,
): Promise<QrActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const code = readCode(formData);
  if (!code) return { error: BAD_CODE };

  const kind = readKind(formData);
  if (!kind) {
    return { error: "どちらのご案内を発行するかが分かりませんでした。もう一度お試しください。" };
  }

  const url = buildQrUrl(kind, code);
  let name = code;
  try {
    const agency = await loadAgency(code);
    if (!agency) return { error: NOT_FOUND };
    name = agency.name || code;

    const blocked = kind === "qr2" ? qr2Blocker(agency) : qr1Blocker(agency);
    if (blocked) return { error: blocked };

    const column = kind === "qr2" ? "qr2_url" : "qr1_url";
    const already = kind === "qr2" ? agency.qr2Url : agency.qr1Url;
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, { [column]: url });
    await audit(
      await actorName(),
      kind === "qr2" ? "QR2発行" : "QR1発行",
      { type: "agency", key: code },
      { 代理店: name, ご案内URL: url, 再発行: Boolean(already) },
    );
  } catch (e) {
    return failed(`${QR_LABEL[kind]}を発行できませんでした。`, e);
  }

  refresh(code);
  return {
    ok:
      kind === "qr2"
        ? `${name} のご契約のご案内（QR2）を発行しました。QRと URL をお渡しください。`
        : `${name} の体験のご案内（QR1）を発行しました。QRと URL をお渡しください。`,
    url,
    at: Date.now(),
  };
}

/* ═══════════════════ QR2 の承認・見送り ═══════════════════ */

/**
 * QR2 の発行を本部が承認する。承認しただけでは発行されない（続けて発行を押す）。
 *
 * 代理店からのご依頼は、電話・メール・研修の場など、この画面の外で届くことがある。
 * そのため「発行の申請」が画面に届いていなくても、本部の判断で承認できるようにしている。
 * 止めるのは、取次パートナー・研修に未合格・停止・解約・すでに承認済みのときだけ。
 */
export async function approveQr2Action(
  _prev: QrActionState,
  formData: FormData,
): Promise<QrActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const code = readCode(formData);
  if (!code) return { error: BAD_CODE };

  let name = code;
  /** 承認する前の状態。お知らせの文面を変えるために覚えておく。 */
  let before = QR2_UNAPPLIED;
  try {
    const agency = await loadAgency(code);
    if (!agency) return { error: NOT_FOUND };
    name = agency.name || code;

    if (agency.codeKind === "01") {
      return {
        error:
          "取次パートナーには個別のQRを発行しません。共通の公式LINEとご紹介フォームをご案内してください。",
      };
    }
    if (agency.trainingStatus !== TRAINING_PASSED) {
      return {
        error:
          `${name} はまだ研修に合格していません（現在：${agency.trainingStatus || "未受講"}）。` +
          "合格を確認してから承認してください。",
      };
    }
    if (agency.status === "停止・解約") {
      return {
        error:
          "停止・解約の登録には承認できません。先に稼働状況を確かめて、必要なら戻してください。",
      };
    }
    if (agency.qr2Status === QR2_APPROVED) {
      return {
        error: "すでに承認済みです。「QR2を発行」からご案内を発行してください。",
      };
    }

    before = agency.qr2Status || QR2_UNAPPLIED;

    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      qr2_status: QR2_APPROVED,
      qr2_rejected_note: null,
    });
    await audit(
      await actorName(),
      "QR2発行承認",
      { type: "agency", key: code },
      {
        代理店: name,
        研修: agency.trainingStatus,
        承認前: before,
        申請日: agency.qr2RequestedOn,
      },
    );
  } catch (e) {
    return failed("承認を保存できませんでした。", e);
  }

  refresh(code);
  return {
    ok:
      before === QR2_APPLIED
        ? `${name} の申請を承認しました。続けて「QR2を発行」を押すと、ご案内URLを作成します。`
        : `${name} へのご契約のご案内（QR2）の発行を承認しました。続けて「QR2を発行」を押すと、ご案内URLを作成します。`,
    at: Date.now(),
  };
}

/**
 * QR2 の発行を見送る。理由は必ず残す（相手に伝える文面になる）。
 *
 * 申請が届いているときの差し戻しにも、いったん承認したものの取り消しにも、
 * 理由を書き直したいときにも、同じ操作を使う。
 * 承認を取り消しても、すでにお渡し済みのご案内URLは使えたままなので、
 * その場合はお知らせの文面で必ず注意していただく。
 */
export async function rejectQr2Action(
  _prev: QrActionState,
  formData: FormData,
): Promise<QrActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const code = readCode(formData);
  if (!code) return { error: BAD_CODE };

  const note = text(formData, "note").slice(0, REJECT_NOTE_MAX);
  if (!note) {
    return {
      error: "見送る理由を入力してください。相手にはこの文面がそのまま伝わります。",
    };
  }

  let name = code;
  /** 見送る前の状態。お知らせの文面を変えるために覚えておく。 */
  let before = QR2_UNAPPLIED;
  /** すでにご案内URLをお渡し済みかどうか。 */
  let issued = false;
  try {
    const agency = await loadAgency(code);
    if (!agency) return { error: NOT_FOUND };
    name = agency.name || code;

    if (agency.qr2Status === QR2_REJECTED && agency.qr2RejectedNote === note) {
      return {
        error: "同じ理由がすでに登録されています。文面を変えてから保存してください。",
      };
    }

    before = agency.qr2Status || QR2_UNAPPLIED;
    issued = Boolean(agency.qr2Url);

    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      qr2_status: QR2_REJECTED,
      qr2_rejected_note: note,
    });
    await audit(
      await actorName(),
      before === QR2_APPROVED ? "QR2発行承認取消" : "QR2発行見送り",
      { type: "agency", key: code },
      {
        代理店: name,
        理由: note,
        見送る前: before,
        申請日: agency.qr2RequestedOn,
        発行済み: issued,
      },
    );
  } catch (e) {
    return failed("見送りを保存できませんでした。", e);
  }

  refresh(code);
  const done =
    before === QR2_APPROVED
      ? `${name} への発行の承認を取り消しました。`
      : before === QR2_APPLIED
        ? `${name} の申請を差し戻しました。`
        : `${name} への発行を見送りました。`;
  const next = issued
    ? "すでにお渡し済みのご案内URLはそのまま使えますので、お客様への案内を止める必要があれば直接ご連絡ください。"
    : "理由をお伝えのうえ、整いしだい「発行を承認する」から進めてください。";

  return { ok: `${done}${next}`, at: Date.now() };
}

/* ═══════════════════ 画面から呼ぶ読み取り ═══════════════════ */

/**
 * QRの画面に出す情報をまとめて読む。
 *
 * 代理店マスタの行には研修の合否や申請の状況が入っているが、
 * lib/agencies.ts が返す形にはまだ含まれていないため、
 * 画面（page.tsx）はこちらを使うと取りこぼしがない。
 */
export async function loadQrAgency(code: string): Promise<QrAgency | null> {
  const denied = await denyIfNotHq();
  if (denied) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(code.trim())) return null;
  return loadAgency(code.trim());
}
