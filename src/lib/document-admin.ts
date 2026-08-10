import "server-only";
import { randomBytes } from "node:crypto";

/**
 * 「資料」の登録・削除（本部だけが使う書き込み側）。
 *
 * 読み取りは src/lib/content.ts が公開可能キーで行う。こちらは書き込みなので
 * 秘密鍵（SUPABASE_SECRET_KEY）を使う。**このファイルを client component から
 * import しないこと。** "server-only" を付けてあるので、うっかり import すると
 * ビルドが止まる。
 *
 *   - ファイル本体 … Storage の公開バケット portal-docs
 *   - 一覧の行     … テーブル portal_documents
 *
 * SUPABASE_URL / SUPABASE_SECRET_KEY が未設定でも import 時に落ちないようにし、
 * 実際に使おうとしたときだけ日本語で理由を投げる（画面は「準備中」を出せる）。
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

/** ファイル本体を置く公開バケット。 */
const BUCKET = "portal-docs";

/** 1ファイルあたりの上限。保管先のバケット側も同じ 10MB で設定してある。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 資料のカテゴリ。代理店側の資料ページでこの見出しごとにまとまる。 */
export const DOCUMENT_CATEGORIES = [
  "販促物",
  "操作マニュアル",
  "契約関連",
  "研修資料",
  "その他",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** 保管先の設定が入っているか。未設定なら画面側で「準備中」を案内する。 */
export function documentAdminConfigured(): boolean {
  return Boolean(SUPABASE_URL && SECRET_KEY);
}

function ensureConfigured(): void {
  if (!documentAdminConfigured()) {
    throw new Error(
      "資料の保管先が設定されていません。サーバーの設定（保管先のURLと書き込み用キー）をご確認ください。",
    );
  }
}

function authHeaders(): Record<string, string> {
  // Supabase は apikey と Authorization の両方を見る。片方だけだと 401 になる。
  return { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const detail = body ? `: ${body.slice(0, 160)}` : "";
  return new Error(`${what}（エラー ${res.status}）${detail}`);
}

/* ---------- 日付とファイル名 ---------- */

/** 日本時間の「今」を、日付（YYYY-MM-DD）と連番用の文字列で返す。 */
function tokyoNow(): { date: string; stamp: string } {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  const [date, time] = formatted.split(" ");
  return { date, stamp: `${date.replace(/-/g, "")}-${time.replace(/:/g, "")}` };
}

/**
 * 置いてよいファイルの種類。
 *
 * バケットは公開設定なので、HTML や SVG を許すと Supabase のドメイン上で
 * スクリプトが動く（そのドメインの利用者を狙える）。ブラウザが自分で言ってきた
 * 種類は信用せず、拡張子から引いた値だけを使う。
 */
const ALLOWED_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
};

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_TYPES);

/**
 * 保管先に置くときのファイル名を作る。
 *
 * 日本語のファイル名をそのまま使うと、ダウンロードURLが機種によって文字化けしたり
 * リンクが切れたりする。英数字とハイフンだけに直し、頭に日時と乱数を付けて
 * 別の資料を上書きしないようにする。元の名前は file_name に保存して画面に出す。
 */
function storageObjectName(originalName: string): string {
  const base = (originalName.split(/[\\/]/).pop() ?? "").trim();
  const dot = base.lastIndexOf(".");
  const rawExt = dot > 0 ? base.slice(dot + 1) : "";
  const ext = /^[A-Za-z0-9]{1,8}$/.test(rawExt) ? `.${rawExt.toLowerCase()}` : "";
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const stem =
    rawStem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "file";
  const { stamp } = tokyoNow();
  const noise = randomBytes(12).toString("hex");
  return `${stamp}-${noise}-${stem}${ext}`;
}

/** 公開URLから、保管先でのファイル名を取り出す。取れなければ null。 */
function objectNameFromUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const name = url.slice(at + marker.length).split("?")[0];
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/* ---------- ファイルのアップロード ---------- */

export type UploadedFile = {
  /** ダウンロード用の公開URL */
  url: string;
  /** 画面に出す名前（アップロード時の元のファイル名） */
  name: string;
  /** バイト数 */
  size: number;
};

/**
 * ファイル本体を公開バケットにアップロードして、公開URLを返す。
 *
 * 公開バケットなので、URLを知っていれば誰でもダウンロードできる。
 * 契約書のひな形など「代理店には配るが検索には出したくない」ものを想定し、
 * ファイル名に乱数を混ぜて URL を推測できないようにしている。
 */
export async function uploadDocumentFile(file: File): Promise<UploadedFile> {
  ensureConfigured();
  if (file.size <= 0) {
    throw new Error("ファイルの中身が空でした。別のファイルを選んでお試しください。");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("ファイルが大きすぎます。1ファイル 10MB までにしてください。");
  }

  const dot = (file.name ?? "").lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  const contentType = ALLOWED_TYPES[ext];
  if (!contentType) {
    throw new Error(
      `この形式のファイルは登録できません（${ext || "拡張子なし"}）。` +
        `PDF・画像・Word・Excel・PowerPoint・ZIP・動画(mp4) がお使いいただけます。`,
    );
  }

  const objectName = storageObjectName(file.name);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectName}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      // ブラウザ申告の file.type は使わない。拡張子から引いた値だけを送る。
      "content-type": contentType,
      "x-upsert": "true",
    },
    body: file,
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res, "ファイルを保管先に保存できませんでした");

  return {
    url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectName}`,
    name: file.name || objectName,
    size: file.size,
  };
}

/** 保管先からファイル本体を消す。消せなくても致命的ではないので投げない。 */
async function removeStorageObject(url: string): Promise<void> {
  const objectName = objectNameFromUrl(url);
  if (!objectName) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectName}`, {
      method: "DELETE",
      headers: authHeaders(),
      cache: "no-store",
    });
  } catch {
    // 一覧からは消えているので、本体が残っても運用は止まらない。
  }
}

/* ---------- 一覧の行 ---------- */

export type AdminDocument = {
  id: string;
  name: string;
  category: string;
  description: string;
  /** "YYYY-MM-DD"。未入力なら空文字。 */
  updatedAt: string;
  /** false のあいだは代理店の資料ページに出ない。 */
  published: boolean;
  fileName: string;
  fileUrl: string;
  /** バイト数。不明なら 0。 */
  fileSize: number;
};

type Row = {
  id: string | number;
  name: string | null;
  category: string | null;
  description: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  updated_on: string | null;
  published: boolean | null;
};

const SELECT =
  "id,name,category,description,file_url,file_name,file_size,updated_on,published";

function toDocument(r: Row): AdminDocument {
  const size = Number(r.file_size);
  return {
    id: String(r.id),
    name: r.name ?? "",
    category: r.category || "その他",
    description: r.description ?? "",
    updatedAt: r.updated_on ?? "",
    published: r.published !== false,
    fileName: r.file_name || "",
    fileUrl: r.file_url || "",
    fileSize: Number.isFinite(size) ? size : 0,
  };
}

/**
 * 本部向けの一覧。代理店側と違い、非公開のものも含めて全部返す。
 * アップロード直後に必ず反映させたいのでキャッシュしない。
 */
export async function listAllDocuments(): Promise<AdminDocument[]> {
  ensureConfigured();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/portal_documents?select=${SELECT}` +
      "&order=updated_on.desc,id.desc&limit=300",
    { headers: authHeaders(), cache: "no-store" },
  );
  if (!res.ok) throw await failure(res, "資料の一覧を読み込めませんでした");
  const rows = (await res.json()) as Row[];
  return rows.map(toDocument);
}

export type NewDocument = {
  name: string;
  category: string;
  description: string;
  file: UploadedFile;
};

/** 資料を1件追加する。追加した時点で公開（代理店から見える状態）にする。 */
export async function createDocument(input: NewDocument): Promise<AdminDocument> {
  ensureConfigured();
  const { date } = tokyoNow();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/portal_documents`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      name: input.name,
      category: input.category,
      description: input.description || null,
      file_url: input.file.url,
      file_name: input.file.name,
      file_size: input.file.size,
      updated_on: date,
      published: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res, "資料を登録できませんでした");
  const rows = (await res.json()) as Row[];
  if (!rows[0]) throw new Error("資料を登録できませんでした。もう一度お試しください。");
  return toDocument(rows[0]);
}

export type DocumentPatch = {
  name?: string;
  category?: string;
  description?: string;
  published?: boolean;
};

/** 資料の内容や公開状態を書き換える。更新日も今日に直す。 */
export async function updateDocument(
  id: string,
  patch: DocumentPatch,
): Promise<AdminDocument> {
  ensureConfigured();
  const { date } = tokyoNow();
  const body: Record<string, unknown> = { updated_on: date };
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.category !== undefined) body.category = patch.category;
  if (patch.description !== undefined) body.description = patch.description || null;
  if (patch.published !== undefined) body.published = patch.published;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/portal_documents?id=eq.${encodeURIComponent(id)}&select=${SELECT}`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );
  if (!res.ok) throw await failure(res, "資料を更新できませんでした");
  const rows = (await res.json()) as Row[];
  if (!rows[0]) {
    throw new Error(
      "対象の資料が見つかりませんでした。画面を読み込み直してからお試しください。",
    );
  }
  return toDocument(rows[0]);
}

/**
 * 資料を1件消す。一覧の行を消してから、ファイル本体も消す。
 * 本体の削除に失敗しても、代理店からは見えなくなっているのでエラーにはしない。
 */
export async function deleteDocument(id: string): Promise<AdminDocument> {
  ensureConfigured();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/portal_documents?id=eq.${encodeURIComponent(id)}&select=${SELECT}`,
    {
      method: "DELETE",
      headers: { ...authHeaders(), Prefer: "return=representation" },
      cache: "no-store",
    },
  );
  if (!res.ok) throw await failure(res, "資料を削除できませんでした");
  const rows = (await res.json()) as Row[];
  if (!rows[0]) {
    throw new Error(
      "対象の資料が見つかりませんでした。すでに削除されている可能性があります。",
    );
  }
  const removed = toDocument(rows[0]);
  if (removed.fileUrl) await removeStorageObject(removed.fileUrl);
  return removed;
}
