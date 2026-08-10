"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentViewer } from "@/lib/auth";
import {
  createNotice,
  deleteNotice,
  todayInJapan,
  updateNotice,
  type NoticeInput,
} from "@/lib/content-admin";

export type NoticeFormState = {
  error?: string;
  ok?: string;
  /** 登録が成功したときだけ変わる。画面側はこれを合図に入力欄を空に戻す。 */
  savedAt?: number;
};

/**
 * 本部以外は一切書き換えできない。
 * フォームから id を受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return "この操作は本部のアカウントでのみ行えます。ログインし直してからお試しください。";
  }
  return null;
}

const schema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "タイトルを入力してください。")
    .max(120, "タイトルは120文字以内で入力してください。"),
  body: z.string().trim().max(4000, "本文は4000文字以内で入力してください。"),
  publishedAt: z
    .string()
    .trim()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, "公開日は「2026-08-10」のような形式で入力してください。"),
  important: z.boolean(),
  published: z.boolean(),
});

type Parsed = { ok: true; value: NoticeInput } | { ok: false; error: string };

function parse(formData: FormData): Parsed {
  const result = schema.safeParse({
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    publishedAt: String(formData.get("publishedAt") ?? ""),
    important: formData.get("important") === "on",
    published: formData.get("published") === "on",
  });

  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: first?.message ?? "入力内容をご確認ください。" };
  }

  const value = result.data;
  // 公開日が空のままだと一覧の並び順が定まらないため、今日の日付を入れておく。
  const publishedAt = value.publishedAt || todayInJapan();

  return {
    ok: true,
    value: {
      title: value.title,
      body: value.body,
      publishedAt,
      important: value.important,
      published: value.published,
    },
  };
}

function readId(formData: FormData): string {
  return String(formData.get("id") ?? "").trim();
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** 保存後に、本部の一覧と代理店の「お知らせ」の両方を出し直す。 */
function refresh() {
  revalidatePath("/admin/notices");
  revalidatePath("/announcements");
}

/* ---------- 新規登録 ---------- */

export async function createNoticeAction(
  _prev: NoticeFormState,
  formData: FormData,
): Promise<NoticeFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const parsed = parse(formData);
  if (!parsed.ok) return { error: parsed.error };

  let saved;
  try {
    saved = await createNotice(parsed.value);
  } catch (e) {
    return {
      error: message(e, "お知らせを登録できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  refresh();
  return {
    ok: saved.published
      ? `「${saved.title}」を公開しました。代理店の画面にすぐ表示されます。`
      : `「${saved.title}」を下書きとして保存しました。代理店にはまだ表示されていません。`,
    savedAt: Date.now(),
  };
}

/* ---------- 修正 ---------- */

export async function updateNoticeAction(
  _prev: NoticeFormState,
  formData: FormData,
): Promise<NoticeFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象のお知らせを特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const parsed = parse(formData);
  if (!parsed.ok) return { error: parsed.error };

  let saved;
  try {
    saved = await updateNotice(id, parsed.value);
  } catch (e) {
    return {
      error: message(e, "変更を保存できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  refresh();
  return {
    ok: saved.published
      ? `「${saved.title}」の変更を保存しました。代理店の画面にも反映されています。`
      : `「${saved.title}」の変更を保存しました。下書きのため、代理店にはまだ表示されていません。`,
  };
}

/* ---------- 削除 ---------- */

export async function deleteNoticeAction(
  _prev: NoticeFormState,
  formData: FormData,
): Promise<NoticeFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象のお知らせを特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  let title = "";
  try {
    title = await deleteNotice(id);
  } catch (e) {
    return {
      error: message(e, "削除できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  refresh();
  return { ok: `「${title || "タイトル未設定のお知らせ"}」を削除しました。` };
}
