import "server-only";

/**
 * パスワード再発行の「申請」を受け付けて溜めておく。
 *
 * ポータルのパスワードは本部が発行する方式（src/lib/auth.ts）。代理店が自分で
 * 再設定できる仕組みにはしない。代理店コードもメールアドレスも、QR の URL や
 * 承認メールに載る準公開情報で、本人確認の材料にならないため。
 * よってここが担当するのは受付箱だけ。
 *   本人が再発行を申し込む → 本部が連絡先に折り返して本人を確認する
 *   → 本部がパスワードを発行して口頭等で伝える
 *
 * 保存先は Supabase。kintone の代理店マスタには書かない（申請は業務データでは
 * なく、本部が処理したら役目が終わる事務連絡のため）。
 * 申請には連絡先が入るので、公開可能キーでは読めないようにし、
 * 読み書きとも秘密鍵（サーバー側のみ）で行う。
 *
 * 必要なテーブル:
 *   create table portal_password_requests (
 *     id          uuid primary key default gen_random_uuid(),
 *     agency_code text not null,
 *     contact     text not null,
 *     note        text default '',
 *     status      text not null default 'pending',
 *     created_at  timestamptz not null default now()
 *   );
 *   alter table portal_password_requests enable row level security;
 *   -- ポリシーは作らない。公開可能キーからは1行も見えず、秘密鍵だけが読み書きできる。
 *
 * テーブルがまだ無い環境でも例外で落とさない。握りつぶしもしない。
 * 「本部にお電話でご連絡ください」と案内する日本語メッセージを返し、
 * 電話という確実な経路に逃がす。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
const TABLE = "portal_password_requests";

/* ---------- 型 ---------- */

export type ResetStatus = "pending" | "done" | "rejected";

/** 処理済みにするときに指定できるステータス。 */
export type ResolvedStatus = Exclude<ResetStatus, "pending">;

export type ResetRequest = {
  id: string;
  agencyCode: string;
  /** 電話番号またはメールアドレス。本部はここへ折り返す。 */
  contact: string;
  note: string;
  status: ResetStatus;
  /** ISO 文字列。未取得なら空文字。 */
  createdAt: string;
};

export type SubmitResult = { ok: true } | { ok: false; message: string };

export type ListResult =
  | { ok: true; items: ResetRequest[] }
  | { ok: false; message: string };

export type ResolveResult = { ok: true } | { ok: false; message: string };

/* ---------- Supabase への問い合わせ ---------- */

type FailureKind = "unconfigured" | "missing-table" | "network" | "http" | "broken";

type Failure = { kind: FailureKind; detail: string };

type CallResult = { ok: true; text: string } | { ok: false; fail: Failure };

type CallInit = {
  method: "GET" | "POST" | "PATCH";
  /** PostgREST の Prefer ヘッダー。 */
  prefer?: string;
  body?: string;
};

/** 表そのもの、または想定した列が無いときの応答かどうか。 */
function looksLikeSchemaGap(status: number, body: string): boolean {
  if (status === 404) return true;
  return (
    body.includes("PGRST205") ||
    body.includes("PGRST204") ||
    body.includes("42P01") ||
    body.includes("does not exist")
  );
}

async function call(path: string, init: CallInit): Promise<CallResult> {
  if (!SUPABASE_URL || !SECRET_KEY) {
    return {
      ok: false,
      fail: {
        kind: "unconfigured",
        detail: "申請の保存先（SUPABASE_URL / SUPABASE_SECRET_KEY）が設定されていません。",
      },
    };
  }

  const headers: Record<string, string> = {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
  };
  if (init.prefer) headers.Prefer = init.prefer;
  if (init.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: init.method,
      headers,
      body: init.body,
      // 申請は届いた瞬間に見えないと意味がない。キャッシュしない。
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      fail: {
        kind: "network",
        detail: `申請の保存先に接続できませんでした（${
          e instanceof Error ? e.message : "原因不明"
        }）。`,
      },
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (looksLikeSchemaGap(res.status, text)) {
      return {
        ok: false,
        fail: {
          kind: "missing-table",
          detail: `申請を保存する表（${TABLE}）が用意されていないか、列の構成が想定と違います。`,
        },
      };
    }
    return {
      ok: false,
      fail: {
        kind: "http",
        detail: `申請の保存先が応答しませんでした（HTTP ${res.status}）。`,
      },
    };
  }

  return { ok: true, text };
}

function parseRows(text: string): Row[] | null {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Row[]) : null;
  } catch {
    return null;
  }
}

type Row = {
  id: string | number | null;
  agency_code: string | null;
  contact: string | null;
  note: string | null;
  status: string | null;
  created_at: string | null;
};

function toRequest(row: Row): ResetRequest {
  const status = row.status;
  return {
    id: row.id === null || row.id === undefined ? "" : String(row.id),
    agencyCode: row.agency_code ?? "",
    contact: row.contact ?? "",
    note: row.note ?? "",
    status:
      status === "done" || status === "rejected" || status === "pending"
        ? status
        : "pending",
    createdAt: row.created_at ?? "",
  };
}

/** 設定・テーブルがまだ整っていないことが原因の失敗か。 */
function isSetupGap(kind: FailureKind): boolean {
  return kind === "unconfigured" || kind === "missing-table";
}

/* ---------- 申請する（代理店・ログイン不要） ---------- */

const MAX_CODE = 32;
const MAX_CONTACT = 200;
const MAX_NOTE = 1000;

/**
 * 再発行の申請を1件積む。
 *
 * ここでは代理店コードが実在するかを確かめない。確かめて結果を返してしまうと、
 * ログイン前の画面が「このコードは実在する」の判定機になってしまうため。
 * 実在確認は本部が申請一覧を見るときに行う。
 */
export async function createResetRequest(
  code: string,
  contact: string,
  note: string,
): Promise<SubmitResult> {
  const agencyCode = code.trim();
  const to = contact.trim();
  const memo = note.trim();

  if (!agencyCode || !to) {
    return { ok: false, message: "代理店コードとご連絡先の両方をご入力ください。" };
  }
  if (agencyCode.length > MAX_CODE) {
    return { ok: false, message: "代理店コードが長すぎます。ご確認のうえ入力し直してください。" };
  }
  if (to.length > MAX_CONTACT) {
    return { ok: false, message: "ご連絡先が長すぎます。電話番号かメールアドレスをひとつだけご入力ください。" };
  }
  if (memo.length > MAX_NOTE) {
    return { ok: false, message: "ご連絡事項が長すぎます。1000文字以内におまとめください。" };
  }

  const result = await call(TABLE, {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify([
      {
        agency_code: agencyCode,
        contact: to,
        note: memo,
        status: "pending",
        created_at: new Date().toISOString(),
      },
    ]),
  });

  if (result.ok) return { ok: true };

  // 申請する人にシステムの内側は見せない。確実に届く代替手段（電話）だけ案内する。
  return {
    ok: false,
    message: isSetupGap(result.fail.kind)
      ? "ただいまこの画面からの再発行のお申し込みを受け付けられません。お手数ですが、本部までお電話でご連絡ください。"
      : "申請を送信できませんでした。時間をおいてもう一度お試しいただくか、本部までお電話でご連絡ください。",
  };
}

/* ---------- 本部が見る・処理する ---------- */

/** 未対応の申請を、古いものから順に返す。 */
export async function listPendingResets(): Promise<ListResult> {
  const result = await call(
    `${TABLE}?select=id,agency_code,contact,note,status,created_at` +
      "&status=eq.pending&order=created_at.asc&limit=200",
    { method: "GET" },
  );

  if (!result.ok) {
    const guide = isSetupGap(result.fail.kind)
      ? "この画面で受け取れるようになるまで、ログイン画面では本部へお電話いただくようご案内しています。"
      : "時間をおいて開き直してください。";
    return {
      ok: false,
      message: `パスワード再発行の申請を読み込めませんでした。${result.fail.detail}${guide}`,
    };
  }

  const rows = parseRows(result.text);
  if (!rows) {
    return {
      ok: false,
      message:
        "パスワード再発行の申請を読み込めませんでした。保存先からの応答を解釈できません。時間をおいて開き直してください。",
    };
  }
  return { ok: true, items: rows.map(toRequest) };
}

/**
 * 申請を処理済みにする。
 * 未対応のものだけを対象にするので、2人の担当者が同時に押しても二重処理にならない。
 */
export async function resolveReset(
  id: string,
  status: ResolvedStatus,
): Promise<ResolveResult> {
  const key = id.trim();
  if (!key) {
    return {
      ok: false,
      message: "対象の申請を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const result = await call(
    `${TABLE}?id=eq.${encodeURIComponent(key)}&status=eq.pending&select=id`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify({ status }),
    },
  );

  if (!result.ok) {
    return { ok: false, message: `申請の状態を保存できませんでした。${result.fail.detail}` };
  }

  const rows = parseRows(result.text);
  if (rows && rows.length === 0) {
    return {
      ok: false,
      message:
        "この申請は見つかりませんでした。ほかの担当者がすでに処理した可能性があります。画面を読み込み直してご確認ください。",
    };
  }
  return { ok: true };
}
