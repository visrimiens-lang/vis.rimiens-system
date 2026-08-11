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
    /*
     * 元の理由（detail）も message に含める。
     *
     * 画面や操作記録に出るのは message だけなので、含めないと
     * 「データベースへの書き込みに失敗しました。」としか残らず、
     * 決められた値以外を保存しようとしたのか、繋がらなかったのか、
     * 権限の問題なのかが区別できない。
     * 実際、顧客台帳の出荷状況に「キャンセル」を入れようとして失敗した件が
     * これで分からず、原因の特定に遠回りした。
     */
    super(detail ? `${message}（${detail.slice(0, 200)}）` : message);
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

/**
 * 保存先が1回に返す行数の上限。
 *
 * Supabase の既定がこの値で、クエリに limit=2000 と書いても 1000 で切られる。
 * 「切られたこと」は応答に出ないので、多く書くほど気づけなくなる。
 */
const PAGE_SIZE = 1000;

/**
 * 条件に合う行を、上限で切られずに最後まで取る。
 *
 * 上の select は1回問い合わせて終わりなので、1000件を超えると
 * 1001件目から先が黙って消える。代理店の一覧のように
 * 「全部揃っている前提」で枠の残りを数えたり組織図を組み立てたりする用途では、
 * 消えたことに気づけないまま結果だけがずれる。
 * ここでは Range ヘッダで続きを取り、返ってきた数が1ページ未満になるまで繰り返す。
 *
 * query には order を必ず入れること。並び順が決まっていないと、
 * ページの境目で同じ行が二度出たり抜けたりする。
 *
 * @param hardLimit 念のための打ち切り（暴走時の保険）。既定10万件。
 */
export async function selectAll<T>(
  query: string,
  opts: Options & { hardLimit?: number } = {},
): Promise<T[]> {
  const hardLimit = opts.hardLimit ?? 100_000;
  const out: T[] = [];
  for (let from = 0; from < hardLimit; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const page = await request<T[]>("GET", query, undefined, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Range: `${from}-${to}`, "Range-Unit": "items" },
    });
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
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
 * `code=in.(...)` の中身を安全に組み立てる。
 *
 * 値には利用者が入れた文字がそのまま来ることがある（受注の ?ref= など）。
 * 引用符を escape しないと条件を抜け出せてしまい、
 * さらに & を符号化しないと PostgREST が「別の条件の指定」として読み、
 * 誰にいくら払うかの元になる問い合わせを外から書き換えられる。
 *
 * 使い方: `agencies?select=code&code=${inList(codes)}`
 */
export function inList(values: string[]): string {
  const body = values.map(val).join(",");
  return `in.${encodeURIComponent(`(${body})`)}`;
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
