"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import { STAFF_TYPES } from "@/lib/labels";

/**
 * スタッフの「所属会社名」と「種別」を決める。
 *
 * ■ 何のための機能か
 *
 * 2026-08-22 に、エリア統括代理店の下は全員スタッフとして
 * 統括の4文字コード＋4桁（例 SASA0002）で登録する形に変わった。
 * そのスタッフが「どこの会社の人か」「販売代理店か・サロンか・個人か」は、
 * 申込フォーム（JotForm）からは送られてこない。
 * エリア統括代理店が、自分の「組織と枠」の画面でここを設定する。
 *
 * ■ 誰が変えられるか
 *
 *   ・本部
 *   ・そのスタッフの上にいる代理店（直上でなくてもよい）
 *
 * 支払額（pay-unit-actions.ts）は「直上だけ」に限っている。お金の話なので、
 * 間に人が挟まっている相手の取り分を飛び越えて決められないようにするため。
 * こちらは金額に関わらない情報で、しかも旧方式で登録された会社
 * （株式会社樹など）の配下スタッフは統括から見ると孫にあたるため、
 * 直上だけに限ると誰も直せない人が出る。上にいる代理店なら直せることにする。
 *
 * ■ ランクと販路種別は触らない
 *
 * 種別は staff_type という専用の列に入れる。販路種別（channel）に入れると、
 * 受注一覧の単価が 取次店 27,500円 から 販売代理店 55,000円 に変わってしまう。
 * 見た目の呼び名を変えるだけのつもりが金額に効くため、列を分けてある。
 */

export type StaffProfileState = { error?: string; ok?: string };

/**
 * 種別ごとの既定の支払額（lib/pay-defaults.ts と同じ値）。
 * この額が入っているときは「既定のまま」とみなし、種別を変えたら合わせて変える。
 */
const DEFAULT_AMOUNTS = [25000, 50000];

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

export async function setStaffProfileAction(
  _prev: StaffProfileState,
  formData: FormData,
): Promise<StaffProfileState> {
  const viewer = await currentViewer();
  if (!viewer) return { error: "ログインの有効期限が切れています。もう一度ログインしてください。" };

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "対象のスタッフが指定されていません。" };

  /*
   * 対象はコードで引き直す。
   * 画面から来た区分や上位コードは信用しない（8時間前の写しのことがある）。
   *
   * 列がまだ無い環境ではこの SELECT 自体が落ちるので、ここも try で受ける。
   * 受けないと画面に何も出ないまま操作が終わり、原因が分からなくなる。
   */
  let target: Row | null = null;
  try {
    target = await selectOne<Row>(
      `agencies?select=code,name,parent_code,code_kind,company_name,staff_type,pay_unit` +
        `&code=eq.${encodeURIComponent(code)}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    if (/company_name|staff_type/.test(msg)) {
      return {
        error:
          "所属会社名と種別を保存する場所がまだ用意されていません。" +
          "supabase/migrations/2026-08-24_staff_affiliation.sql を流してから、もう一度お試しください。",
      };
    }
    return { error: `対象のスタッフを読み取れませんでした。${msg}` };
  }
  if (!target) {
    return { error: "対象のスタッフが見つかりませんでした。画面を読み込み直してください。" };
  }

  if (s_(target, "code_kind") !== "02") {
    return {
      error:
        "所属会社名と種別を設定できるのはスタッフだけです。" +
        "会社の代理店種別は、本部の代理店詳細から変更してください。",
    };
  }

  const isHq = viewer.kind === "hq";
  /*
   * 自分の配下にいるかを、上へたどって確かめる。
   * 画面から来た値ではなく、その都度データベースの parent_code をたどる。
   * 途中で輪になっていても止まるように、見た相手を覚えておく。
   */
  let isAbove = false;
  if (!isHq && viewer.kind === "agency") {
    const seen = new Set<string>();
    let cur = s_(target, "parent_code");
    while (cur && !seen.has(cur)) {
      if (cur === viewer.code) {
        isAbove = true;
        break;
      }
      seen.add(cur);
      const up = await selectOne<Row>(
        `agencies?select=parent_code&code=eq.${encodeURIComponent(cur)}`,
      );
      cur = s_(up, "parent_code");
    }
  }
  if (!isHq && !isAbove) {
    return {
      error:
        "このスタッフの所属と種別を変えられるのは、本部と、上にいる代理店だけです。",
    };
  }

  const companyName = String(formData.get("companyName") ?? "").trim().slice(0, 100);
  const rawType = String(formData.get("staffType") ?? "").trim();
  if (rawType && !STAFF_TYPES.includes(rawType as (typeof STAFF_TYPES)[number])) {
    return { error: `種別は ${STAFF_TYPES.join("・")} のいずれかを選んでください。` };
  }

  const beforeCompany = s_(target, "company_name");
  const beforeType = s_(target, "staff_type");
  if (companyName === beforeCompany && rawType === beforeType) {
    return { ok: "変更はありませんでした。" };
  }

  /*
   * 種別を変えたら、支払額も新しい種別の既定に合わせる。
   *
   *   取次店   … 25,000円
   *   それ以外 … 50,000円
   *
   * 個別の額を null に戻すことで、以後は種別に自動で追随する。
   * ただし、既定とは違う額（例：30,000円）が入っているときは触らない。
   * その額は誰かが意図して決めたものなので、種別を直したついでに
   * 勝手に書き換えると、約束した金額が黙って変わってしまう。
   */
  const typeChanged = rawType !== beforeType;
  const currentUnit = target["pay_unit"];
  const isDefaultAmount =
    currentUnit === null ||
    currentUnit === undefined ||
    DEFAULT_AMOUNTS.includes(Number(currentUnit));
  const resetPayUnit = typeChanged && isDefaultAmount;

  try {
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      company_name: companyName || null,
      staff_type: rawType || null,
      ...(resetPayUnit ? { pay_unit: null, pay_unit_note: null } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    // 列がまだ無いときは、何を流せばよいかがすぐ分かるように書く
    if (/company_name|staff_type/.test(msg)) {
      return {
        error:
          "所属会社名と種別を保存する場所がまだ用意されていません。" +
          "supabase/migrations/2026-08-24_staff_affiliation.sql を流してから、もう一度お試しください。",
      };
    }
    return { error: `保存できませんでした。${msg}` };
  }

  await audit(
    isHq ? "VIS 本部" : viewer.code,
    "スタッフの所属・種別の変更",
    { type: "agency", key: code },
    {
      対象: `${s_(target, "name")}（${code}）`,
      所属会社名: `${beforeCompany || "（未設定）"} → ${companyName || "（未設定）"}`,
      種別: `${beforeType || "（未設定）"} → ${rawType || "（未設定）"}`,
    },
  );

  revalidatePath("/organization");
  revalidatePath("/admin/agencies");
  revalidatePath(`/admin/agencies/${code}`);

  const newAmount = rawType === "取次店" ? 25000 : 50000;
  return {
    ok:
      `${s_(target, "name")} の所属と種別を保存しました。` +
      (resetPayUnit
        ? `支払額も既定の ${newAmount.toLocaleString("ja-JP")} 円に合わせました。`
        : ""),
  };
}
