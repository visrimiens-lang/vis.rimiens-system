"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import {
  createResetRequest,
  listPendingResets,
  resolveReset,
  type ListResult,
  type ResolvedStatus,
} from "@/lib/reset";

export type ResetFormState = { error?: string; ok?: string };

/** 送信できた／できなかったに関わらず、代理店に返す文面は必ずこれ1種類にする。 */
const RECEIVED =
  "再発行のお申し込みを受け付けました。本部が内容を確認のうえ、ご入力いただいた連絡先へパスワードをお伝えします。";

const CONTACT_HQ =
  "うまくいかない場合は、お手数ですが本部までお電話でご連絡ください。";

/* ---------- 代理店が申し込む（ログイン不要） ---------- */

/**
 * パスワード再発行を申し込む。
 *
 * 入力された代理店コードが実在するかどうかは、成功・失敗どちらの文面にも出さない。
 * ログイン前の誰でも触れる画面なので、ここで出し分けると
 * 「どのコードが生きているか」を総当たりで調べられる窓口になってしまう。
 */
export async function requestPasswordResetAction(
  _prev: ResetFormState,
  formData: FormData,
): Promise<ResetFormState> {
  const code = String(formData.get("code") ?? "");
  const contact = String(formData.get("contact") ?? "");
  const note = String(formData.get("note") ?? "");

  let result;
  try {
    result = await createResetRequest(code, contact, note);
  } catch {
    return {
      error: `申請を送信できませんでした。時間をおいてもう一度お試しください。${CONTACT_HQ}`,
    };
  }

  if (!result.ok) return { error: result.message };
  return { ok: RECEIVED };
}

/* ---------- 本部が確認する ---------- */

/** 未対応の申請を取り出す。本部以外には何も返さない。 */
export async function loadResetRequestsAction(): Promise<ListResult> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { ok: false, message: "この一覧を表示する権限がありません。" };
  }

  try {
    return await listPendingResets();
  } catch (e) {
    return {
      ok: false,
      message: `パスワード再発行の申請を読み込めませんでした。${
        e instanceof Error ? e.message : "時間をおいて開き直してください。"
      }`,
    };
  }
}

/**
 * 申請を処理済みにする。
 * 申請の id はフォームから届くため、本部かどうかの判定はここが唯一の砦になる。
 */
export async function resolveResetAction(
  _prev: ResetFormState,
  formData: FormData,
): Promise<ResetFormState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") return { error: "権限がありません。" };

  const id = String(formData.get("id") ?? "").trim();
  const raw = String(formData.get("status") ?? "");
  const status: ResolvedStatus | null =
    raw === "done" ? "done" : raw === "rejected" ? "rejected" : null;

  if (!id || !status) {
    return {
      error: "対象の申請を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  let result;
  try {
    result = await resolveReset(id, status);
  } catch (e) {
    return {
      error: `申請の状態を保存できませんでした。${
        e instanceof Error ? e.message : "時間をおいてもう一度お試しください。"
      }`,
    };
  }
  if (!result.ok) return { error: result.message };

  revalidatePath("/admin/agencies");
  return {
    ok:
      status === "done"
        ? "対応済みにしました。"
        : "この申請を取り下げました。パスワードは発行されていません。",
  };
}
