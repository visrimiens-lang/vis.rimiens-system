"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import { normalizeCode, resolveAttribution } from "@/lib/intake";
import { accrueRewards, reverseRewards } from "@/lib/rewards";

/**
 * 受注に「どの代理店の売上か」を入れ直して、報酬を立て直す。
 *
 * ■ なぜ要るか
 *
 * 売上の付け先は、決済のときの ?ref= から自動で決まる。
 * ところがコードが届かなかった受注は付け先が空のまま入り、
 * 本部にはあとから直す手段が無かった。
 * 受注の詳細画面で直せるのは紹介元コードと担当スタッフだけで、
 * 売上の付け先（代理店・2次・ゼロ次）は表示だけだった。
 *
 * 実際、5月から8月の実受注7件はコードが1つも入っておらず、
 * 報酬が1円も立たないまま残っている。
 *
 * ■ やること
 *
 * 代理店コードを1つ受け取り、そこから所属をたどって
 * 「売った代理店・担当スタッフ・紹介した取次・2次・ゼロ次」を組み立て直し、
 * 報酬を計上し直す（前に立てた分は消してから入れ直す）。
 *
 * スタッフや取次パートナーのコードを入れても、
 * 決済のときと同じ扱いで所属先の会社に売上が付く。
 */

export type AttributionState = { error?: string; ok?: string };

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

export async function setOrderAttributionAction(
  _prev: AttributionState,
  formData: FormData,
): Promise<AttributionState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "権限がありません。本部のアカウントでログインし直してからお試しください。" };
  }

  const id = String(formData.get("id") ?? "").trim();
  if (!/^\d+$/.test(id)) return { error: "対象の受注が指定されていません。" };

  const code = normalizeCode(String(formData.get("agencyCode") ?? ""));
  if (!code) {
    return { error: "代理店コードを入力してください。" };
  }
  if (!/^[A-Z0-9-]{1,20}$/.test(code)) {
    return { error: `「${code}」は代理店コードの形ではありません（例：MENO0001）。` };
  }

  try {
    const order = await selectOne<Row>(
      `orders?select=id,code,agency_code,customer_name,product_name&id=eq.${encodeURIComponent(id)}`,
    );
    if (!order) return { error: "対象の受注が見つかりませんでした。" };

    const agency = await selectOne<Row>(
      `agencies?select=code,name,code_kind&code=eq.${encodeURIComponent(code)}`,
    );
    if (!agency) {
      return {
        error:
          `代理店コード「${code}」は代理店一覧に登録されていません。` +
          "打ち間違いがないかご確認ください。まだ登録前の相手であれば、先に代理店を登録してください。",
      };
    }

    // 決済のときと同じ手順で、売上の付け先と担当者を組み立て直す
    const at = await resolveAttribution(code, "");

    const before = s_(order, "agency_code");
    await update(`orders?id=eq.${id}`, {
      agency_code: at.agencyCode || null,
      staff_code: at.staffCode || null,
      referrer_code: at.referrerCode || null,
      niji_code: at.nijiCode || null,
      zeroth_code: at.zerothCode || null,
    });

    /*
     * 前に立てた報酬が生きたまま残っていれば、先に取り消してから立て直す。
     * 取り消さずに立て直そうとすると accrueRewards が 0 を返すだけで、
     * 帰属の列は新しい代理店に変わったのに報酬は前の代理店のまま残り、
     * 支払先がずれる。以前は「商品マスタをご確認ください」という
     * 筋違いの案内が出て、ずれたまま気づけない状態だった。
     */
    await reverseRewards(id, "帰属の入れ直しのため");
    const count = await accrueRewards(Number(id), { redo: true });

    await audit(viewer.label || "本部", "受注の帰属を直す", { type: "order", key: id }, {
      受注: s_(order, "code") || id,
      お客様: s_(order, "customer_name"),
      入力したコード: code,
      変更前の代理店コード: before || "（空）",
      入れ直した内容: at,
      立て直した報酬の件数: count,
    });

    revalidatePath(`/admin/orders/${id}`);
    revalidatePath("/admin/orders");
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");

    return {
      ok:
        count > 0
          ? `${s_(agency, "name")}（${at.agencyCode}）の売上として登録し、報酬を ${count} 件立てました。`
          : `${s_(agency, "name")}（${at.agencyCode}）の売上として登録しました。` +
            "ただし報酬は1件も立ちませんでした。商品名が商品マスタと一致しているかご確認ください。",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "保存できませんでした。";
    return { error: msg };
  }
}
