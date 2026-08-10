"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  changeOwnPassword,
  currentViewer,
  endSession,
  issueTemporaryPassword,
  login,
  startSession,
} from "@/lib/auth";

export type FormState = { error?: string; ok?: string; password?: string };

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get("loginId") ?? "");
  const password = String(formData.get("password") ?? "");

  let result;
  try {
    result = await login(id, password);
  } catch (e) {
    return {
      error:
        e instanceof Error
          ? `接続に失敗しました。${e.message}`
          : "接続に失敗しました。しばらくしてからもう一度お試しください。",
    };
  }

  // 失敗の理由は出し分けない。実在するコードかどうかを未認証の相手に教えないため。
  if (!result.ok) {
    return {
      error:
        "代理店コードまたはパスワードが違います。パスワードが分からない場合は本部にご連絡ください。",
    };
  }

  await startSession(result.viewer);
  redirect("/dashboard");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

/** 本部が代理店の初回パスワードを発行する。 */
export async function issuePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") return { error: "権限がありません。" };

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "代理店コードが指定されていません。" };

  let result;
  try {
    result = await issueTemporaryPassword(code);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "発行に失敗しました。" };
  }
  if (!result.ok) return { error: result.message };

  revalidatePath("/admin/agencies");
  return {
    ok: `${result.agencyName}（${code}）の初回パスワードを発行しました。この画面を閉じると二度と表示できません。本人にお伝えください。`,
    password: result.password,
  };
}

/** 代理店が自分のパスワードを変更する。 */
export async function changePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "agency") return { error: "権限がありません。" };

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (next !== confirm) return { error: "確認用のパスワードが一致しません。" };

  let result;
  try {
    result = await changeOwnPassword(viewer.code, current, next);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "変更に失敗しました。" };
  }
  if (!result.ok) return { error: result.message };

  return { ok: "パスワードを変更しました。" };
}
