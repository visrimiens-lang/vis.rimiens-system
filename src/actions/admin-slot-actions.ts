"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import {
  approveSlotIncrease,
  listAllAgencies,
  rejectSlotIncrease,
  slotLimitsOf,
} from "@/lib/agencies";
import { audit } from "@/lib/db";
import { SLOT_KINDS, breakdownSlots, isSlotKind } from "@/lib/slots";
import type { Agency } from "@/lib/types";

export type AdminSlotActionState = { error?: string; ok?: string };

/** 上限として受け付ける範囲。極端な数字の打ち間違いを止める。 */
const MAX_LIMIT = 200;

/** 枠の種類が指定されなかったときに増やす枠。以前の動きに合わせる。 */
const DEFAULT_KIND = "販売代理店";

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
 * その枠が、いま何社ぶん埋まっているかを数え直す。
 *
 * 枠は販路種別ごとに分かれている（2026-07-30 会議で 10/30/30/30 の計100枠に確定）。
 * 上限を「すでに埋まっている数」より小さくすると、その時点で定員超過の状態を
 * 作ってしまうため、承認する前にここで突き合わせる。
 */
function usedOfKind(target: Agency, children: Agency[], kind: string): number {
  const breakdown = breakdownSlots(target, children, slotLimitsOf(target));
  const line = breakdown.lines.find((l) => l.key === kind);
  return line ? line.used : 0;
}

/** 画面に出す枠の呼び方。 */
function kindLabel(kind: string): string {
  return SLOT_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

function readRecordId(formData: FormData): string {
  return String(formData.get("recordId") ?? "").trim();
}

/**
 * どの枠を増やすかを読む。
 * 指定が無ければ販売代理店枠（この画面ができる前と同じ扱い）。
 * 知らない値は受け付けない（別の列を書き換えてしまわないため）。
 */
function readKind(formData: FormData): string | null {
  const raw = String(formData.get("kind") ?? "").trim();
  if (!raw) return DEFAULT_KIND;
  return isSlotKind(raw) ? raw : null;
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

  const kind = readKind(formData);
  if (!kind) {
    return {
      error:
        "増やす枠を正しく選べていません。画面を読み込み直してから、もう一度お選びください。",
    };
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

    const used = usedOfKind(found.target, found.children, kind);
    if (newLimit < used) {
      return {
        error: `${kindLabel(kind)}の枠には、すでに ${used} 社が登録されています。新しい上限は ${used} 社以上にしてください。`,
      };
    }
    label = found.target.name || found.target.code;
    code = found.target.code;
    await approveSlotIncrease(recordId, newLimit, kind);
  } catch (e) {
    return failed("承認を保存できませんでした。", e);
  }

  await audit("HQ", "増枠申請の承認", { type: "agency", key: code }, {
    枠: kind,
    新しい上限: newLimit,
  });

  revalidatePath("/admin/requests");
  // 申請した代理店側の「組織と枠」にもすぐ反映させる
  revalidatePath("/organization");
  revalidatePath("/admin/agencies");
  return { ok: `${label} の${kindLabel(kind)}の枠を ${newLimit} 社に増やしました。` };
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
