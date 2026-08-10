"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { fileSize } from "@/lib/content";
import {
  DOCUMENT_CATEGORIES,
  MAX_UPLOAD_BYTES,
  createDocument,
  deleteDocument,
  updateDocument,
  uploadDocumentFile,
} from "@/lib/document-admin";

/** at は成功のたびに変わる。画面側がフォームを空に戻す合図に使う。 */
export type DocumentActionState = { error?: string; ok?: string; at?: number };

const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;

/**
 * 資料の登録・削除は本部だけ。
 * フォームから id を受け取るので、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer) {
    return "ログインの有効期限が切れています。もう一度ログインしてからお試しください。";
  }
  if (viewer.kind !== "hq") return "この操作は本部のアカウントからのみ行えます。";
  return null;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** 数字だけの id か確かめる。画面の値をそのまま保管先の絞り込みに使わない。 */
function readId(formData: FormData): string | null {
  const id = text(formData, "id");
  return /^\d+$/.test(id) ? id : null;
}

function toCategory(raw: string): string {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(raw) ? raw : "その他";
}

function failed(prefix: string, e: unknown): DocumentActionState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいてもう一度お試しください。`,
  };
}

/** 拡張子を取ったファイル名。資料名が未入力のときの控えに使う。 */
function nameFromFile(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? "").trim();
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).slice(0, NAME_MAX);
}

/** 資料を1件追加する。ファイルを保管先に上げてから、一覧に載せる。 */
export async function createDocumentAction(
  _prev: DocumentActionState,
  formData: FormData,
): Promise<DocumentActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const entry = formData.get("file");
  if (!(entry instanceof File) || entry.size === 0 || !entry.name) {
    return { error: "配布するファイルを選んでください。" };
  }
  if (entry.size > MAX_UPLOAD_BYTES) {
    return {
      error:
        `ファイルが大きすぎます（${fileSize(entry.size)}）。1ファイル 10MB までです。` +
        "画像を小さくするか、ファイルを分けてからお試しください。",
    };
  }

  const name = (text(formData, "name") || nameFromFile(entry.name)).slice(0, NAME_MAX);
  if (!name) {
    return { error: "資料名を入力してください。代理店の画面にはこの名前で表示されます。" };
  }
  const description = text(formData, "description").slice(0, DESCRIPTION_MAX);
  const category = toCategory(text(formData, "category"));

  try {
    const uploaded = await uploadDocumentFile(entry);
    await createDocument({ name, category, description, file: uploaded });
  } catch (e) {
    return failed("資料を追加できませんでした。", e);
  }

  revalidatePath("/admin/documents");
  revalidatePath("/documents");
  return {
    ok: `「${name}」を追加しました。代理店の資料ページからダウンロードできます。`,
    at: Date.now(),
  };
}

/** 公開・非公開を切り替える。非公開にすると代理店の資料ページから消える。 */
export async function togglePublishAction(
  _prev: DocumentActionState,
  formData: FormData,
): Promise<DocumentActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return { error: "対象の資料を特定できませんでした。画面を読み込み直してからお試しください。" };
  }
  const publish = text(formData, "publish") === "true";

  let label = "";
  try {
    const updated = await updateDocument(id, { published: publish });
    label = updated.name || "この資料";
  } catch (e) {
    return failed("公開状態を変更できませんでした。", e);
  }

  revalidatePath("/admin/documents");
  revalidatePath("/documents");
  return {
    ok: publish
      ? `「${label}」を公開しました。代理店の資料ページに表示されます。`
      : `「${label}」を非公開にしました。代理店の資料ページには表示されません。` +
        `ただし、すでにお渡ししたダウンロードURLを知っている方は引き続き開けます。` +
        `完全に見せたくない場合は削除してください。`,
    at: Date.now(),
  };
}

/** 資料を1件削除する。ファイル本体も保管先から消える。 */
export async function deleteDocumentAction(
  _prev: DocumentActionState,
  formData: FormData,
): Promise<DocumentActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return { error: "対象の資料を特定できませんでした。画面を読み込み直してからお試しください。" };
  }

  let label = "";
  try {
    const removed = await deleteDocument(id);
    label = removed.name || "この資料";
  } catch (e) {
    return failed("資料を削除できませんでした。", e);
  }

  revalidatePath("/admin/documents");
  revalidatePath("/documents");
  return { ok: `「${label}」を削除しました。`, at: Date.now() };
}
