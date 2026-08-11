import "server-only";
import { dbConfigured, select } from "./db";

/**
 * 「お知らせ」と「資料」の読み取り。保存先は Supabase。
 *
 *   - portal_notices    お知らせ
 *   - portal_documents  資料の一覧（ファイル本体は Storage の公開バケット portal-docs）
 *
 * ★ 読み取りはほかの画面と同じ経路（./db の select）を通す。
 *
 * 以前はここだけ公開鍵（SUPABASE_PUBLISHABLE_KEY）で直接読んでいた。
 * それだと動くために2つの条件が余分に要る:
 *   ・その環境変数が設定されていること
 *   ・そのテーブルに「公開鍵でも読める」RLS の許可が付いていること
 * どちらが欠けても中身が空で返り、画面には「準備中」とだけ出る。
 * 本部は「お知らせを出した」と思っているのに代理店には1件も届かず、
 * 本部の画面は正常に見えるので、電話が来るまで誰も気づけない。
 * この画面はもともとサーバー側でしか動かないので、公開鍵を使う利点は無い。
 */

/** お知らせの保存先が用意されているか。 */
export function noticesConfigured(): boolean {
  return dbConfigured();
}

/** 資料の保存先が用意されているか。 */
export function documentsConfigured(): boolean {
  return dbConfigured();
}

async function rest<T>(path: string): Promise<T> {
  // お知らせ・資料は分単位で変わるものではない。60秒使い回す。
  return (await select<unknown>(path, { revalidate: 60 })) as T;
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
  if (!dbConfigured()) return [];
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
  if (!dbConfigured()) return [];
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
