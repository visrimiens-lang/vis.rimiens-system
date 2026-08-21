"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { resendGuideMailAction } from "./agency-actions";
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
 * QRの発行と、QR2 の承認・見送り、そしてQRの停止（コンプライアンス対応）。
 *
 * 画面から送られてくる値は信用しない。相手の代理店コードだけを受け取り、
 * 研修の合否も申請の状況もデータベースから引き直してから判断する。
 * 承認・見送り・発行・停止は必ず記録に残す（誰がいつ何をしたかを後から辿るため）。
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
 * 停止（凍結）したことを見分けるための目印。
 * 見送りの理由（qr2_rejected_note）の先頭に付けて保存する。
 *
 * 停止は「差戻し」と同じ欄を使うため、目印が無いと
 * 「本部が発行を見送っている」のか「コンプライアンス対応で止めた」のかを
 * 後から見分けられない。
 *
 * ★ 画面側（QrPanel.tsx）にも同じ文字列を置いてある。
 *   片方だけ変えると画面が停止中を見分けられなくなるので、必ず両方そろえること。
 */
const FREEZE_MARK = "【QR停止】";

/** 目印のぶんを引いた、停止の理由に使える長さ。 */
const FREEZE_REASON_MAX = REJECT_NOTE_MAX - FREEZE_MARK.length;

/** いま停止中か。停止の理由は目印の後ろに書いてある。 */
function isFrozen(agency: QrAgency): boolean {
  return (
    agency.qr2Status === QR2_REJECTED && agency.qr2RejectedNote.startsWith(FREEZE_MARK)
  );
}

/** 停止したときの理由。目印を外して返す。 */
function frozenReason(agency: QrAgency): string {
  return agency.qr2RejectedNote.slice(FREEZE_MARK.length).trim();
}

/**
 * 停止中はQRを動かせない。先に停止を解除してもらう。
 * next には「あらためて発行してください。」のように、続きの一文をそのまま渡す。
 */
function frozenBlocker(agency: QrAgency, name: string, next: string): string | null {
  if (!isFrozen(agency)) return null;
  const why = frozenReason(agency);
  return (
    `${name} のQRは停止中です${why ? `（理由：${why}）` : ""}。` +
    `先に「QRの停止」欄で停止を解除してから、${next}`
  );
}

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

    // 停止中に発行し直すと、止めたはずのURLがそのまま戻ってしまう
    const frozen = frozenBlocker(agency, name, "あらためて発行してください。");
    if (frozen) return { error: frozen };

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

  /*
   * 発行したら、そのままご案内をお送りする。
   *
   * 登録した時点で送る案内には、まだ発行していないQRは載らない。
   * 本部が発行したあとに「案内メールを送り直す」を押し忘れると、
   * 相手はQRを受け取れないまま待つことになる。
   * 発行＝渡せる状態になった瞬間なので、ここで自動的に届ける。
   */
  const mailed = await resendGuideMail(code);

  refresh(code);
  const base =
    kind === "qr2"
      ? `${name} のご契約のご案内（QR2）を発行しました。`
      : `${name} の体験のご案内（QR1）を発行しました。`;
  return {
    ok: base + mailed,
    url,
    at: Date.now(),
  };
}

/**
 * 発行したQRを載せた案内メールを送り直す。
 *
 * 送れても送れなくても発行そのものは成立させ、結果を言葉で返す。
 * メールアドレスが未登録のときは、その旨を本部に伝えて手渡しに回してもらう。
 */
async function resendGuideMail(code: string): Promise<string> {
  try {
    const r = await resendGuideMailAction({}, formDataOf({ code }));
    if (r.ok) return "あわせて、ご案内のメールをお送りしました。";
    if (r.error) return `QRと URL をお渡しください。（${r.error}）`;
  } catch {
    // メールの失敗で発行を取り消さない
  }
  return "QRと URL をお渡しください。";
}

/** サーバーアクションに渡す形を作る小さな道具。 */
function formDataOf(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
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
    // 停止中の承認は、記録の残らない解除になってしまう
    const frozen = frozenBlocker(agency, name, "あらためて承認してください。");
    if (frozen) return { error: frozen };

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

    // 停止中に見送りの理由を書き換えると、停止の目印が消えてしまう
    const frozen = frozenBlocker(
      agency,
      name,
      "あらためて見送りの理由を書いてください。",
    );
    if (frozen) return { error: frozen };

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

/* ═══════════════════ QRの停止（コンプライアンス対応） ═══════════════════ */

/**
 * この代理店に出しているQRを止める。
 *
 * 広告や説明の仕方に問題が見つかったときなど、いますぐ新しいお客様の流入を
 * 止めたい場面のための操作。次の3つをまとめて行う。
 *   ・体験のご案内（QR1）とご契約のご案内（QR2）のURLを消す
 *   ・発行の申請を「差戻し」に戻す（承認からやり直しになる）
 *   ・止めた理由を残す（記録と、この画面の表示に使う）
 *
 * 稼働状況（未稼働／稼働中／停止・解約）は変えない。
 * ポータルにはこれまでどおり入れて、受注や報酬の確認は続けられる。
 * 代理店そのものを止めるときは「稼働状況の切り替え」を使う。
 *
 * ★ 止まるのは当システムからのご案内だけ。すでにお渡し済み・印刷済みのQRは
 *   読み取り先が当システムの外（公式LINE・決済フォーム）にあるため、
 *   この操作では読み取れなくならない。回収とお客様へのご連絡は別途必要。
 */
export async function freezeQrAction(
  _prev: QrActionState,
  formData: FormData,
): Promise<QrActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const code = readCode(formData);
  if (!code) return { error: BAD_CODE };

  const reason = text(formData, "reason").slice(0, FREEZE_REASON_MAX);
  if (!reason) {
    return {
      error:
        "停止する理由を入力してください。後から「なぜ止めたのか」を確かめられるよう、必ず記録に残します。",
    };
  }

  let name = code;
  try {
    const agency = await loadAgency(code);
    if (!agency) return { error: NOT_FOUND };
    name = agency.name || code;

    if (isFrozen(agency)) {
      return {
        error:
          `${name} のQRはすでに停止中です。理由を書き直したいときは、` +
          "いったん停止を解除してから、あらためて停止してください。",
      };
    }
    if (!agency.qr1Url && !agency.qr2Url) {
      return {
        error:
          `${name} にはまだご案内を発行していません。止める対象がないため、何も変更していません。` +
          "新しい発行を止めたい場合は「発行を見送る」をお使いください。",
      };
    }

    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      qr1_url: null,
      qr2_url: null,
      qr2_status: QR2_REJECTED,
      qr2_rejected_note: `${FREEZE_MARK}${reason}`,
    });
    await audit(
      await actorName(),
      "QR停止",
      { type: "agency", key: code },
      {
        代理店: name,
        理由: reason,
        止めたQR1: agency.qr1Url || "発行なし",
        止めたQR2: agency.qr2Url || "発行なし",
        停止前の発行の申請: agency.qr2Status,
        稼働状況: agency.status,
      },
    );
  } catch (e) {
    return failed("QRの停止を保存できませんでした。", e);
  }

  refresh(code);
  return {
    ok:
      `${name} のQRを停止しました。この画面とご案内メールからはお渡しできなくなり、` +
      "ご契約のご案内（QR2）は本部の承認からやり直しになります。" +
      "すでにお渡し済み・印刷済みのQRは、読み取り先が当システムの外にあるためこの操作では止まりません。" +
      "回収と、お客様へのご連絡を別途お願いします。",
    at: Date.now(),
  };
}

/**
 * QRの停止を解除する。
 *
 * 解除しても、止める前のURLは戻さない。発行し直していただく。
 * 一度出回ったご案内を止めるための操作なので、同じものを黙って復活させると
 * 何のために止めたのか分からなくなるため。
 *
 * 発行の申請は「未申請」に戻す。体験のご案内（QR1）はすぐ発行でき、
 * ご契約のご案内（QR2）は「発行を承認する」からやり直しになる。
 */
export async function unfreezeQrAction(
  _prev: QrActionState,
  formData: FormData,
): Promise<QrActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const code = readCode(formData);
  if (!code) return { error: BAD_CODE };

  const reason = text(formData, "reason").slice(0, REJECT_NOTE_MAX);
  if (!reason) {
    return {
      error:
        "停止を解除する理由を入力してください。何を確かめて再開したのかを記録に残します。",
    };
  }

  let name = code;
  try {
    const agency = await loadAgency(code);
    if (!agency) return { error: NOT_FOUND };
    name = agency.name || code;

    if (!isFrozen(agency)) {
      return {
        error:
          `${name} のQRはいま停止されていません（発行の申請：${agency.qr2Status}）。` +
          "解除の操作は必要ありません。画面を読み込み直してご確認ください。",
      };
    }

    const before = frozenReason(agency);

    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      qr2_status: QR2_UNAPPLIED,
      qr2_rejected_note: null,
    });
    await audit(
      await actorName(),
      "QR停止解除",
      { type: "agency", key: code },
      {
        代理店: name,
        解除の理由: reason,
        停止したときの理由: before || "（記録なし）",
        再発行: "必要（止める前のURLは戻していません）",
      },
    );
  } catch (e) {
    return failed("停止の解除を保存できませんでした。", e);
  }

  refresh(code);
  return {
    ok:
      `${name} のQRの停止を解除しました。止める前のURLは戻していませんので、発行し直してください。` +
      "体験のご案内（QR1）は「QR1を発行」から、ご契約のご案内（QR2）は研修の合格を確かめて" +
      "「発行を承認する」からお進みください。",
    at: Date.now(),
  };
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
