"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { approveSlotIncrease, listAllAgencies, rejectSlotIncrease } from "@/lib/agencies";
import { audit } from "@/lib/db";
import { breakdownSlots } from "@/lib/slots";
import type { Agency } from "@/lib/types";

export type AdminSlotActionState = { error?: string; ok?: string };

/** 上限として受け付ける範囲。極端な数字の打ち間違いを止める。 */
const MAX_LIMIT = 200;

/**
 * 本部以外は一切書き換えできない。
 * フォームから recordId を受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") return "権限がありません。";
  return null;
}

type Located =
  | { ok: true; target: Agency; children: Agency[] }
  | { ok: false; error: string };

/** 対象の代理店と、その直下を実データから引き直す。 */
async function locate(recordId: string): Promise<Located> {
  const all = await listAllAgencies();
  const target = all.find((a) => a.recordId === recordId);
  if (!target) {
    return {
      ok: false,
      error: "対象の代理店が見つかりませんでした。画面を読み込み直してからお試しください。",
    };
  }
  if (target.slotRequestStatus !== "申請中") {
    return {
      ok: false,
      error: "この申請はすでに処理されています。画面を読み込み直してご確認ください。",
    };
  }
  const children = all.filter((a) => a.parentCode === target.code && a.code !== target.code);
  return { ok: true, target, children };
}

/**
 * いま何名ぶん埋まっているかを数え直す。
 *
 * 枠は「スタッフ100名」の1本（2026-08-22〜）。
 * 上限を「すでに埋まっている数」より小さくすると、その時点で定員超過の状態を
 * 作ってしまうため、承認する前にここで突き合わせる。
 */
function usedNow(target: Agency, children: Agency[]): number {
  return breakdownSlots(target, children).used;
}

function readRecordId(formData: FormData): string {
  return String(formData.get("recordId") ?? "").trim();
}

function failed(prefix: string, e: unknown): AdminSlotActionState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいてもう一度お試しください。`,
  };
}

/** 増枠を承認する。選ばれた枠の上限を保存し、申請ステータスを承認済にする。 */
export async function approveAction(
  _prev: AdminSlotActionState,
  formData: FormData,
): Promise<AdminSlotActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const recordId = readRecordId(formData);
  if (!recordId) {
    return { error: "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。" };
  }

  const raw = String(formData.get("newLimit") ?? "").trim();
  const newLimit = Number(raw);
  if (!raw || !Number.isInteger(newLimit)) {
    return { error: "新しい上限は半角の数字で入力してください。" };
  }
  if (newLimit < 1 || newLimit > MAX_LIMIT) {
    return { error: `新しい上限は 1〜${MAX_LIMIT} 社の範囲で入力してください。` };
  }

  let label = "";
  let code = "";
  try {
    const found = await locate(recordId);
    if (!found.ok) return { error: found.error };

    const used = usedNow(found.target, found.children);
    if (newLimit < used) {
      return {
        error: `すでに ${used} 名が登録されています。新しい上限は ${used} 名以上にしてください。`,
      };
    }
    label = found.target.name || found.target.code;
    code = found.target.code;
    await approveSlotIncrease(recordId, newLimit);
  } catch (e) {
    return failed("承認を保存できませんでした。", e);
  }

  await audit("HQ", "増枠申請の承認", { type: "agency", key: code }, {
    新しい上限: `スタッフ ${newLimit} 名`,
  });

  revalidatePath("/admin/requests");
  // 申請した代理店側の「組織と枠」にもすぐ反映させる
  revalidatePath("/organization");
  revalidatePath("/admin/agencies");
  return { ok: `${label} の枠を スタッフ ${newLimit} 名 に増やしました。` };
}

/** 増枠を却下する。上限は変えず、申請ステータスだけ却下にする。 */
export async function rejectAction(
  _prev: AdminSlotActionState,
  formData: FormData,
): Promise<AdminSlotActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const recordId = readRecordId(formData);
  if (!recordId) {
    return { error: "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。" };
  }

  let label = "";
  let code = "";
  try {
    const found = await locate(recordId);
    if (!found.ok) return { error: found.error };
    label = found.target.name || found.target.code;
    code = found.target.code;
    await rejectSlotIncrease(recordId);
  } catch (e) {
    return failed("却下を保存できませんでした。", e);
  }

  await audit("HQ", "増枠申請の却下", { type: "agency", key: code });

  revalidatePath("/admin/requests");
  revalidatePath("/organization");
  revalidatePath("/admin/agencies");
  return { ok: `${label} の申請を却下しました。枠の上限は変更していません。` };
}
