import "server-only";

/**
 * Supabase への読み書き。
 *
 * kintone を解約するため、代理店・受注・顧客などの保存先をここに移す。
 * 画面からは直接呼ばず、agencies.ts / orders.ts のような
 * 業務ごとのファイルを通して使う。
 *
 * 使うのは秘密鍵だけ。全テーブルで RLS を有効にしてあり、
 * 公開鍵からは1行も読めない（顧客の個人情報を守るため）。
 */

const URL_BASE = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";

export class DbError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

export function dbConfigured(): boolean {
  return Boolean(URL_BASE && SECRET);
}

function assertConfigured(): void {
  if (!URL_BASE) throw new DbError("SUPABASE_URL が設定されていません。", 500);
  if (!SECRET) throw new DbError("SUPABASE_SECRET_KEY が設定されていません。", 500);
}

type Options = {
  /** 何秒ぶん同じ結果を使い回してよいか。0 なら毎回取りに行く。 */
  revalidate?: number;
  /** 追加のヘッダ（Prefer など）。 */
  headers?: Record<string, string>;
};

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: Options = {},
): Promise<T> {
  assertConfigured();
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.revalidate
      ? { next: { revalidate: opts.revalidate } }
      : { cache: "no-store" as const }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text) as { message?: string; details?: string };
      detail = j.message ?? detail;
    } catch {
      // JSON でなければそのまま
    }
    throw new DbError(
      `データベースへの${method === "GET" ? "読み込み" : "書き込み"}に失敗しました。`,
      res.status,
      detail,
    );
  }
  if (!text) return [] as unknown as T;
  return JSON.parse(text) as T;
}

/** 条件に合う行を取る。PostgREST の書き方をそのまま渡す。 */
export function select<T>(query: string, opts: Options = {}): Promise<T[]> {
  return request<T[]>("GET", query, undefined, opts);
}

/** 1件だけ取る。無ければ null。 */
export async function selectOne<T>(query: string, opts: Options = {}): Promise<T | null> {
  const rows = await select<T>(query.includes("limit=") ? query : `${query}&limit=1`, opts);
  return rows[0] ?? null;
}

/** 追加する。追加した行を返す。 */
export function insert<T>(table: string, rows: unknown): Promise<T[]> {
  return request<T[]>("POST", table, rows, {
    headers: { Prefer: "return=representation" },
  });
}

/**
 * あれば更新、無ければ追加する。
 * conflict には一意制約のある列名を渡す（例: "code"）。
 */
export function upsert<T>(table: string, rows: unknown, conflict: string): Promise<T[]> {
  return request<T[]>("POST", `${table}?on_conflict=${conflict}`, rows, {
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
}

/** 更新する。query には絞り込み条件を含めること（全件更新の事故を防ぐ）。 */
export function update<T>(query: string, patch: unknown): Promise<T[]> {
  if (!query.includes("=")) {
    throw new DbError("更新の条件が指定されていません。", 400);
  }
  return request<T[]>("PATCH", query, patch, {
    headers: { Prefer: "return=representation" },
  });
}

/** 消す。query には絞り込み条件を含めること。 */
export function remove(query: string): Promise<unknown> {
  if (!query.includes("=")) {
    throw new DbError("削除の条件が指定されていません。", 400);
  }
  return request("DELETE", query, undefined, { headers: { Prefer: "return=minimal" } });
}

/** 件数だけ数える。 */
export async function count(table: string, filter = ""): Promise<number> {
  assertConfigured();
  const q = filter ? `${table}?select=id&${filter}` : `${table}?select=id`;
  const res = await fetch(`${URL_BASE}/rest/v1/${q}`, {
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new DbError("件数を取得できませんでした。", res.status);
  const range = res.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  return total && total !== "*" ? Number(total) : 0;
}

/** 値を PostgREST の条件で使える形にする（カンマや括弧を含む値の事故を防ぐ）。 */
export function val(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

/**
 * 操作の記録を残す。
 * 誰がいつ何を承認したかを後から辿れるようにするため（薬機法まわりの要請）。
 * 記録に失敗しても本体の処理は止めない。
 */
export async function audit(
  actor: string,
  action: string,
  target: { type?: string; key?: string } = {},
  detail?: unknown,
): Promise<void> {
  try {
    await insert("audit_log", [
      {
        actor,
        action,
        target_type: target.type ?? null,
        target_key: target.key ?? null,
        detail: detail ?? null,
      },
    ]);
  } catch {
    // 記録できなくても業務は続ける
  }
}
