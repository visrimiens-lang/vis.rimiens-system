"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentViewer } from "@/lib/auth";
import { audit, selectOne, update } from "@/lib/db";
import { isLoanMethod } from "@/lib/payment-status";

/**
 * お客様の登録内容を直す（本部専用）。
 *
 * 目的は「住所や電話番号の書き間違いを本部の手で直せるようにする」こと。
 * kintone を解約したあと、宛先の誤りを直す場所がここしか無くなるため、
 * 出荷前に気づいた誤りをその場で直せるようにしてある。
 *
 * 担当スタッフ（staff_code）もここから直せる。
 * 2026-08-07 の打合せで「誰が売ったかを追えない」と指摘があった列で、
 * お申し込みの取り込みでは入らないため、空欄のまま残る方がいる。
 * 本部が聞き取って埋められる場所を1つ用意しておかないと、列を出しても埋まらない。
 * 担当代理店・紹介元と違って報酬の計算には使っていないので、この画面から直してよい。
 *
 * 消す操作はわざと用意していない。
 * お客様の登録は保証・保守・報酬の裏付けになるので、
 * 間違えて消してしまうと元に戻せない。取り消しが必要なときは
 * 決済・出荷の状態を変える運用で対応する。
 */

export type CustomerFormState = {
  error?: string;
  ok?: string;
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

type Row = Record<string, unknown>;

const s_ = (r: Row | null, k: string): string => {
  const v = r?.[k];
  return v === null || v === undefined ? "" : String(v);
};

/** 空欄は null で保存する（空文字と未入力を混ぜないため）。 */
const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "お名前を入力してください。")
    .max(100, "お名前は100文字以内で入力してください。"),
  nameKana: z.string().trim().max(100, "フリガナは100文字以内で入力してください。"),
  phone: z
    .string()
    .trim()
    .max(30, "電話番号は30文字以内で入力してください。")
    .regex(
      /^[0-9+\-()\s]*$/,
      "電話番号は半角の数字とハイフンで入力してください（例：090-1234-5678）。",
    ),
  email: z
    .string()
    .trim()
    .max(200, "メールアドレスは200文字以内で入力してください。")
    .refine(
      (v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      "メールアドレスの形が正しくありません。@ より前後の綴りをご確認ください。",
    ),
  zip: z
    .string()
    .trim()
    .regex(
      /^(\d{3}-?\d{4})?$/,
      "郵便番号は「123-4567」のように半角の数字7桁で入力してください。",
    ),
  address: z.string().trim().max(200, "住所は200文字以内で入力してください。"),
  building: z
    .string()
    .trim()
    .max(100, "建物名・部屋番号は100文字以内で入力してください。"),
  receiptName: z
    .string()
    .trim()
    .max(100, "領収書のあて名は100文字以内で入力してください。"),
  note: z.string().trim().max(2000, "本部メモは2000文字以内で入力してください。"),
  // 代理店コードと同じ形（例：RIM0003）。空欄＝まだ分からない、として保存する。
  staffCode: z
    .string()
    .trim()
    .max(20, "担当スタッフのコードは20文字以内で入力してください。")
    .regex(
      /^[A-Za-z0-9-]*$/,
      "担当スタッフのコードは半角の英数字とハイフンで入力してください（例：RIM0003）。",
    ),
});

type Input = z.infer<typeof schema>;

/** 郵便番号は「123-4567」の形にそろえて保存する。 */
function normalizeZip(v: string): string {
  const digits = v.replace(/[^0-9]/g, "");
  return digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : v;
}

/** 保存する列と、画面に出すときの呼び名。変更点の記録にも使う。 */
const FIELDS: { column: string; label: string; of: (v: Input) => string }[] = [
  { column: "name", label: "お名前", of: (v) => v.name },
  { column: "name_kana", label: "フリガナ", of: (v) => v.nameKana },
  { column: "phone", label: "電話番号", of: (v) => v.phone },
  { column: "email", label: "メールアドレス", of: (v) => v.email },
  { column: "zip", label: "郵便番号", of: (v) => normalizeZip(v.zip) },
  { column: "address", label: "住所", of: (v) => v.address },
  { column: "building", label: "建物名・部屋番号", of: (v) => v.building },
  { column: "receipt_name", label: "領収書のあて名", of: (v) => v.receiptName },
  { column: "note", label: "本部メモ", of: (v) => v.note },
  { column: "staff_code", label: "担当スタッフ", of: (v) => v.staffCode },
];

type Parsed = { ok: true; value: Input } | { ok: false; error: string };

function parse(formData: FormData): Parsed {
  const result = schema.safeParse({
    name: String(formData.get("name") ?? ""),
    nameKana: String(formData.get("nameKana") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    zip: String(formData.get("zip") ?? ""),
    address: String(formData.get("address") ?? ""),
    building: String(formData.get("building") ?? ""),
    receiptName: String(formData.get("receiptName") ?? ""),
    note: String(formData.get("note") ?? ""),
    staffCode: String(formData.get("staffCode") ?? ""),
  });

  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: first?.message ?? "入力内容をご確認ください。" };
  }
  return { ok: true, value: result.data };
}

/**
 * id は必ず数字であることを確かめてから絞り込み条件に埋める。
 * ここを素通りさせると、条件の効かない更新で全件が書き換わる事故につながる。
 */
function byId(id: string): string | null {
  const clean = id.trim();
  return /^\d+$/.test(clean) ? `customers?id=eq.${clean}` : null;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/* ---------- お客様の登録内容を直す ---------- */

export async function updateCustomerAction(
  _prev: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = String(formData.get("id") ?? "").trim();
  const query = byId(id);
  if (!query) {
    return {
      error:
        "どのお客様を直すのかを特定できませんでした。画面を読み込み直してから、もう一度お試しください。",
    };
  }

  const parsed = parse(formData);
  if (!parsed.ok) return { error: parsed.error };
  const value = parsed.value;

  // いまの内容を引き直して、どこが変わるのかを記録できるようにする
  let before: Row | null = null;
  try {
    before = await selectOne<Row>(`${query}&select=*`);
  } catch (e) {
    return {
      error: message(
        e,
        "いまの登録内容を読み込めませんでした。時間をおいてもう一度お試しください。",
      ),
    };
  }
  if (!before) {
    return {
      error:
        "このお客様の登録が見つかりませんでした。ほかの担当者が先に直した可能性があります。画面を読み込み直してご確認ください。",
    };
  }

  const patch: Record<string, string | null> = {};
  const changes: Record<string, string> = {};
  for (const f of FIELDS) {
    const next = f.of(value);
    if (next === s_(before, f.column)) continue;
    patch[f.column] = orNull(next);
    changes[f.label] = `${s_(before, f.column) || "（空欄）"} → ${next || "（空欄）"}`;
  }

  const label = value.name || s_(before, "name") || "お名前未登録の方";

  if (Object.keys(patch).length === 0) {
    return {
      ok: `${label} 様の登録内容は、いま画面に出ている内容と同じでした。変更はしていません。`,
    };
  }

  /*
   * 担当スタッフのコードを入れ直したときは、代理店一覧に載っているかを見ておく。
   * 報酬の支払先ではないので入力そのものは止めない（まだ登録前の方を聞き取れた場合に
   * 記録できなくなるほうが困る）。ただし打ち間違いにはその場で気づけるよう、
   * 保存後のお知らせに一言そえる。
   */
  let staffNote = "";
  if ("staff_code" in patch && value.staffCode) {
    try {
      const agency = await selectOne<Row>(
        `agencies?select=code,name&code=eq.${encodeURIComponent(value.staffCode)}`,
      );
      staffNote = agency
        ? `　担当スタッフは「${s_(agency, "name") || value.staffCode}」として記録しました。`
        : `　なお、担当スタッフのコード「${value.staffCode}」は代理店一覧に見つかりませんでした。` +
          "打ち間違いがないかご確認ください。";
    } catch {
      // 確認できなくても、担当スタッフを記録すること自体は妨げない
      staffNote = "　担当スタッフのコードが代理店一覧にあるかは確認できませんでした。";
    }
  }

  try {
    await update(query, patch);
  } catch (e) {
    return {
      error: message(
        e,
        "変更を保存できませんでした。時間をおいてもう一度お試しください。続くようなら本部の担当者にご連絡ください。",
      ),
    };
  }

  await audit("HQ", "顧客情報の修正", { type: "customer", key: id }, {
    顧客: label,
    変更点: changes,
  });

  revalidatePath("/admin/customers");

  const changed = Object.keys(changes).join("・");
  const shipped = s_(before, "ship_status") === "出荷済";
  const addressTouched = "住所" in changes || "郵便番号" in changes || "建物名・部屋番号" in changes;

  const done =
    addressTouched && shipped
      ? `${label} 様の${changed}を直しました。この方はすでに出荷済みです。届け先が変わる場合は、配送業者への転送手配もあわせてご確認ください。`
      : addressTouched
        ? `${label} 様の${changed}を直しました。出荷前であれば、新しいお届け先で発送されます。`
        : `${label} 様の${changed}を直しました。`;

  return { ok: done + staffNote };
}

/* ══════════════════ お支払いの状態を、顧客管理から直す ══════════════════ */

/**
 * 銀行振込・アプラスのお支払いを「着金待ち ↔ 決済完了」で切り替える（本部専用）。
 *
 * ■ なぜ顧客管理からも変えられるようにするか
 *
 * 着金の確認は「顧客管理を眺めて、着金待ちの人に連絡する」流れで行う。
 * その画面から受注詳細まで開き直さないと変えられないと、確認のたびに
 * 画面を行き来することになり、変え忘れが出る（2026-08-27 の打合せ）。
 *
 * ■ クレジットカードは変えない
 *
 * クレジットカードは決済が済んでから通知が届くので、いつでも決済完了。
 * 手で変えられるようにすると、実際には支払われていないものを完了にできてしまう。
 * 変えられるのは、お金がまだ動いていない銀行振込とアプラスだけにする。
 *
 * ■ 顧客台帳と受注の両方を直す
 *
 * 顧客管理と代理店の顧客管理は customers を、受注一覧は orders を見ている。
 * 片方だけ直すと、同じお客様の状態が画面によって食い違う。
 * そのお客様の受注のうち、クレジットカード以外のものだけをそろえる。
 */
export async function setCustomerPaymentStatusAction(
  _prev: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = String(formData.get("customerId") ?? "").trim();
  if (!/^\d+$/.test(id)) return { error: "お客様を特定できませんでした。" };

  const next = String(formData.get("paymentStatus") ?? "").trim();
  if (next !== "着金待ち" && next !== "決済完了") {
    return { error: "お支払いは「着金待ち」「決済完了」から選んでください。" };
  }

  try {
    const customer = await selectOne<Row>(
      `customers?select=id,name,payment_method,payment_status&id=eq.${id}`,
    );
    if (!customer) return { error: "このお客様は見つかりませんでした。" };

    const method = String(customer["payment_method"] ?? "").trim();
    if (!isLoanMethod(method) && method !== "振込") {
      return {
        error:
          "クレジットカードのお支払いは、決済が済んでから自動で「決済完了」になります。" +
          "手で変えられるのは銀行振込とアプラスだけです。",
      };
    }

    await update(`customers?id=eq.${id}`, { payment_status: next });

    /*
     * 同じお客様の受注もそろえる。
     * クレジットカードの受注が混ざっていても、そちらは触らない
     * （その受注は自動で決済完了になっているため）。
     */
    try {
      await update(
        `orders?customer_id=eq.${id}&payment_method=not.in.("Stripe","スクエア")`,
        { payment_status: next },
      );
    } catch {
      // payment_status の列がまだ無い環境。顧客台帳だけは直っている。
    }

    await audit("HQ", "お支払いの状態を変更", { type: "customer", key: id }, {
      お客様: String(customer["name"] ?? ""),
      決済方法: method,
      変更前: String(customer["payment_status"] ?? "（未設定）"),
      変更後: next,
    });
  } catch (e) {
    return {
      error:
        e instanceof Error
          ? `お支払いの状態を保存できませんでした。${e.message}`
          : "お支払いの状態を保存できませんでした。時間をおいてお試しください。",
    };
  }

  revalidatePath("/admin/customers");
  revalidatePath("/admin/orders");
  revalidatePath("/customers");
  return { ok: `お支払いを「${next}」にしました。` };
}
