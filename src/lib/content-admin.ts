import "server-only";

/**
 * 「お知らせ」の登録・修正・削除（本部専用）。
 *
 * 読み取り側（src/lib/content.ts）は公開可能キーで「公開済みのお知らせ」だけを取る。
 * こちらは秘密鍵を使うため、下書きも含めて全件が見えるし、書き換えもできる。
 *
 * 秘密鍵（SUPABASE_SECRET_KEY）は絶対にブラウザへ渡さない。
 * このファイルの先頭で "server-only" を読み込んでいるので、
 * クライアントコンポーネントから import した時点でビルドが失敗する。
 *
 * 本部はこの画面からしか操作しない前提。Supabase の管理画面は触らせない。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

const TABLE = "portal_notices";
const COLUMNS = "id,title,body,published_on,important,published,created_at";

/** お知らせを登録できる状態か（秘密鍵が設定されているか）。 */
export function noticesWritable(): boolean {
  return Boolean(SUPABASE_URL && SECRET_KEY);
}

function requireConfig(): { url: string; key: string } {
  if (!SUPABASE_URL || !SECRET_KEY) {
    throw new Error(
      "お知らせの保存先が設定されていないため、登録・修正ができません。サーバーの設定に保存先のアドレスと書き込み用キーを登録してください。",
    );
  }
  return { url: SUPABASE_URL, key: SECRET_KEY };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request(
  path: string,
  init: { method: Method; body?: unknown; prefer?: string },
): Promise<unknown> {
  const { url, key } = requireConfig();

  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.prefer) headers["Prefer"] = init.prefer;

  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // 本部が直前に登録したものが出ないと操作できないので、ここは常に取り直す。
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "お知らせの保存先に接続できませんでした。通信の状態をご確認のうえ、もう一度お試しください。",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `お知らせの保存先でエラーが返りました（HTTP ${res.status}）${
        detail ? `: ${detail.slice(0, 160)}` : ""
      }`,
    );
  }

  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("お知らせの保存先からの応答を読み取れませんでした。");
  }
}

/* ---------- 型 ---------- */

export type AdminNotice = {
  id: string;
  title: string;
  body: string;
  /** "YYYY-MM-DD"。未入力なら空文字。 */
  publishedAt: string;
  important: boolean;
  /** 代理店の画面に出ているか。false は下書き。 */
  published: boolean;
  /** 登録した日時（ISO文字列）。未取得なら空文字。 */
  createdAt: string;
};

export type NoticeInput = {
  title: string;
  body: string;
  /** "YYYY-MM-DD"。空文字なら未設定として保存する。 */
  publishedAt: string;
  important: boolean;
  published: boolean;
};

type Row = {
  id: string | number;
  title: string | null;
  body: string | null;
  published_on: string | null;
  important: boolean | null;
  published: boolean | null;
  created_at: string | null;
};

function toNotice(r: Row): AdminNotice {
  return {
    id: String(r.id),
    title: r.title ?? "",
    body: r.body ?? "",
    publishedAt: r.published_on ? r.published_on.slice(0, 10) : "",
    important: Boolean(r.important),
    published: Boolean(r.published),
    createdAt: r.created_at ?? "",
  };
}

function toPayload(input: NoticeInput) {
  return {
    title: input.title,
    body: input.body,
    published_on: input.publishedAt || null,
    important: input.important,
    published: input.published,
  };
}

/**
 * id は必ず数字であることを確かめてから絞り込み条件に埋める。
 * ここを素通りさせると、条件なしの DELETE で全件消える事故につながる。
 */
function byId(id: string): string {
  const clean = String(id ?? "").trim();
  if (!/^\d+$/.test(clean)) {
    throw new Error(
      "対象のお知らせを特定できませんでした。画面を読み込み直してから、もう一度お試しください。",
    );
  }
  return `${TABLE}?id=eq.${clean}`;
}

/** 日本時間の今日を "YYYY-MM-DD" で返す。公開日の初期値に使う。 */
export { todayInJapan } from "./jst";

/* ---------- 操作 ---------- */

/** 下書きも含めて全件取得する。公開日の新しい順。 */
export async function listAllNotices(): Promise<AdminNotice[]> {
  const rows = (await request(
    `${TABLE}?select=${COLUMNS}&order=published_on.desc.nullslast,id.desc&limit=200`,
    { method: "GET" },
  )) as Row[] | null;
  return (rows ?? []).map(toNotice);
}

/** 1件だけ取得する。無ければ null。 */
export async function getNotice(id: string): Promise<AdminNotice | null> {
  const rows = (await request(`${byId(id)}&select=${COLUMNS}&limit=1`, {
    method: "GET",
  })) as Row[] | null;
  const row = rows?.[0];
  return row ? toNotice(row) : null;
}

/** 新しいお知らせを登録する。 */
export async function createNotice(input: NoticeInput): Promise<AdminNotice> {
  const rows = (await request(TABLE, {
    method: "POST",
    body: toPayload(input),
    prefer: "return=representation",
  })) as Row[] | null;
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      "登録はできたようですが、保存された内容を確認できませんでした。一覧を読み込み直してご確認ください。",
    );
  }
  return toNotice(row);
}

/** 既存のお知らせを書き換える。 */
export async function updateNotice(id: string, input: NoticeInput): Promise<AdminNotice> {
  const rows = (await request(`${byId(id)}&select=${COLUMNS}`, {
    method: "PATCH",
    body: toPayload(input),
    prefer: "return=representation",
  })) as Row[] | null;
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      "対象のお知らせが見つかりませんでした。ほかの担当者が先に削除した可能性があります。画面を読み込み直してご確認ください。",
    );
  }
  return toNotice(row);
}

/** お知らせを削除する。消したタイトルを返す（画面の確認メッセージに使う）。 */
export async function deleteNotice(id: string): Promise<string> {
  const rows = (await request(`${byId(id)}&select=${COLUMNS}`, {
    method: "DELETE",
    prefer: "return=representation",
  })) as Row[] | null;
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      "対象のお知らせが見つかりませんでした。すでに削除されている可能性があります。画面を読み込み直してご確認ください。",
    );
  }
  return toNotice(row).title;
}
