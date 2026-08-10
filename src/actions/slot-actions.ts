"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, requestSlotIncrease } from "@/lib/agencies";

export type SlotActionState = { error?: string; ok?: string };

/**
 * 販売代理店枠の増枠を申請する。
 *
 * 対象レコードは必ずログイン中の本人（currentViewer）から取る。
 * フォームから recordId を受け取らないため、他社のレコードは書き換えられない。
 */
export async function requestSlotIncreaseAction(
  _prev: SlotActionState,
  _formData: FormData,
): Promise<SlotActionState> {
  const viewer = await currentViewer();
  if (!viewer) {
    return { error: "ログインの有効期限が切れています。もう一度ログインしてからお試しください。" };
  }
  if (viewer.kind !== "agency") {
    return { error: "増枠の申請は代理店のアカウントからのみ行えます。" };
  }
  if (!viewer.recordId) {
    return {
      error:
        "お客様の代理店情報を特定できませんでした。お手数ですが本部にお問い合わせください。",
    };
  }

  try {
    const me = await findAgencyByCode(viewer.code);
    if (!me) {
      return {
        error:
          "代理店情報が見つかりませんでした。お手数ですが本部にお問い合わせください。",
      };
    }
    if (me.slotRequestStatus === "申請中") {
      return { error: "すでに増枠を申請しています。本部の確認をお待ちください。" };
    }

    // 書き込み対象は、認可判定に使ったのと同じ最新レコードから引く。
    // Cookie 内の recordId は最大8時間前のスナップショットのため使わない。
    await requestSlotIncrease(me.recordId);
  } catch (e) {
    return {
      error:
        e instanceof Error
          ? `申請を送信できませんでした。${e.message}`
          : "申請を送信できませんでした。時間をおいてもう一度お試しください。",
    };
  }

  revalidatePath("/organization");
  return { ok: "増枠を申請しました。本部が確認しますので、しばらくお待ちください。" };
}
