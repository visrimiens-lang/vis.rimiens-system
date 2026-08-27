"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import { payTaxExcl, payTaxIncl } from "@/lib/pay-defaults";

/**
 * 「この代理店にいくら払うか」を決める。
 *
 * ■ 何のための機能か
 *
 * 報酬の単価は商品マスタにランク別で1組だけ持っていて、全代理店に同じ額が当たる。
 * 「推奨は 55,000円（税込）だが、この人だけ 33,000円にしたい」
 * 「インボイス登録が無いので減額したい」ができなかった。
 *
 * ここで額を入れると、その相手への報酬だけその額になる。
 * 空にすれば、また推奨の単価（lib/pay-defaults.ts）に戻る。
 *
 * ■ 誰が変えられるか
 *
 *   ・本部
 *   ・その代理店の直上（エリア統括代理店）
 *
 * 払う側が決める額なので、本人には触らせない。
 * 直上だけに限っているのは、間に人が挟まっている相手の取り分を
 * 飛び越えて決められないようにするため。
 *
 * ■ すでに計上した報酬は変わらない
 *
 * 変更しても過去の報酬レコードには触らない。
 * 遡って書き換えると「先月払った額が今月変わる」が起きるため、次の受注から効く。
 * 画面にもそう書いてある。
 */

export type PayUnitState = { error?: string; ok?: string };

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/** 1台あたりの報酬として、現実的に受け付ける上限。打ち間違いを弾く。 */
const MAX_UNIT = 1_000_000;

export async function setPayUnitAction(
  _prev: PayUnitState,
  formData: FormData,
): Promise<PayUnitState> {
  const viewer = await currentViewer();
  if (!viewer) return { error: "ログインの有効期限が切れています。もう一度ログインしてください。" };

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "対象の代理店が指定されていません。" };

  const target = await selectOne<Row>(
    `agencies?select=code,name,parent_code,pay_unit&code=eq.${encodeURIComponent(code)}`,
  );
  if (!target) {
    return { error: "対象の代理店が見つかりませんでした。画面を読み込み直してください。" };
  }

  // 本部か、直上の代理店だけ
  const isHq = viewer.kind === "hq";
  const isParent = viewer.kind === "agency" && viewer.code === s_(target, "parent_code");
  if (!isHq && !isParent) {
    return {
      error:
        "この代理店の支払額を変えられるのは、本部と直上の代理店だけです。" +
        "ご自身の取り分は、上位の代理店にご相談ください。",
    };
  }

  const note = String(formData.get("note") ?? "").trim().slice(0, 200);

  /*
   * 入力欄は品目ごとに4つある。空欄と 0 は意味が違う。
   *   空欄 … 未設定。本体はランクの既定に戻り、OP は「払わない」。
   *   0    … わざと 0 円にした。既定には戻さない。
   *
   * 入力欄の金額は税込（画面をすべて税込でそろえたため）。
   * 保存は税抜きのままにする。支払通知書が小計に消費税を足して総額を出すので、
   * 税込で保存すると書面の金額が二重に課税された額になる。
   */
  const read = (field: string, label: string): number | null | { error: string } => {
    const raw = String(formData.get(field) ?? "").trim().replace(/[,，\s円]/g, "");
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: `${label}は整数で入力してください。` };
    }
    if (n < 0) return { error: `${label}にマイナスは入れられません。` };
    if (n > MAX_UNIT) {
      return {
        error: `${label}が大きすぎます。${MAX_UNIT.toLocaleString("ja-JP")} 円までで入力してください。`,
      };
    }
    return n;
  };

  const fields: { field: string; column: string; label: string }[] = [
    { field: "amount", column: "pay_unit", label: "本体価格" },
    { field: "amountOp1", column: "pay_unit_op1", label: "OP①" },
    { field: "amountOp2", column: "pay_unit_op2", label: "OP②" },
    { field: "amountPadYearly", column: "pay_unit_pad_yearly", label: "1年後定期" },
  ];

  const values: Record<string, number | null> = {};
  const shown: string[] = [];
  for (const f of fields) {
    const v = read(f.field, f.label);
    if (v !== null && typeof v === "object") return { error: v.error };
    values[f.column] = v === null ? null : payTaxExcl(v);
    shown.push(`${f.label} ${v === null ? "未設定" : `${v.toLocaleString("ja-JP")}円（税込）`}`);
  }

  const before = s_(target, "pay_unit");
  try {
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      ...values,
      pay_unit_note: note || null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    // 列がまだ無いときは、何が足りないのかがすぐ分かるように書く
    if (/pay_unit_op1|pay_unit_op2|pay_unit_pad_yearly/.test(msg)) {
      return {
        error:
          "OP①・OP②・1年後定期を保存する場所がまだ用意されていません。" +
          "agencies に pay_unit_op1 / pay_unit_op2 / pay_unit_pad_yearly を足してから、もう一度お試しください。",
      };
    }
    if (/pay_unit/.test(msg)) {
      return {
        error:
          "支払額を保存する場所がまだ用意されていません。" +
          "supabase/migrations/2026-08-19_agency_pay_unit.sql を流してから、もう一度お試しください。",
      };
    }
    return { error: `保存できませんでした。${msg}` };
  }

  await audit(
    isHq ? "VIS 本部" : viewer.code,
    "支払額の変更",
    { type: "agency", key: code },
    {
      対象: `${s_(target, "name")}（${code}）`,
      変更前: before
        ? `${payTaxIncl(Number(before)).toLocaleString("ja-JP")}円（税込）`
        : "既定（推奨の単価）",
      変更後: shown.join(" ／ "),
      理由: note || "（未記入）",
      補足:
        "本部の報酬台帳はさかのぼって変わらない。" +
        "売上・報酬画面のお支払額の表示は、過去の月もいまの額で計算し直される。",
    },
  );

  revalidatePath("/organization");
  revalidatePath("/admin/agencies");
  revalidatePath(`/admin/agencies/${code}`);

  return {
    ok: `${s_(target, "name")} の支払額を保存しました（${shown.join(" ／ ")}）。`,
  };
}
