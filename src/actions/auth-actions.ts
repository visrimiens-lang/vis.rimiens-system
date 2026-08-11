"use server";

import { headers } from "next/headers";
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

  /*
   * 接続元のIPアドレス。Vercel が付ける x-forwarded-for の先頭が実際の接続元。
   * 途中の中継が増えるとカンマ区切りで並ぶので、最初のものだけを見る。
   * 取れなくても、ログインIDごとの回数制限は変わらず効く。
   */
  const head = await headers();
  const clientIp = (head.get("x-forwarded-for") ?? "").split(",")[0].trim();

  let result;
  try {
    result = await login(id, password, clientIp);
  } catch (e) {
    // 例外の中身には kintone の応答や環境変数名が入りうる。未認証の相手には出さない。
    console.error("[login]", e);
    return { error: "接続に失敗しました。しばらくしてからもう一度お試しください。" };
  }

  // 失敗の理由は出し分けない。実在するコードかどうかを未認証の相手に教えないため。
  if (!result.ok) {
    return {
      error:
        "代理店コードまたはパスワードが違います。パスワードが分からない場合は本部にご連絡ください。",
    };
  }

  await startSession(result.viewer, result.fp);
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

  // 指紋が変わるので、いまのセッションを張り直しておく。
  // 他の端末に残っている古いセッションはこの時点で使えなくなる。
  const again = await login(viewer.code, next);
  if (again.ok) await startSession(again.viewer, again.fp);

  return { ok: "パスワードを変更しました。他の端末でログイン中の場合は、そちらはログアウトされます。" };
}
