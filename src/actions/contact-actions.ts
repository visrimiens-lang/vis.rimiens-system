"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";

/**
 * 代理店が、自分の連絡先（郵便番号・住所・電話番号）を直す。
 *
 * ■ なぜ代理店に開くのか
 *
 * これまで連絡先は本部しか直せなかった。引っ越しや電話番号の変更のたびに
 * 本部へ連絡してもらう形で、組織と枠の画面にも
 * 「連絡先はポータルからは直せないため、本部にご連絡ください」と出していた。
 * 自分の連絡先は自分で直せるほうが早いので、この3つだけ開く。
 *
 * ■ 開かないもの
 *
 *   ・法人名・代理店コード・ランク … 帳簿と報酬のたどり先が変わるため
 *   ・メールアドレス               … ログインとお知らせの宛先になるため
 *   ・振込先                       … お金の振込先が本人以外に書き換わると危ないため
 * これらは引き続き本部だけが直せる。
 *
 * ■ 誰の行を直すか
 *
 * ログインしている本人のコードで引いた1行だけ。
 * 画面から来たコードは信用しない（他人の行を書き換えられてしまうため）。
 */

export type ContactState = { error?: string; ok?: string };

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const text = (formData: FormData, key: string): string =>
  String(formData.get(key) ?? "").trim();
const orNull = (v: string): string | null => (v ? v : null);

/** 郵便番号。本部側の検分（actions/agency-actions.ts）と同じ形にそろえてある。 */
const ZIP_RE = /^[0-9〒\- ]{3,10}$/;
/** 電話番号。数字・ハイフン・かっこ・プラスまで。 */
const PHONE_RE = /^[0-9+\-() 　]{6,30}$/;

export async function updateContactAction(
  _prev: ContactState,
  formData: FormData,
): Promise<ContactState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "agency") {
    return { error: "この操作は代理店のアカウントでのみ行えます。" };
  }

  const zip = text(formData, "zip");
  const address = text(formData, "address");
  const phone = text(formData, "phone");

  if (zip && !ZIP_RE.test(zip)) {
    return { error: "郵便番号は半角の数字とハイフンで入力してください。（例）150-0043" };
  }
  if (address.length > 200) {
    return { error: "住所は200文字以内で入力してください。" };
  }
  if (phone && !PHONE_RE.test(phone)) {
    return { error: "電話番号は半角の数字とハイフンで入力してください。（例）03-6455-3655" };
  }

  let before: Row | null = null;
  try {
    before = await selectOne<Row>(
      `agencies?select=code,name,zip,address,phone&code=eq.${encodeURIComponent(viewer.code)}`,
    );
  } catch (e) {
    return {
      error:
        "いまの登録内容を読み込めませんでした。" +
        (e instanceof Error ? e.message : "") +
        " 時間をおいて、もう一度お試しください。",
    };
  }
  if (!before) {
    return { error: `代理店コード「${viewer.code}」の登録が見つかりませんでした。本部にお問い合わせください。` };
  }

  /* 変わったものだけを拾う。何も変えずに押されたときは、書き込みも記録もしない。 */
  const changed: string[] = [];
  if (zip !== s_(before, "zip")) changed.push("郵便番号");
  if (address !== s_(before, "address")) changed.push("住所");
  if (phone !== s_(before, "phone")) changed.push("電話番号");
  if (changed.length === 0) {
    return { ok: "変更はありませんでした。" };
  }

  try {
    await update(`agencies?code=eq.${encodeURIComponent(viewer.code)}`, {
      zip: orNull(zip),
      address: orNull(address),
      phone: orNull(phone),
    });
  } catch (e) {
    return {
      error:
        "連絡先を保存できませんでした。" +
        (e instanceof Error ? e.message : "") +
        " 時間をおいて、もう一度お試しください。",
    };
  }

  /* 誰がいつ何を変えたかを残す。本部から見て「勝手に変わった」と見えないようにするため。 */
  await audit(
    `${s_(before, "name") || viewer.code}（${viewer.code}）`,
    "連絡先の変更",
    { type: "agency", key: viewer.code },
    {
      変えたもの: changed.join("・"),
      前: {
        郵便番号: s_(before, "zip") || null,
        住所: s_(before, "address") || null,
        電話番号: s_(before, "phone") || null,
      },
      後: { 郵便番号: zip || null, 住所: address || null, 電話番号: phone || null },
    },
  );

  revalidatePath("/settings");
  // 本部の代理店一覧・詳細にもすぐ出るようにする
  revalidatePath("/admin/agencies");
  revalidatePath(`/admin/agencies/${viewer.code}`);
  revalidatePath("/organization");

  return { ok: `${changed.join("・")}を保存しました。` };
}
