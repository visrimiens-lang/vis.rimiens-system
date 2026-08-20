"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, select, selectOne, update } from "@/lib/db";
import { isOrgCode, normalizeCode } from "@/lib/intake";

/**
 * 会社に「自社代理店コード」（組織の英字）を設定する。
 *
 * ■ なぜ要るか
 *
 * 2026-08-20 の打合せで、代理店コードの決め方が変わった。
 * これからの申込は「自社代理店コード発行」の欄で申込者が自分の英字4文字を決め、
 * その英字がそのまま会社の代理店コードになる（目のトレーニング株式会社 → MENO）。
 *
 * ところが、その前から動いている会社は代理店コードが数字混じりのまま
 * （株式会社comvace は RIM0004）で、英字を持っていない。
 * 配下の3次代理店やスタッフが自社コードで申し込んでも、その会社にたどり着けない。
 *
 * ここで英字を後から設定できるようにして、新旧を橋渡しする。
 *
 * ■ 代理店コードそのものは変えない
 *
 * すでにお渡ししたQRの ?ref= や、ポータルのログインIDに使われているため、
 * 代理店コードを書き換えると受注の帰属もログインも壊れる。
 * 設定するのは org_code（組織の英字）と invite_code（配下が入力する招待コード）だけ。
 * 以後この会社の配下は「英字＋4桁」（COMV0001 など）で採番される。
 */

export type OrgCodeState = { error?: string; ok?: string };

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

export async function setOrgCodeAction(
  _prev: OrgCodeState,
  formData: FormData,
): Promise<OrgCodeState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "権限がありません。本部のアカウントでログインし直してからお試しください。" };
  }

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "対象の代理店が指定されていません。" };

  const orgCode = normalizeCode(String(formData.get("orgCode") ?? ""));
  if (!orgCode) {
    return { error: "自社代理店コードを入力してください。" };
  }
  if (!isOrgCode(orgCode)) {
    return {
      error:
        `「${orgCode}」は使えません。半角大文字のアルファベット4文字（例 MENO）でご入力ください。`,
    };
  }

  try {
    const target = await selectOne<Row>(
      `agencies?select=code,name,code_kind,org_code&code=eq.${encodeURIComponent(code)}`,
    );
    if (!target) return { error: "対象の代理店が見つかりませんでした。" };
    if (s_(target, "code_kind") !== "00") {
      return {
        error:
          "自社代理店コードを持てるのは会社だけです。" +
          "取次パートナーやスタッフは、所属する会社の英字を引き継ぎます。",
      };
    }

    const before = s_(target, "org_code");
    if (before === orgCode) {
      return { ok: `${s_(target, "name")} の自社代理店コードは、すでに ${orgCode} です。` };
    }

    /*
     * 同じ英字を2社が使うと、どちらの配下なのかコードから読めなくなる。
     * 打合せでも「COM がコンバスとコメットで被る」ことが心配されていた点なので、
     * 設定するときに必ず止める。
     */
    const clash = await select<Row>(
      `agencies?select=code,name&or=(code.eq.${encodeURIComponent(orgCode)},` +
        `org_code.eq.${encodeURIComponent(orgCode)},invite_code.eq.${encodeURIComponent(orgCode)})`,
    );
    const other = clash.find((r) => s_(r, "code") !== code);
    if (other) {
      return {
        error:
          `${orgCode} は ${s_(other, "name")}（${s_(other, "code")}）がすでに使っています。` +
          "別の4文字を決めてください。",
      };
    }

    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      org_code: orgCode,
      // 配下がこの英字を招待コードとして入力したときに引けるようにする
      invite_code: orgCode,
    });

    await audit(viewer.label || "本部", "自社代理店コード設定", { type: "agency", key: code }, {
      代理店: s_(target, "name"),
      設定した英字: orgCode,
      変更前: before || "（未設定）",
      補足: "代理店コードとログインIDは変えていません。以後この会社の配下は 英字＋4桁 で採番されます。",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "保存できませんでした。";
    return { error: msg };
  }

  revalidatePath(`/admin/agencies/${code}`);
  revalidatePath("/admin/agencies");
  return {
    ok:
      `自社代理店コードを ${orgCode} に設定しました。` +
      `これ以降、この会社の取次パートナー・スタッフは ${orgCode}0001 の形で採番されます。`,
  };
}
