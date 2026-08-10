import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { APP, getRecords, q, str, updateRecord } from "./kintone";
import type { Viewer, AgencyRank } from "./types";

const COOKIE = "vis_session";
const MAX_AGE = 60 * 60 * 8; // 8時間

/** App9 に用意するパスワード保存用フィールド。 */
export const PASSWORD_FIELD = "ポータルパスワード";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET が設定されていません。");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(viewer: Viewer): string {
  const body = Buffer.from(
    JSON.stringify({ v: viewer, exp: Date.now() + MAX_AGE * 1000 }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): Viewer | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      v: Viewer;
      exp: number;
    };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

/** 代理店コードで App9 の生レコードを引く（全フィールド）。 */
async function rawAgency(code: string) {
  const rows = await getRecords(APP.agency, `代理店コード = ${q(code)} limit 1`);
  return rows[0] ?? null;
}

/**
 * 現在ログインしている人を返す。未ログインなら null。
 *
 * Cookie の署名を確かめるだけでは足りない。本部が代理店を停止しても、
 * 署名済みトークンの有効期限が切れるまで見え続けてしまうため、
 * 代理店の場合は毎回 App9 の稼働ステータスを引き直して確認する。
 * 同一リクエスト内では cache() で1回にまとめる。
 */
export const currentViewer = cache(async (): Promise<Viewer | null> => {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const viewer = decode(token);
  if (!viewer) return null;
  if (viewer.kind === "hq") return viewer;

  try {
    const record = await rawAgency(viewer.code);
    if (!record) return null;
    if (str(record, "稼働ステータス") !== "稼働中") return null;
    // 表示名とランクは常に最新のものを使う
    return {
      kind: "agency",
      label: str(record, "法人名または氏名") || viewer.code,
      code: str(record, "代理店コード"),
      rank: (str(record, "代理店ランク") || "") as AgencyRank | "",
      recordId: str(record, "レコード番号"),
    };
  } catch {
    // kintone に繋がらないときにログアウト扱いにすると何も見えなくなるため、
    // 署名済みトークンの内容をそのまま使う（停止の反映は次回接続時）。
    return viewer;
  }
});

export async function startSession(viewer: Viewer): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, encode(viewer), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export type LoginResult = { ok: true; viewer: Viewer } | { ok: false };

/**
 * ログインする。
 *
 * 失敗の理由は呼び出し元に返さない。「そのコードは実在する」「まだパスワード未設定だ」
 * といった情報を未認証の相手に返すと、狙うべきアカウントを選別されてしまうため。
 */
export async function login(loginId: string, password: string): Promise<LoginResult> {
  const id = loginId.trim();
  if (!id || !password) return { ok: false };

  // 本部アカウント
  const hqId = process.env.HQ_LOGIN_ID;
  const hqHash = process.env.HQ_PASSWORD_HASH;
  if (hqId && hqHash && id.toLowerCase() === hqId.toLowerCase()) {
    const ok = await bcrypt.compare(password, hqHash);
    return ok ? { ok: true, viewer: { kind: "hq", label: "VIS 本部" } } : { ok: false };
  }

  const record = await rawAgency(id);
  if (!record) return { ok: false };
  if (str(record, "稼働ステータス") !== "稼働中") return { ok: false };

  const hash = str(record, PASSWORD_FIELD);
  if (!hash) return { ok: false };
  const ok = await bcrypt.compare(password, hash);
  if (!ok) return { ok: false };

  return {
    ok: true,
    viewer: {
      kind: "agency",
      label: str(record, "法人名または氏名") || id,
      code: str(record, "代理店コード"),
      rank: (str(record, "代理店ランク") || "") as AgencyRank | "",
      recordId: str(record, "レコード番号"),
    },
  };
}

/** 読みまちがえない文字だけで一時パスワードを作る（0/O、1/l を除く）。 */
function generateTempPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[randomInt(chars.length)];
  return out;
}

export type IssueResult =
  | { ok: true; password: string; agencyName: string }
  | { ok: false; message: string };

/**
 * 本部が代理店の初回パスワード（一時パスワード）を発行する。
 *
 * 代理店が自分で設定できる仕組みにはしない。代理店コードもメールアドレスも
 * QR の URL や承認メールに載る準公開情報のため、第三者が先に設定して
 * なりすませてしまうため。発行は必ず本部の操作を通す。
 */
export async function issueTemporaryPassword(code: string): Promise<IssueResult> {
  const record = await rawAgency(code.trim());
  if (!record) return { ok: false, message: "その代理店コードは見つかりませんでした。" };

  const password = generateTempPassword();
  const hash = await bcrypt.hash(password, 10);
  try {
    await updateRecord(APP.agency, str(record, "レコード番号"), {
      [PASSWORD_FIELD]: { value: hash },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return {
      ok: false,
      message: `パスワードを保存できませんでした。${msg}（代理店マスタに「ポータルパスワード」フィールドがあるかご確認ください）`,
    };
  }
  return { ok: true, password, agencyName: str(record, "法人名または氏名") || code };
}

export type ChangeResult = { ok: true } | { ok: false; message: string };

/** ログイン中の代理店が自分のパスワードを変更する。 */
export async function changeOwnPassword(
  code: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangeResult> {
  if (newPassword.length < 10) {
    return { ok: false, message: "新しいパスワードは10文字以上で設定してください。" };
  }
  if (newPassword.toLowerCase().includes(code.toLowerCase())) {
    return { ok: false, message: "代理店コードを含むパスワードは設定できません。" };
  }

  const record = await rawAgency(code);
  if (!record) return { ok: false, message: "アカウントが見つかりませんでした。" };

  const hash = str(record, PASSWORD_FIELD);
  if (!hash || !(await bcrypt.compare(currentPassword, hash))) {
    return { ok: false, message: "現在のパスワードが違います。" };
  }

  try {
    await updateRecord(APP.agency, str(record, "レコード番号"), {
      [PASSWORD_FIELD]: { value: await bcrypt.hash(newPassword, 10) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, message: `保存できませんでした。${msg}` };
  }
  return { ok: true };
}

/**
 * ポータルのパスワードが発行済みの代理店コードの集合。
 *
 * ポータルパスワードのフィールドがまだ作られていない環境でも落ちないよう、
 * フィールド指定なしで取得し、無ければ空集合を返す。
 */
export async function listCodesWithPassword(): Promise<Set<string>> {
  try {
    const rows = await getRecords(
      APP.agency,
      "order by 代理店コード asc limit 500",
    );
    const out = new Set<string>();
    for (const r of rows) {
      if (str(r, PASSWORD_FIELD)) out.add(str(r, "代理店コード"));
    }
    return out;
  } catch {
    return new Set();
  }
}
