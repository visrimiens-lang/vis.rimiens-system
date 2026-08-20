"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import {
  markProcessed,
  notifyLicenseTest,
  registerAgency,
  registerDemoMachine,
  registerLead,
  registerPreLead,
} from "@/lib/intake";
import { pickFromJotform } from "@/lib/jotform-fields";

/**
 * 受信箱に取り込めずに残っている申込を、もう一度取り込む。
 *
 * ■ なぜ要るか
 *
 * 受信箱は「申込を取りこぼさない」ために、届いたものを丸ごと先に残す作りになっている。
 * ところが取り込みに失敗したものを拾い直す手段が無く、本部から見ると
 * 「うまくいかなかった理由」が書かれた行が積み上がるだけで、何もできなかった。
 *
 * 実際 2026-08-19 に届いた代理店登録2件は、項目の取り出しの不具合で取り込めず、
 * 不具合を直したあとも過去分は取り残されたままになった。
 *
 * ここを通せば、いまのコードでもう一度取り込み直せる。
 *
 * ■ 種類の決め方
 *
 * 届いたときの URL に付いていた種類（kind）は残していないので、
 * JotForm が一緒に送ってくるフォーム名から判断する。
 * 判断できないときは取り込まず、本部に知らせる。
 */

export type InboxActionState = { error?: string; ok?: string };

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/** フォーム名から申込の種類を見分ける。 */
function kindOfForm(payload: Record<string, unknown>): string {
  const title = String(payload["formTitle"] ?? "");
  if (/取次パートナー|取次店/.test(title)) return "referrer";
  if (/スタッフ|ライセンス認定|販売ライセンス/.test(title)) return "staff";
  if (/ライセンステスト|テスト提出|採点/.test(title)) return "license-test";
  if (/トスアップ|ご紹介|紹介フォーム/.test(title)) return "lead";
  if (/デモ機|デモ端末/.test(title)) return "demo";
  if (/事前登録|体験/.test(title)) return "pre-register";
  if (/代理店/.test(title)) return "agency";
  return "";
}

/**
 * 受信箱の1件を「対応済み」にする。
 *
 * 決済（UTAGE）から届いたものは、送り元から届き直すことがないので
 * 取り込み直せない。実際、過去の受注を手で復元した7件が
 * 「報酬が1件も計上されませんでした」のまま消せずに残っていた。
 * 本部が中身を確認して手当てを終えたら、ここで片付けられるようにする。
 *
 * 消すのではなく「対応済み」にするだけなので、届いた内容は残る。
 */
export async function dismissInboxAction(
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "権限がありません。本部のアカウントでログインし直してからお試しください。" };
  }

  const id = String(formData.get("id") ?? "").trim();
  if (!/^\d+$/.test(id)) return { error: "対象が指定されていません。" };

  const note = String(formData.get("note") ?? "").trim().slice(0, 200);
  if (!note) {
    return { error: "どう手当てしたかを書いてください。あとから経緯を追えるようにするためです。" };
  }

  const row = await selectOne<Row>(`inbox?select=id,source,error&id=eq.${encodeURIComponent(id)}`);
  if (!row) return { error: "対象が見つかりませんでした。画面を読み込み直してください。" };

  try {
    await update(`inbox?id=eq.${encodeURIComponent(id)}`, {
      processed: true,
      error: `【対応済み】${note}`,
    });
    await audit(viewer.label || "本部", "受信箱を対応済みにする", { type: "inbox", key: id }, {
      送り元: s_(row, "source"),
      もとの内容: s_(row, "error") || "（なし）",
      手当ての内容: note,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存できませんでした。" };
  }

  revalidatePath("/admin/inbox");
  revalidatePath("/dashboard");
  return { ok: "対応済みにしました。" };
}

export async function reprocessInboxAction(
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "権限がありません。本部のアカウントでログインし直してからお試しください。" };
  }

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "対象が指定されていません。" };

  const row = await selectOne<Row>(`inbox?select=*&id=eq.${encodeURIComponent(id)}`);
  if (!row) return { error: "対象が見つかりませんでした。画面を読み込み直してください。" };

  const payload = (row["payload"] ?? {}) as Record<string, unknown>;
  const source = s_(row, "source");
  if (source !== "jotform") {
    return {
      error:
        `${source || "この"} からの受信は、この画面からは取り込み直せません。` +
        "決済など送り元から届き直すものは、送り元でもう一度送ってください。",
    };
  }

  const kind = String(formData.get("kind") ?? "").trim() || kindOfForm(payload);
  if (!kind) {
    return {
      error:
        "申込の種類を判断できませんでした（フォーム名が読み取れません）。" +
        "代理店管理の画面から手で登録してください。",
    };
  }

  const pick = pickFromJotform(payload);
  const submissionId = pick("submissionID", "submission_id") || undefined;

  try {
    let result: { ok: boolean; message: string };

    if (kind === "demo") {
      result = await registerDemoMachine({
        serialNo: pick("製品番号", "シリアル", "serial"),
        model: pick("機種", "model") || undefined,
        acquiredKind: pick("取得区分", "acquiredKind") || undefined,
        acquiredOn: pick("取得日", "acquiredOn") || undefined,
        holderCode: pick("代理店コード", "保有代理店コード", "code") || undefined,
        holderName: pick("保有代理店名", "代理店名") || undefined,
        purpose: pick("貸与目的", "目的", "purpose") || undefined,
        note: pick("備考", "note") || undefined,
      });
    } else if (kind === "pre-register" || kind === "prelead") {
      result = await registerPreLead({
        customerName: pick("お名前", "氏名", "ニックネーム", "name"),
        phone: pick("電話", "phone", "tel"),
        referrerCode: pick("紹介コード", "スタッフコード", "code"),
        note: pick("備考", "note"),
      });
    } else if (kind === "license-test" || kind === "test") {
      result = await notifyLicenseTest({
        name: pick("お名前", "氏名", "name"),
        agencyCode: pick("代理店コード", "スタッフコード", "code") || undefined,
        score: pick("点数", "得点", "score") || undefined,
        detail: pick("回答", "detail") || undefined,
      });
    } else if (kind === "lead") {
      result = await registerLead({
        customerName: pick("お客様氏名", "お名前", "氏名", "name", "customerName"),
        phone: pick("電話", "phone", "tel"),
        referrerCode: pick("取次店コード", "紹介コード", "referrerCode", "code"),
        note: pick("備考", "note"),
      });
    } else {
      const formKind =
        kind === "referrer" ? "取次パートナー登録"
        : kind === "staff" ? "スタッフ登録"
        : "代理店システム登録";
      result = await registerAgency({
        formKind,
        name: pick(
          "会社名", "サロン名", "法人名", "textbox6", "textbox14",
          "fullname20", "お名前", "氏名", "input3", "name",
        ),
        repName: pick("代表者", "代表者名", "representative"),
        email: pick("input32", "メール", "email", "mail"),
        phone: pick("input33", "携帯電話", "電話", "phone", "tel"),
        zip: pick("郵便番号", "zip", "postal"),
        address: pick("住所", "address"),
        shopName: pick("input60", "店舗名", "屋号", "shop"),
        birthday: pick("input19", "生年月日", "birthday"),
        inviteCode: pick("input48", "招待コード", "紹介コード", "上位代理店コード"),
        // 自社コード。項目名はフォームごとに違う（webhooks/jotform/route.ts の説明を参照）
        orgCode:
          pick("input53", "自社代理店コード", "自社コード", "input43", "代理店招待コード", "inviteCode") ||
          undefined,
        agencyType: pick("代理店種別", "agencyType", "q4_radio2", "radio2") || undefined,
        entityType: pick("登録区分", "q3_radio1", "radio1") || undefined,
        channel: pick("販路種別", "channel") || undefined,
        areaClass: pick("エリア", "area") || undefined,
        bank: {
          name: pick("銀行名", "bankName"),
          branch: pick("支店名", "branch"),
          type: pick("口座種別", "accountType"),
          number: pick("口座番号", "accountNumber"),
          holder: pick("口座名義", "accountHolder"),
        },
        jotformId: submissionId,
      });
    }

    await markProcessed(Number(id), result.ok ? undefined : result.message);
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/agencies");
    return result.ok
      ? { ok: result.message }
      : { error: result.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "取り込みに失敗しました。";
    await markProcessed(Number(id), msg);
    revalidatePath("/admin/inbox");
    return { error: msg };
  }
}
