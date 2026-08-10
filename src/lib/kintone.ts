import "server-only";

/**
 * kintone REST クライアント。
 *
 * 実装上の注意（過去に本番で踏んだ罠）:
 *  - GET に Content-Type ヘッダを付けると kintone は CB_IL02「不正なリクエストです」を返す。
 *    そのため GET では絶対にヘッダを付けない。
 *  - 4xx を握りつぶすと「成功したのに書けていない」状態になるため、必ず例外にする。
 */

const BASE = process.env.KINTONE_BASE_URL ?? "";
const AUTH = process.env.KINTONE_AUTH ?? "";

export const APP = {
  agency: Number(process.env.KINTONE_APP_AGENCY ?? 9),
  order: Number(process.env.KINTONE_APP_ORDER ?? 10),
  reward: Number(process.env.KINTONE_APP_REWARD ?? 11),
  product: Number(process.env.KINTONE_APP_PRODUCT ?? 12),
  demo: Number(process.env.KINTONE_APP_DEMO ?? 13),
  lead: Number(process.env.KINTONE_APP_LEAD ?? 14),
  notice: process.env.KINTONE_APP_NOTICE ? Number(process.env.KINTONE_APP_NOTICE) : null,
  document: process.env.KINTONE_APP_DOCUMENT ? Number(process.env.KINTONE_APP_DOCUMENT) : null,
} as const;

export class KintoneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "KintoneError";
  }
}

function assertConfigured() {
  if (!BASE || !AUTH) {
    throw new KintoneError(
      "kintone の接続情報が設定されていません。.env.local の KINTONE_BASE_URL と KINTONE_AUTH を確認してください。",
      500,
    );
  }
}

/** kintone のレコード1件。値は { value } でくるまれている。 */
export type KintoneRecord = Record<string, { value: unknown }>;

/** レコードから文字列を取り出す。未設定なら空文字。 */
export function str(record: KintoneRecord | undefined, field: string): string {
  const v = record?.[field]?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** レコードから数値を取り出す。空欄・非数値なら 0。 */
export function num(record: KintoneRecord | undefined, field: string): number {
  const raw = str(record, field);
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** クエリに埋め込む文字列をエスケープする（" と \ を無害化）。 */
export function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type FetchOpts = { revalidate?: number };

async function call<T>(
  path: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<T> {
  assertConfigured();
  const res = await fetch(`${BASE}/k/v1/${path}`, {
    ...init,
    headers: { "X-Cybozu-Authorization": AUTH, ...(init.headers ?? {}) },
    cache: opts.revalidate === undefined ? "no-store" : undefined,
    next: opts.revalidate === undefined ? undefined : { revalidate: opts.revalidate },
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* JSON でない応答はそのまま下でエラーにする */
  }

  if (!res.ok) {
    const b = body as { code?: string; message?: string } | null;
    throw new KintoneError(
      b?.message ?? `kintone への接続に失敗しました (HTTP ${res.status})`,
      res.status,
      b?.code,
    );
  }
  return body as T;
}

/** レコードを取得する。GET なので Content-Type は付けない。 */
export async function getRecords(
  app: number,
  query: string,
  fields?: string[],
  opts: FetchOpts = {},
): Promise<KintoneRecord[]> {
  const params = new URLSearchParams();
  params.set("app", String(app));
  if (query) params.set("query", query);
  fields?.forEach((f, i) => params.set(`fields[${i}]`, f));
  const data = await call<{ records: KintoneRecord[] }>(
    `records.json?${params.toString()}`,
    { method: "GET" },
    opts,
  );
  return data.records ?? [];
}

/** 件数だけを取得する（レコード本体を転送しないので速い）。 */
export async function countRecords(
  app: number,
  query: string,
  opts: FetchOpts = {},
): Promise<number> {
  const params = new URLSearchParams();
  params.set("app", String(app));
  if (query) params.set("query", `${query} limit 1`);
  params.set("totalCount", "true");
  const data = await call<{ totalCount: string }>(
    `records.json?${params.toString()}`,
    { method: "GET" },
    opts,
  );
  return Number(data.totalCount ?? 0);
}

/** レコードを1件更新する。 */
export async function updateRecord(
  app: number,
  id: string | number,
  record: Record<string, { value: unknown }>,
): Promise<void> {
  await call("record.json", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app, id: String(id), record }),
  });
}

/** レコードを1件作成し、作成された ID を返す。 */
export async function createRecord(
  app: number,
  record: Record<string, { value: unknown }>,
): Promise<string> {
  const data = await call<{ id: string }>("record.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app, record }),
  });
  return data.id;
}
