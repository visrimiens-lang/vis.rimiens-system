"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentViewer } from "@/lib/auth";
import { audit, insert, selectOne, update } from "@/lib/db";

/**
 * デモ機の台帳（本部専用）。
 *
 * kintone の App13「VIS端末・デモ機管理」の代わりになる。
 * 本部がここで行うのは4つ。
 *   ・新しいデモ機を登録する
 *   ・登録した内容（製品番号や保有者など）を直す
 *   ・貸し出す（貸出先・貸出日・返却予定日を記録する）
 *   ・返してもらう（返却日を記録し、状態を返却済にする）
 *
 * 貸出と返却は日付が揃っていないと「返ってきていない台」が分からなくなるため、
 * 内容の修正とは別の操作に分けてある。
 * どの操作も、誰がいつ行ったかを記録に残す。
 */

export type DemoFormState = {
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

/* ------------------------------------------------------------------
 * 選べる値。保存先（Supabase）側にも同じ制限がかかっているので、
 * ここを増やすときは保存先の設定もあわせて直すこと。
 * 画面の選択肢は DemoForm.tsx にも同じ並びで書いてある。
 * ------------------------------------------------------------------ */

/** 画面から直接指定してよい状態。貸出中と返却済は、貸出・返却の操作でしか付けられない。 */
const MANUAL_STATES = ["在庫", "設置済", "故障・修理", "廃棄"];
/** 保存先が受け付けるすべての状態。 */
const ALL_STATES = [...MANUAL_STATES, "貸出中", "返却済"];
const ACQUIRED_KINDS = ["個人購入", "デモ機購入", "無料貸与"];
const CONVERTED_KINDS = ["該当なし", "転用済", "未転用"];

const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})?$/;

type Row = Record<string, unknown>;

const s_ = (r: Row | null, k: string): string => {
  const v = r?.[k];
  return v === null || v === undefined ? "" : String(v);
};

const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);

/** 日本時間の今日を "YYYY-MM-DD" で返す。貸出日・返却日の既定値に使う。 */
function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/**
 * id は必ず数字であることを確かめてから絞り込み条件に埋める。
 * ここを素通りさせると、条件の効かない更新で台帳が丸ごと書き換わる事故につながる。
 */
function byId(id: string): string | null {
  const clean = id.trim();
  return /^\d+$/.test(clean) ? `demo_machines?id=eq.${clean}` : null;
}

/** 対象のデモ機を引き直す。見つからなければ日本語の理由を返す。 */
async function findMachine(
  id: string,
): Promise<{ ok: true; query: string; row: Row } | { ok: false; error: string }> {
  const query = byId(id);
  if (!query) {
    return {
      ok: false,
      error:
        "どのデモ機を操作するのかを特定できませんでした。画面を読み込み直してから、もう一度お試しください。",
    };
  }
  let row: Row | null = null;
  try {
    row = await selectOne<Row>(`${query}&select=*`);
  } catch (e) {
    return {
      ok: false,
      error: message(
        e,
        "デモ機の情報を読み込めませんでした。時間をおいてもう一度お試しください。",
      ),
    };
  }
  if (!row) {
    return {
      ok: false,
      error:
        "このデモ機の登録が見つかりませんでした。ほかの担当者が先に直した可能性があります。画面を読み込み直してご確認ください。",
    };
  }
  return { ok: true, query, row };
}

/** 保存したあと、本部の台帳と代理店の「デモ機」の両方を出し直す。 */
function refresh() {
  revalidatePath("/admin/demo");
  revalidatePath("/demo-machines");
}

/* ---------- 入力の確認（登録・修正で共通） ---------- */

const detailSchema = z.object({
  serialNo: z
    .string()
    .trim()
    .min(1, "製品番号を入力してください。デモ機は製品番号で1台ずつ管理しています。")
    .max(60, "製品番号は60文字以内で入力してください。"),
  model: z.string().trim().max(60, "機種名は60文字以内で入力してください。"),
  acquiredKind: z.string().trim(),
  acquiredOn: z
    .string()
    .trim()
    .regex(DATE_PATTERN, "取得日は「2026-08-11」のような形式で入力してください。"),
  state: z.string().trim(),
  holderCode: z.string().trim().max(20, "保有代理店コードは20文字以内で入力してください。"),
  holderName: z.string().trim().max(100, "保有者（責任者）は100文字以内で入力してください。"),
  customerName: z.string().trim().max(100, "設置先のお客様名は100文字以内で入力してください。"),
  purpose: z.string().trim().max(200, "用途は200文字以内で入力してください。"),
  converted: z.string().trim(),
  note: z.string().trim().max(2000, "メモは2000文字以内で入力してください。"),
});

type Detail = z.infer<typeof detailSchema>;

type ParsedDetail = { ok: true; value: Detail } | { ok: false; error: string };

function parseDetail(formData: FormData): ParsedDetail {
  const result = detailSchema.safeParse({
    serialNo: String(formData.get("serialNo") ?? ""),
    model: String(formData.get("model") ?? ""),
    acquiredKind: String(formData.get("acquiredKind") ?? ""),
    acquiredOn: String(formData.get("acquiredOn") ?? ""),
    state: String(formData.get("state") ?? ""),
    holderCode: String(formData.get("holderCode") ?? ""),
    holderName: String(formData.get("holderName") ?? ""),
    customerName: String(formData.get("customerName") ?? ""),
    purpose: String(formData.get("purpose") ?? ""),
    converted: String(formData.get("converted") ?? ""),
    note: String(formData.get("note") ?? ""),
  });

  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: first?.message ?? "入力内容をご確認ください。" };
  }

  const value = result.data;

  if (value.acquiredKind && !ACQUIRED_KINDS.includes(value.acquiredKind)) {
    return {
      ok: false,
      error: `取得のしかたは ${ACQUIRED_KINDS.join("・")} から選んでください。`,
    };
  }
  if (value.converted && !CONVERTED_KINDS.includes(value.converted)) {
    return {
      ok: false,
      error: `販売への転用は ${CONVERTED_KINDS.join("・")} から選んでください。`,
    };
  }
  if (value.state && !ALL_STATES.includes(value.state)) {
    return { ok: false, error: `状態は ${MANUAL_STATES.join("・")} から選んでください。` };
  }

  return { ok: true, value };
}

/** 保存する形にそろえる。空欄は null にして、未入力と空文字を混ぜない。 */
function toPayload(value: Detail): Record<string, string | null> {
  return {
    serial_no: value.serialNo,
    model: orNull(value.model) ?? "VIS本体",
    acquired_kind: orNull(value.acquiredKind),
    acquired_on: orNull(value.acquiredOn),
    holder_code: orNull(value.holderCode),
    holder_name: orNull(value.holderName),
    customer_name: orNull(value.customerName),
    purpose: orNull(value.purpose),
    converted: orNull(value.converted) ?? "該当なし",
    note: orNull(value.note),
  };
}

/** 同じ製品番号がすでに使われていないか確かめる。exceptId は自分自身の除外用。 */
async function serialTaken(serial: string, exceptId?: string): Promise<boolean> {
  const found = await selectOne<Row>(
    `demo_machines?select=id&serial_no=eq.${encodeURIComponent(serial)}`,
  );
  if (!found) return false;
  return exceptId ? s_(found, "id") !== exceptId.trim() : true;
}

/* ---------- 新しいデモ機を登録する ---------- */

export async function createDemoAction(
  _prev: DemoFormState,
  formData: FormData,
): Promise<DemoFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const parsed = parseDetail(formData);
  if (!parsed.ok) return { error: parsed.error };
  const value = parsed.value;

  try {
    if (await serialTaken(value.serialNo)) {
      return {
        error: `製品番号 ${value.serialNo} はすでに登録されています。一覧で検索して、そちらを直してください。`,
      };
    }
  } catch (e) {
    return {
      error: message(
        e,
        "すでに登録がないかを確認できませんでした。時間をおいてもう一度お試しください。",
      ),
    };
  }

  const state = value.state || "在庫";
  if (state === "貸出中" || state === "返却済") {
    return {
      error:
        "登録のときは「貸出中」「返却済」にはできません。まず在庫として登録し、そのあと一覧の「貸出を登録」「返却を登録」から手続きしてください。",
    };
  }

  try {
    await insert("demo_machines", [{ ...toPayload(value), state }]);
  } catch (e) {
    return {
      error: message(
        e,
        "デモ機を登録できませんでした。時間をおいてもう一度お試しください。",
      ),
    };
  }

  await audit("HQ", "デモ機登録", { type: "demo_machine", key: value.serialNo }, {
    機種: value.model || "VIS本体",
    状態: state,
    保有者: value.holderName || value.holderCode || "未設定",
  });

  refresh();
  return {
    ok: `製品番号 ${value.serialNo} のデモ機を「${state}」で登録しました。貸し出すときは一覧の「貸出を登録」から手続きしてください。`,
    savedAt: Date.now(),
  };
}

/* ---------- 登録内容を直す ---------- */

export async function updateDemoAction(
  _prev: DemoFormState,
  formData: FormData,
): Promise<DemoFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const found = await findMachine(String(formData.get("id") ?? ""));
  if (!found.ok) return { error: found.error };

  const parsed = parseDetail(formData);
  if (!parsed.ok) return { error: parsed.error };
  const value = parsed.value;

  const currentState = s_(found.row, "state");
  // 状態の欄が空で届くのは貸出中の台（欄そのものを出していない）。いまの状態を保つ。
  const nextState = value.state || currentState || "在庫";

  // 貸出と返却は日付が要るため、状態だけを付け替えることはできない
  if (nextState !== currentState) {
    if (nextState === "貸出中") {
      return {
        error:
          "「貸出中」はこの欄では選べません。貸出先と返却予定日が必要なため、一覧の「貸出を登録」から手続きしてください。",
      };
    }
    if (nextState === "返却済") {
      return {
        error:
          "「返却済」はこの欄では選べません。返却日を残す必要があるため、一覧の「返却を登録」から手続きしてください。",
      };
    }
    if (currentState === "貸出中") {
      return {
        error:
          "このデモ機は貸出中です。状態を変えるには、先に「返却を登録」で返却日を記録してください。",
      };
    }
  }

  if (value.serialNo !== s_(found.row, "serial_no")) {
    try {
      if (await serialTaken(value.serialNo, s_(found.row, "id"))) {
        return {
          error: `製品番号 ${value.serialNo} は別のデモ機で使われています。番号をご確認ください。`,
        };
      }
    } catch (e) {
      return {
        error: message(
          e,
          "製品番号の重複を確認できませんでした。時間をおいてもう一度お試しください。",
        ),
      };
    }
  }

  const patch: Record<string, string | null> = { ...toPayload(value), state: nextState };

  try {
    await update(found.query, patch);
  } catch (e) {
    return {
      error: message(e, "変更を保存できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  await audit("HQ", "デモ機の修正", { type: "demo_machine", key: value.serialNo }, {
    製品番号: value.serialNo === s_(found.row, "serial_no")
      ? value.serialNo
      : `${s_(found.row, "serial_no")} → ${value.serialNo}`,
    状態: currentState === nextState ? nextState : `${currentState} → ${nextState}`,
    保有者: value.holderName || value.holderCode || "未設定",
  });

  refresh();
  return {
    ok:
      currentState === nextState
        ? `製品番号 ${value.serialNo} の登録内容を直しました。`
        : `製品番号 ${value.serialNo} の登録内容を直し、状態を「${nextState}」にしました。`,
  };
}

/* ---------- 貸し出す ---------- */

const lendSchema = z.object({
  lendTo: z
    .string()
    .trim()
    .min(1, "貸出先を入力してください。どなたにお貸ししたかが分からないと回収できません。")
    .max(100, "貸出先は100文字以内で入力してください。"),
  lendOn: z
    .string()
    .trim()
    .regex(DATE_PATTERN, "貸出日は「2026-08-11」のような形式で入力してください。"),
  returnDueOn: z
    .string()
    .trim()
    .regex(DATE_PATTERN, "返却予定日は「2026-08-11」のような形式で入力してください。"),
  purpose: z.string().trim().max(200, "用途は200文字以内で入力してください。"),
  customerName: z.string().trim().max(100, "設置先のお客様名は100文字以内で入力してください。"),
});

export async function lendDemoAction(
  _prev: DemoFormState,
  formData: FormData,
): Promise<DemoFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const found = await findMachine(String(formData.get("id") ?? ""));
  if (!found.ok) return { error: found.error };

  if (s_(found.row, "state") === "廃棄") {
    return {
      error:
        "廃棄したことになっているデモ機です。貸し出す前に「内容を修正」で状態を「在庫」に戻してください。",
    };
  }

  const result = lendSchema.safeParse({
    lendTo: String(formData.get("lendTo") ?? ""),
    lendOn: String(formData.get("lendOn") ?? ""),
    returnDueOn: String(formData.get("returnDueOn") ?? ""),
    purpose: String(formData.get("purpose") ?? ""),
    customerName: String(formData.get("customerName") ?? ""),
  });
  if (!result.success) {
    const first = result.error.issues[0];
    return { error: first?.message ?? "入力内容をご確認ください。" };
  }
  const value = result.data;

  const lendOn = value.lendOn || todayInJapan();
  if (!value.returnDueOn) {
    return {
      error:
        "返却予定日を入れてください。予定日を過ぎた台は一覧で目立つように表示され、回収の声かけができます。",
    };
  }
  if (value.returnDueOn < lendOn) {
    return { error: "返却予定日は貸出日より後の日付にしてください。" };
  }

  const serial = s_(found.row, "serial_no") || "（製品番号なし）";

  try {
    await update(found.query, {
      state: "貸出中",
      lend_to: value.lendTo,
      lend_on: lendOn,
      return_due_on: value.returnDueOn,
      returned_on: null,
      purpose: orNull(value.purpose),
      customer_name: orNull(value.customerName),
    });
  } catch (e) {
    return {
      error: message(e, "貸出を記録できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  await audit("HQ", "デモ機の貸出", { type: "demo_machine", key: serial }, {
    貸出先: value.lendTo,
    貸出日: lendOn,
    返却予定日: value.returnDueOn,
  });

  refresh();
  return {
    ok: `製品番号 ${serial} を ${value.lendTo} へ貸出中にしました。返却予定日は ${value.returnDueOn} です。返ってきたら「返却を登録」から記録してください。`,
  };
}

/* ---------- 返してもらう ---------- */

const returnSchema = z.object({
  returnedOn: z
    .string()
    .trim()
    .regex(DATE_PATTERN, "返却日は「2026-08-11」のような形式で入力してください。"),
  note: z.string().trim().max(2000, "メモは2000文字以内で入力してください。"),
});

export async function returnDemoAction(
  _prev: DemoFormState,
  formData: FormData,
): Promise<DemoFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const found = await findMachine(String(formData.get("id") ?? ""));
  if (!found.ok) return { error: found.error };

  const result = returnSchema.safeParse({
    returnedOn: String(formData.get("returnedOn") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!result.success) {
    const first = result.error.issues[0];
    return { error: first?.message ?? "入力内容をご確認ください。" };
  }

  const returnedOn = result.data.returnedOn || todayInJapan();
  const lendOn = s_(found.row, "lend_on");
  if (lendOn && returnedOn < lendOn) {
    return {
      error: `返却日は貸出日（${lendOn}）より後の日付にしてください。日付が違う場合は「内容を修正」で貸出日をご確認ください。`,
    };
  }

  const serial = s_(found.row, "serial_no") || "（製品番号なし）";
  const lentTo = s_(found.row, "lend_to");
  const note = result.data.note;

  try {
    await update(found.query, {
      state: "返却済",
      returned_on: returnedOn,
      ...(note ? { note } : {}),
    });
  } catch (e) {
    return {
      error: message(e, "返却を記録できませんでした。時間をおいてもう一度お試しください。"),
    };
  }

  await audit("HQ", "デモ機の返却", { type: "demo_machine", key: serial }, {
    貸出先: lentTo || "記録なし",
    返却日: returnedOn,
  });

  refresh();
  return {
    ok: `製品番号 ${serial} を ${returnedOn} に返却済として記録しました。もう一度貸し出せるようにするには、「内容を修正」で状態を「在庫」に戻してください。`,
  };
}
