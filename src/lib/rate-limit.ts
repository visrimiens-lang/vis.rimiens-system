import "server-only";

/**
 * ログインとパスワード再発行申請の試行回数を数える。
 *
 * 代理店コードは QR の URL や承認メールに載る準公開情報なので、
 * ID が既知の状態でパスワードだけを総当たりされうる。
 * 保存先は Supabase の portal_login_attempts。
 *
 * ★ 数えられない状況（テーブル未作成・Supabase 不通）でもログインは止めない。
 *   認証そのものを巻き添えで落とすほうが被害が大きいため、
 *   数えられなかったときは「制限なし」として通す。
 */

const URL_BASE = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";

/** 同じキーで何回失敗したらロックするか。 */
const MAX_FAILURES = 5;
/** ロックする時間（分）。 */
const LOCK_MINUTES = 15;
/** 失敗回数を数える対象の時間窓（分）。 */
const WINDOW_MINUTES = 15;

function configured(): boolean {
  return Boolean(URL_BASE && SECRET);
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  if (!configured()) return null;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SECRET,
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ([] as unknown as T);
  } catch {
    return null;
  }
}

type AttemptRow = { id: number; failures: number; locked_until: string | null };

/**
 * ロック中かどうか。
 * 呼び出し側は、ロック中でも成功時と同じ文面・同じ所要時間で返すこと
 * （ロックされていること自体を相手に教えないため）。
 */
export async function isLocked(key: string): Promise<boolean> {
  const rows = await rest<AttemptRow[]>(
    `portal_login_attempts?select=id,failures,locked_until&key=eq.${encodeURIComponent(key)}&limit=1`,
  );
  if (!rows || rows.length === 0) return false;
  const until = rows[0].locked_until;
  return Boolean(until && new Date(until).getTime() > Date.now());
}

/** 失敗を1回数える。上限に達したらロックする。 */
export async function recordFailure(key: string): Promise<void> {
  const rows = await rest<AttemptRow[]>(
    `portal_login_attempts?select=id,failures,locked_until&key=eq.${encodeURIComponent(key)}&limit=1`,
  );
  const now = Date.now();

  if (!rows || rows.length === 0) {
    await rest("portal_login_attempts", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([
        { key, failures: 1, last_failed_at: new Date(now).toISOString() },
      ]),
    });
    return;
  }

  const failures = (rows[0].failures ?? 0) + 1;
  const patch: Record<string, unknown> = {
    failures,
    last_failed_at: new Date(now).toISOString(),
  };
  if (failures >= MAX_FAILURES) {
    patch.locked_until = new Date(now + LOCK_MINUTES * 60_000).toISOString();
    patch.failures = 0; // ロック後は数え直す
  }
  await rest(`portal_login_attempts?id=eq.${rows[0].id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** 成功したので記録を消す。 */
export async function clearFailures(key: string): Promise<void> {
  await rest(`portal_login_attempts?key=eq.${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

/**
 * 一定時間内の件数上限。パスワード再発行の申請を積みすぎないために使う。
 * 数えられないときは true（許可）を返す。
 */
export async function withinQuota(key: string, limit: number): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const rows = await rest<{ id: number }[]>(
    `portal_login_attempts?select=id&key=eq.${encodeURIComponent(key)}&last_failed_at=gte.${since}`,
  );
  if (!rows) return true;
  return rows.length < limit;
}
