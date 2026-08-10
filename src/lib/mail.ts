import "server-only";
import nodemailer from "nodemailer";
import { audit } from "./db";

/**
 * メールを送る。
 *
 * これまで Make が SMTP 接続で送っていたものを、ここから送る。
 * 差出人は vis@metore0403.com（独自ドメイン。フリーメールは UTAGE/Xserver で弾かれる）。
 *
 * 送信に失敗しても業務は止めない。失敗は操作記録に残し、本部が気づけるようにする。
 */

const HOST = process.env.SMTP_HOST ?? "";
const PORT = Number(process.env.SMTP_PORT ?? "465");
const USER = process.env.SMTP_USER ?? "";
const PASS = process.env.SMTP_PASS ?? "";
const FROM = process.env.MAIL_FROM ?? USER;
/** 本部が受け取るアドレス。採点依頼などの宛先。 */
export const HQ_MAIL = process.env.HQ_MAIL ?? USER;

/**
 * 代理店のマイページ（このポータル）のURL。承認の案内メールに載せる。
 *
 * PORTAL_URL を設定しておくとそれを使う。設定が無いときは Vercel が用意する
 * 本番のドメインを使う。どちらも無いときは空文字を返し、メールには
 * 「本部よりご案内します」と書く（当てずっぽうのURLを載せない）。
 */
export const PORTAL_URL = (() => {
  const fixed = (process.env.PORTAL_URL ?? "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  return vercel ? `https://${vercel.replace(/\/+$/, "")}` : "";
})();

export function mailConfigured(): boolean {
  return Boolean(HOST && USER && PASS);
}

/**
 * メールサーバーの応答を待つ上限（10秒）。
 *
 * 既定のままだと、メールサーバーが黙り込んだとき（送信口が塞がれている、
 * 先方が落ちている等）数分単位で待たされる。その間、承認ボタンを押した
 * 本部の画面は固まったままになり、実行時間の上限で切られて
 * 「承認できたのか」「メールは届いたのか」が画面に出ないまま終わる。
 * それを避けるため、短く区切って「送れなかった」をすぐ返す。
 */
const TIMEOUT_MS = 10_000;

/**
 * メールの送信口。1つだけ作って使い回す。
 * 送るたびに作り直すと、そのつど接続を張り直すことになるため。
 */
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465, // 465 は SSL、587 は STARTTLS
      auth: { user: USER, pass: PASS },
      connectionTimeout: TIMEOUT_MS, // つながるまでの待ち時間
      greetingTimeout: TIMEOUT_MS, // 先方の最初の応答を待つ時間
      socketTimeout: TIMEOUT_MS, // やり取りの途中で止まったときの待ち時間
    });
  }
  return transporter;
}

/** 待ち時間切れは、そのままだと英語の短い文なので日本語で言い直す。 */
function readableError(e: unknown): string {
  const code =
    typeof e === "object" && e !== null && "code" in e
      ? String((e as { code?: unknown }).code ?? "")
      : "";
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET") {
    return "メールサーバーに届きませんでした（応答待ちの上限を超えました）。";
  }
  return e instanceof Error ? e.message : "不明なエラー";
}

export type SendResult = { ok: true } | { ok: false; error: string };

export async function sendMail(
  to: string,
  subject: string,
  body: string,
): Promise<SendResult> {
  if (!mailConfigured()) {
    return { ok: false, error: "メールの送信設定（SMTP）がまだ入っていません。" };
  }
  if (!to.trim()) {
    return { ok: false, error: "宛先が空です。" };
  }
  try {
    await getTransporter().sendMail({
      from: `VIS 事務局 <${FROM}>`,
      to,
      subject,
      text: body,
    });
    await audit("system", "メール送信", { type: "mail", key: to }, { 件名: subject });
    return { ok: true };
  } catch (e) {
    const msg = readableError(e);
    await audit("system", "メール送信失敗", { type: "mail", key: to }, {
      件名: subject,
      理由: msg,
    });
    console.error("[mail]", e);
    return { ok: false, error: msg };
  }
}

/* ═══════════════════════ 文面 ═══════════════════════ */

const SIGN = `
──────────────────────
目のトレーニング株式会社 VIS 事務局
${FROM}
──────────────────────`;

/** まだお渡しできていないものの書き方。文面の中でそろえる。 */
const LATER = "（本部よりお渡しします）";

/**
 * マイページのご案内。3つの文面で同じものを使う。
 *
 * パスワードそのものは絶対に書かない。メールは転送も盗み見もされうるため、
 * 発行済みかどうかだけを伝え、値は別の手段でお渡しする。
 */
function portalGuide(
  code: string,
  portalUrl: string,
  passwordIssued: boolean,
): string {
  return `  マイページ　： ${portalUrl || "（本部よりご案内します）"}
  ログインID　： ${code}
  パスワード　： ${
    passwordIssued
      ? "本部よりお伝えしたものをお使いください"
      : "本部からあらためてお伝えします"
  }`;
}

/**
 * 代理店を承認したときの案内。
 *
 * 相手の立場で内容を変える（2026-08-07 会議の指摘 #2:
 * 会社としての代理店登録に、個人のライセンス登録と同じQR案内が送られていた）。
 *
 *   会社　　　　… QRは書かない。マイページのご案内だけ。
 *                 お客様にお見せするQRは、販売ライセンスをお持ちの
 *                 スタッフごとにお渡しするものだから。
 *   スタッフ　　… 個別の QR1／QR2 と、マイページのご案内。
 *   取次パートナー… 個別QRは出さない。共通の公式LINEとご紹介フォーム。
 *
 * QR1／QR2 のURLは、発行済みのときだけ載せる。まだのときは
 * 「本部よりお渡しします」と書く（空欄のURLをお送りしない）。
 */
export function approvalMail(opts: {
  name: string;
  code: string;
  kind: "会社" | "スタッフ" | "取次パートナー";
  /** マイページのURL。空のときは「本部よりご案内します」と書く。 */
  portalUrl: string;
  /**
   * ログイン用のパスワードを発行済みか。
   * パスワードの値そのものはメールに載せない（この引数も値は受け取らない）。
   */
  passwordIssued?: boolean;
  qr1Url?: string;
  qr2Url?: string;
  lineQrUrl?: string;
  tossFormUrl?: string;
}): { subject: string; body: string } {
  const { name, code, kind, portalUrl } = opts;
  const passwordIssued = opts.passwordIssued === true;

  if (kind === "取次パートナー") {
    // 取次パートナーに個別QRは出さない（2026-07-30 決定・2026-08-07 でバグ確定）
    return {
      subject: "【VIS】取次パートナー登録が完了しました",
      body: `${name} 様

このたびは VIS 取次パートナーにご登録いただき、ありがとうございます。
下記のとおり承認いたしました。

  取次店コード： ${code}

■ お客様のご紹介
お客様をご紹介いただく際は、下記のフォームからお願いいたします。
このフォームには取次店コードが入っており、どなたからのご紹介かが
本部に届きます。

  ご紹介フォーム： ${opts.tossFormUrl || "（本部よりご案内します）"}

■ お客様への最初のご案内
共通の公式LINEをご利用ください。取次パートナーの皆さまには
個別のQRコードはお渡ししておりません。

  公式LINE： ${opts.lineQrUrl || "（本部よりご案内します）"}

■ マイページ
ご紹介いただいたお客様の状況は、マイページでもご確認いただけます。

${portalGuide(code, portalUrl, passwordIssued)}

ご紹介後のお客様対応は、担当の代理店より順次ご連絡いたします。
${SIGN}`,
    };
  }

  if (kind === "スタッフ") {
    return {
      subject: "【VIS】販売ライセンスの登録が完了しました",
      body: `${name} 様

販売ライセンスのご登録が完了しました。

  スタッフコード： ${code}

■ お客様へのご案内
下記の2つをお使いください。

  体験のご案内（QR1）　： ${opts.qr1Url || LATER}
  ご契約のご案内（QR2）： ${opts.qr2Url || LATER}

ご契約のご案内（QR2）は、研修に合格し本部の承認を受けた方のみ
お使いいただけます。

■ マイページ
ご担当のお客様の状況と、ご自身の売上はマイページでご確認いただけます。
報酬の金額は所属先の代理店にお問い合わせください。

${portalGuide(code, portalUrl, passwordIssued)}

はじめてログインされましたら、アカウント設定からパスワードのご変更を
お願いいたします。
${SIGN}`,
    };
  }

  /*
   * 会社としての代理店登録。
   * ここにQRのご案内は入れない（会社にお渡しするものではないため）。
   */
  return {
    subject: "【VIS】代理店登録が完了しました／マイページのご案内",
    body: `${name} 御中

このたびは VIS 代理店にご登録いただき、ありがとうございます。
下記のとおり承認いたしました。

  代理店コード： ${code}

■ マイページ
ご契約状況・お客様の一覧・売上と報酬は、マイページでご確認いただけます。

${portalGuide(code, portalUrl, passwordIssued)}

はじめてログインされましたら、アカウント設定からパスワードのご変更を
お願いいたします。

■ 配下の登録について
スタッフや取次パートナーのご登録は、本部までご連絡ください。
枠の空き状況もマイページでご確認いただけます。

■ お客様へのご案内（QR）について
お客様にお見せするご案内（QRコード）は、販売ライセンスをお持ちの
スタッフの方それぞれにお渡しします。ご登録の際は本部までご連絡ください。
${SIGN}`,
  };
}

/**
 * 受注が入ったときに、獲得した代理店へ送るお知らせ（Make のスケジュール#8）。
 *
 * 宛先がスタッフ（コード区分 02）のときは、報酬のご案内を書かない。
 * マイページはスタッフに報酬の金額を出さないため（2026-04-23 決定:
 * 金額が見えるのは親アカウントだけ）、書いてしまうと
 * 「報酬が見られると書いてあるのに出ない」というお問い合わせを招く。
 */
export function acquisitionMail(opts: {
  agencyName: string;
  customerName: string;
  amount: number;
  productName: string;
  /** 宛先がスタッフ（コード区分 02）か。true のとき報酬の記述を出さない。 */
  isStaff?: boolean;
}): { subject: string; body: string } {
  const isStaff = opts.isStaff === true;
  // スタッフは個人あて、会社・取次パートナーは組織あて。
  const honorific = isStaff ? "様" : "御中";
  const guide = isStaff
    ? `配送の状況とご自身の売上は、マイページの「売上・報酬」から
ご確認いただけます。

報酬の金額は所属先の代理店にお問い合わせください。`
    : `配送の状況と報酬の見込みは、マイページの「売上・報酬」から
ご確認いただけます。

報酬は配送完了をもって確定いたします。`;

  return {
    subject: "【VIS】ご成約のお知らせ",
    body: `${opts.agencyName} ${honorific}

お客様のご成約がありましたのでお知らせいたします。

  お客様： ${opts.customerName} 様
  商品　： ${opts.productName || "VIS本体"}
  金額　： ${opts.amount.toLocaleString()} 円

${guide}
${SIGN}`,
  };
}

/** ライセンステストの提出を本部に知らせる（Make の #17）。 */
export function licenseTestMail(opts: {
  name: string;
  agencyCode?: string;
  score?: string;
  detail?: string;
}): { subject: string; body: string } {
  return {
    subject: `【VIS】ライセンステストの提出がありました（${opts.name} 様）`,
    body: `ライセンステストの提出がありました。採点をお願いいたします。

  お名前　　： ${opts.name}
  所属コード： ${opts.agencyCode || "（未入力）"}
  自動採点　： ${opts.score || "（なし）"}

${opts.detail || ""}

合否をご確認のうえ、合格の場合は代理店マスタの研修ステータスを
「合格」に変更してください。
${SIGN}`,
  };
}
