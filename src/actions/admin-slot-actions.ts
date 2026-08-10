"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import {
  approveSlotIncrease,
  countsTowardSlot,
  listAllAgencies,
  rejectSlotIncrease,
} from "@/lib/agencies";
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
  | { ok: true; target: Agency; used: number }
  | { ok: false; error: string };

/**
 * 対象の代理店を実データから引き直す。
 * あわせて、配下の正規代理店（コード区分 00）を数え直して実際の使用数を出す。
 */
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
  const used = all.filter(
    (a) => a.parentCode === target.code && countsTowardSlot(a),
  ).length;
  return { ok: true, target, used };
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

/** 増枠を承認する。新しい上限を保存し、申請ステータスを承認済にする。 */
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
  try {
    const found = await locate(recordId);
    if (!found.ok) return { error: found.error };
    if (newLimit < found.used) {
      return {
        error: `すでに ${found.used} 社が登録されています。新しい上限は ${found.used} 社以上にしてください。`,
      };
    }
    label = found.target.name || found.target.code;
    await approveSlotIncrease(recordId, newLimit);
  } catch (e) {
    return failed("承認を保存できませんでした。", e);
  }

  revalidatePath("/admin/requests");
  // 申請した代理店側の「組織と枠」にもすぐ反映させる
  revalidatePath("/organization");
  return { ok: `${label} の枠を ${newLimit} 社に増やしました。` };
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
  try {
    const found = await locate(recordId);
    if (!found.ok) return { error: found.error };
    label = found.target.name || found.target.code;
    await rejectSlotIncrease(recordId);
  } catch (e) {
    return failed("却下を保存できませんでした。", e);
  }

  revalidatePath("/admin/requests");
  revalidatePath("/organization");
  return { ok: `${label} の申請を却下しました。枠の上限は変更していません。` };
}
