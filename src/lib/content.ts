import "server-only";

/**
 * 「お知らせ」と「資料」の読み取り。保存先は Supabase。
 *
 * 受注・代理店・報酬は kintone が唯一の正（Make がそこへ書くため、複製すると
 * 必ず食い違う）。Supabase に置くのは kintone に存在しないポータル専用データだけ:
 *   - portal_notices    お知らせ
 *   - portal_documents  資料の一覧（ファイル本体は Storage の公開バケット portal-docs）
 *
 * 書き込みは本部が Supabase ダッシュボード（テーブルエディター／Storage）で行う。
 * ポータルは読み取り専用なので、RLS（公開行のみ SELECT 可）＋公開可能キーで足りる。
 * 秘密鍵（sb_secret_...）はこのアプリのどこにも置かない。
 *
 * SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY が未設定でも壊れない。
 * その場合は空配列を返し、画面側で「準備中」と案内する。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

function configured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/** お知らせの保存先が用意されているか。 */
export function noticesConfigured(): boolean {
  return configured();
}

/** 資料の保存先が用意されているか。 */
export function documentsConfigured(): boolean {
  return configured();
}

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    // お知らせ・資料は分単位で変わるものではない。60秒キャッシュする。
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `お知らせ・資料の保存先に接続できませんでした (HTTP ${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/* ---------- お知らせ ---------- */

export type Notice = {
  id: string;
  title: string;
  body: string;
  /** "YYYY-MM-DD"。未入力なら空文字。 */
  publishedAt: string;
  important: boolean;
};

type NoticeRow = {
  id: string | number;
  title: string | null;
  body: string | null;
  published_on: string | null;
  important: boolean | null;
};

/** お知らせを取得する。重要なものが先、そのあと公開日の新しい順。 */
export async function listNotices(): Promise<Notice[]> {
  if (!configured()) return [];
  const rows = await rest<NoticeRow[]>(
    "portal_notices?select=id,title,body,published_on,important" +
      "&published=eq.true&order=important.desc,published_on.desc,id.desc&limit=100",
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title ?? "",
    body: r.body ?? "",
    publishedAt: r.published_on ?? "",
    important: Boolean(r.important),
  }));
}

/* ---------- 資料 ---------- */

export type DocumentFile = {
  name: string;
  /** バイト数。不明なら 0。 */
  size: number;
  /** Storage の公開URL。ここからそのままダウンロードできる。 */
  url: string;
};

export type DocumentItem = {
  id: string;
  name: string;
  category: string;
  description: string;
  /** "YYYY-MM-DD"。未入力なら空文字。 */
  updatedAt: string;
  files: DocumentFile[];
};

/** カテゴリが未入力の資料をまとめる見出し。 */
export const UNCATEGORIZED = "その他";

type DocumentRow = {
  id: string | number;
  name: string | null;
  category: string | null;
  description: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  updated_on: string | null;
};

/** 資料を取得する。カテゴリ順 → 更新日の新しい順。 */
export async function listDocuments(): Promise<DocumentItem[]> {
  if (!configured()) return [];
  const rows = await rest<DocumentRow[]>(
    "portal_documents?select=id,name,category,description,file_url,file_name,file_size,updated_on" +
      "&published=eq.true&order=updated_on.desc,id.desc&limit=300",
  );
  return rows.map((r) => {
    const size = Number(r.file_size);
    return {
      id: String(r.id),
      name: r.name ?? "",
      category: r.category || UNCATEGORIZED,
      description: r.description ?? "",
      updatedAt: r.updated_on ?? "",
      files: r.file_url
        ? [
            {
              name: r.file_name || r.name || "ファイル",
              size: Number.isFinite(size) ? size : 0,
              url: r.file_url,
            },
          ]
        : [],
    };
  });
}

export type DocumentGroup = { category: string; items: DocumentItem[] };

/** 資料をカテゴリごとにまとめる。「その他」は最後に置く。 */
export function groupDocuments(items: DocumentItem[]): DocumentGroup[] {
  const map = new Map<string, DocumentItem[]>();
  for (const d of items) {
    const list = map.get(d.category) ?? [];
    list.push(d);
    map.set(d.category, list);
  }
  return [...map.entries()]
    .map(([category, list]) => ({ category, items: list }))
    .sort((a, b) => {
      if (a.category === UNCATEGORIZED) return 1;
      if (b.category === UNCATEGORIZED) return -1;
      return a.category.localeCompare(b.category, "ja");
    });
}

/* ---------- 表示用の小さな整形 ---------- */

/** "2026-08-07" → "2026年8月7日"。未入力なら "—"。 */
export function jpFullDate(v: string | null | undefined): string {
  if (!v) return "—";
  const parts = v.slice(0, 10).split("-");
  if (parts.length !== 3) return v;
  return `${Number(parts[0])}年${Number(parts[1])}月${Number(parts[2])}日`;
}

/** バイト数を読みやすい単位にする。 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`;
}
