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

export function mailConfigured(): boolean {
  return Boolean(HOST && USER && PASS);
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
    const transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465, // 465 は SSL、587 は STARTTLS
      auth: { user: USER, pass: PASS },
    });
    await transporter.sendMail({
      from: `VIS 事務局 <${FROM}>`,
      to,
      subject,
      text: body,
    });
    await audit("system", "メール送信", { type: "mail", key: to }, { 件名: subject });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
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

/**
 * 代理店を承認したときの案内。
 *
 * 相手の立場で内容を変える（2026-08-07 会議の指摘 #2:
 * 会社としての登録に、個人向けのQR案内が送られていた）。
 */
export function approvalMail(opts: {
  name: string;
  code: string;
  kind: "会社" | "スタッフ" | "取次パートナー";
  portalUrl: string;
  password?: string;
  qr1Url?: string;
  qr2Url?: string;
  lineQrUrl?: string;
  tossFormUrl?: string;
}): { subject: string; body: string } {
  const { name, code, kind, portalUrl } = opts;

  if (kind === "取次パートナー") {
    // 取次パートナーに個別QRは出さない（2026-07-30 決定・2026-08-07 でバグ確定）
    return {
      subject: "【VIS】取次パートナー登録が完了しました",
      body: `${name} 様

このたびは VIS 取次パートナーにご登録いただき、ありがとうございます。
下記のとおり承認いたしました。

  取次店コード： ${code}

お客様をご紹介いただく際は、下記のフォームからお願いいたします。
  ご紹介フォーム： ${opts.tossFormUrl ?? "（本部よりご案内します）"}

お客様への最初のご案内には、共通の公式LINEをご利用ください。
  公式LINE： ${opts.lineQrUrl ?? "（本部よりご案内します）"}

ご紹介いただいたお客様のその後の状況は、担当の代理店より
ご連絡が入ります。
${SIGN}`,
    };
  }

  if (kind === "スタッフ") {
    return {
      subject: "【VIS】販売ライセンスの登録が完了しました",
      body: `${name} 様

販売ライセンスのご登録が完了しました。

  スタッフコード： ${code}

お客様へのご案内には、下記の2つをお使いください。

  体験のご案内（QR1）： ${opts.qr1Url ?? "（研修合格後にお渡しします）"}
  ご契約のご案内（QR2）： ${opts.qr2Url ?? "（本部の承認後にお渡しします）"}

QR2は、研修に合格し本部の承認を受けた方のみお使いいただけます。
${SIGN}`,
    };
  }

  // 会社としての代理店登録
  return {
    subject: "【VIS】代理店登録が完了しました／マイページのご案内",
    body: `${name} 御中

このたびは VIS 代理店にご登録いただき、ありがとうございます。
下記のとおり承認いたしました。

  代理店コード： ${code}

■ マイページ
ご契約状況・お客様の一覧・売上と報酬は、マイページでご確認いただけます。

  ${portalUrl}
  ログインID： ${code}
  パスワード： ${opts.password ?? "（別途お知らせします）"}

はじめてログインされたら、アカウント設定からパスワードのご変更を
お願いいたします。

■ 配下の登録について
スタッフや取次パートナーのご登録は、本部までご連絡ください。
枠の空き状況もマイページでご確認いただけます。
${SIGN}`,
  };
}

/** 受注が入ったときに、獲得した代理店へ送るお知らせ（Make のスケジュール#8）。 */
export function acquisitionMail(opts: {
  agencyName: string;
  customerName: string;
  amount: number;
  productName: string;
}): { subject: string; body: string } {
  return {
    subject: "【VIS】ご成約のお知らせ",
    body: `${opts.agencyName} 御中

お客様のご成約がありましたのでお知らせいたします。

  お客様： ${opts.customerName} 様
  商品　： ${opts.productName || "VIS本体"}
  金額　： ${opts.amount.toLocaleString()} 円

配送の状況と報酬の見込みは、マイページの「売上・報酬」から
ご確認いただけます。

報酬は配送完了をもって確定いたします。
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
