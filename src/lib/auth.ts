import "server-only";
import { normalizeCode } from "./intake";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { select, selectAll, selectOne, update } from "./db";
import type { Viewer, AgencyRank } from "./types";
import { clearFailures, isLocked, recordFailure } from "./rate-limit";

/**
 * 応答時間の差から「そのコードが実在するか」を推測されないようにするための
 * 捨てハッシュ。どの失敗経路でも必ず1回 bcrypt.compare を通す。
 */
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

const COOKIE = "vis_session";
const MAX_AGE = 60 * 60 * 8; // 8時間

/** App9 に用意するパスワード保存用フィールド。 */
export const PASSWORD_FIELD = "portal_password";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET が設定されていません。");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** パスワードハッシュから作る短い指紋。ハッシュ自体はトークンに入れない。 */
function fingerprint(hash: string): string {
  return createHmac("sha256", secret()).update(hash).digest("base64url").slice(0, 16);
}

function encode(viewer: Viewer, fp: string): string {
  const body = Buffer.from(
    JSON.stringify({ v: viewer, fp, exp: Date.now() + MAX_AGE * 1000 }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): { viewer: Viewer; fp: string } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      v: Viewer;
      fp?: string;
      exp: number;
    };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return { viewer: parsed.v, fp: parsed.fp ?? "" };
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

/** データベースの値を文字列にする。null や undefined は空文字。 */
function str(r: Row | null, k: string): string {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

/** 代理店コードで1件引く。 */
async function rawAgency(code: string): Promise<Row | null> {
  return selectOne<Row>(`agencies?select=*&code=eq.${encodeURIComponent(code)}`);
}

/**
 * ポータルにログインしてよい状態か。
 *
 * kintone の稼働ステータスは「未稼働 / 稼働中 / 停止・解約」の3つ。
 * 「未稼働」は登録は済んでいるがまだ販売を始めていない状態で、実データの6割を占める。
 * 契約が切れた「停止・解約」だけを締め出す。
 */
export function canSignIn(status: string): boolean {
  return status !== "停止・解約";
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
  const decoded = decode(token);
  if (!decoded) return null;
  const { viewer, fp } = decoded;

  if (viewer.kind === "hq") {
    // 本部のパスワードを変えたら、既存のセッションも失効させる
    const hqHash = process.env.HQ_PASSWORD_HASH;
    if (hqHash && fp && fp !== fingerprint(hqHash)) return null;
    return viewer;
  }

  try {
    const record = await rawAgency(viewer.code);
    if (!record) return null;
    if (!canSignIn(str(record, "status"))) return null;
    // パスワードを変更・再発行したら、古いセッションはその時点で使えなくする
    const hash = str(record, PASSWORD_FIELD);
    if (!hash) return null;
    if (fp && fp !== fingerprint(hash)) return null;
    // 表示名とランクは常に最新のものを使う
    return {
      kind: "agency",
      label: str(record, "name") || viewer.code,
      code: str(record, "code"),
      rank: (str(record, "rank") || "") as AgencyRank | "",
      recordId: str(record, "id"),
    };
  } catch {
    // kintone に繋がらないときにログアウト扱いにすると何も見えなくなるため、
    // 署名済みトークンの内容をそのまま使う（停止の反映は次回接続時）。
    return viewer;
  }
});

export async function startSession(viewer: Viewer, fp = ""): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, encode(viewer, fp), {
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

export type LoginResult = { ok: true; viewer: Viewer; fp: string } | { ok: false };

/**
 * ログインする。
 *
 * 失敗の理由は呼び出し元に返さない。「そのコードは実在する」「まだパスワード未設定だ」
 * といった情報を未認証の相手に返すと、狙うべきアカウントを選別されてしまうため。
 */
export async function login(
  loginId: string,
  password: string,
  /** 接続元のIPアドレス。分からなければ空でよい（IDごとの制限だけが効く）。 */
  clientIp = "",
): Promise<LoginResult> {
  /*
   * 代理店コードは、招待コードや決済の ?ref= と同じ形にそろえてから引く。
   * ここだけ素の trim だったため、「tsta0001」や全角で打つとログインできず、
   * しかも失敗の回数だけが積まれて、そのうちロックまで進んでいた
   * （失敗の理由は画面に出さない作りなので、本人にも本部にも原因が分からない）。
   * 本部のアカウントは下の方で大文字小文字を無視して比べているので、そちらに合わせる。
   */
  const id = normalizeCode(loginId);
  if (!id || !password) {
    await bcrypt.compare(password || "x", DUMMY_HASH);
    return { ok: false };
  }

  /*
   * 数え方は2通りにする。
   *
   * ログインID ごと … そのアカウントへの総当たりを止める。
   * 接続元ごと      … 1か所から、いろいろなIDを次々に試すのを止める。
   *
   * IDだけで数えていると、5回ずつ相手を変えながら試す限りいくらでも続けられる。
   * 代理店コードは QR や承認メールに載る準公開の情報なので、
   * 「IDは分かっている前提で、当たりのアカウントを探す」やり方が現実的に成り立つ。
   */
  const idKey = `login:${id.toLowerCase()}`;
  const ipKey = clientIp ? `login-ip:${clientIp}` : "";

  // ロック中でも、成功と同じだけ時間をかけてから同じ文面で返す
  if ((await isLocked(idKey)) || (ipKey && (await isLocked(ipKey)))) {
    await bcrypt.compare(password, DUMMY_HASH);
    return { ok: false };
  }

  const key = idKey;
  const fail = async (): Promise<LoginResult> => {
    await recordFailure(idKey);
    if (ipKey) await recordFailure(ipKey);
    return { ok: false };
  };

  // 本部アカウント
  const hqId = process.env.HQ_LOGIN_ID;
  const hqHash = process.env.HQ_PASSWORD_HASH;
  if (hqId && hqHash && id.toLowerCase() === hqId.toLowerCase()) {
    const ok = await bcrypt.compare(password, hqHash);
    if (!ok) return fail();
    await clearFailures(key);
    if (ipKey) await clearFailures(ipKey);
    return {
      ok: true,
      viewer: { kind: "hq", label: "VIS 本部" },
      fp: fingerprint(hqHash),
    };
  }

  const record = await rawAgency(id);
  const hash = record ? str(record, PASSWORD_FIELD) : "";
  const active = record ? canSignIn(str(record, "status")) : false;

  // 実在しない・停止中・未発行のどれでも、必ず1回 bcrypt を通してから返す。
  // ここで早期 return すると、応答時間の差でコードの実在を見分けられてしまう。
  const ok = await bcrypt.compare(password, hash || DUMMY_HASH);
  if (!record || !active || !hash || !ok) return fail();

  await clearFailures(key);
  if (ipKey) await clearFailures(ipKey);
  return {
    ok: true,
    viewer: {
      kind: "agency",
      label: str(record, "name") || id,
      code: str(record, "code"),
      rank: (str(record, "rank") || "") as AgencyRank | "",
      recordId: str(record, "id"),
    },
    fp: fingerprint(hash),
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
    await update(`agencies?id=eq.${encodeURIComponent(str(record, "id"))}`, {
      [PASSWORD_FIELD]: hash,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return {
      ok: false,
      message: `パスワードを保存できませんでした。${msg}`,
    };
  }
  return { ok: true, password, agencyName: str(record, "name") || code };
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
    await update(`agencies?id=eq.${encodeURIComponent(str(record, "id"))}`, {
      [PASSWORD_FIELD]: await bcrypt.hash(newPassword, 10),
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
    // 判定に要るのは2項目だけ。ハッシュを含む全フィールドを引かない。
    // selectAll で最後まで取る。1回の上限（1000件）で切られると、
    // 発行済みの代理店が「未発行」に見え、再発行でいまのパスワードが無効になる。
    const rows = await selectAll<Row>(
      `agencies?select=code,${PASSWORD_FIELD}&order=code.asc`,
    );
    const out = new Set<string>();
    for (const r of rows) {
      if (str(r, PASSWORD_FIELD)) out.add(str(r, "code"));
    }
    return out;
  } catch {
    return new Set();
  }
}
