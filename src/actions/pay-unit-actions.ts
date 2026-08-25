"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";

/**
 * 「この代理店にいくら払うか」を決める。
 *
 * ■ 何のための機能か
 *
 * 報酬の単価は商品マスタにランク別で1組だけ持っていて、全代理店に同じ額が当たる。
 * 「推奨は 50,000円（税抜）だが、この人だけ 30,000円にしたい」
 * 「インボイス登録が無いので減額したい」ができなかった。
 *
 * ここで額を入れると、その相手への報酬だけその額になる。
 * 空にすれば、また推奨の税抜単価（lib/pay-defaults.ts）に戻る。
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

  const raw = String(formData.get("amount") ?? "").trim().replace(/[,，\s円]/g, "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 200);

  let value: number | null = null;
  if (raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "金額は整数で入力してください。" };
    }
    if (n < 0) return { error: "金額にマイナスは入れられません。" };
    if (n > MAX_UNIT) {
      return { error: `金額が大きすぎます。1台あたり ${MAX_UNIT.toLocaleString("ja-JP")} 円までで入力してください。` };
    }
    value = n;
  }

  const before = s_(target, "pay_unit");
  try {
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      pay_unit: value,
      pay_unit_note: note || null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    // 列がまだ無いときは、何が足りないのかがすぐ分かるように書く
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
      変更前: before ? `${Number(before).toLocaleString("ja-JP")}円` : "既定（推奨の税抜単価）",
      変更後: value === null ? "既定（推奨の税抜単価）" : `${value.toLocaleString("ja-JP")}円`,
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
    ok:
      value === null
        ? `${s_(target, "name")} の支払額を既定に戻しました。次の受注から効きます。`
        : `${s_(target, "name")} の支払額を ${value.toLocaleString("ja-JP")} 円にしました。次の受注から効きます。`,
  };
}
