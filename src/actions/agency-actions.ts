"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { listAllAgencies, listDescendants, slotLimitsOf } from "@/lib/agencies";
import { currentViewer } from "@/lib/auth";
import { audit, insert, select, selectOne, update } from "@/lib/db";
import {
  ZEROTH_CODE,
  canRegisterUnder,
  hasOrgCodeColumn,
  nextAgencyCode,
  orgOf,
} from "@/lib/intake";
import { PORTAL_URL, approvalMail, sendMail } from "@/lib/mail";
import { OFFICIAL_LINE_URL, tossUpUrl } from "@/lib/qr";
import { areaUsage, breakdownSlots, slotModelOf } from "@/lib/slots";
import type { Agency } from "@/lib/types";

/**
 * 本部が代理店を編集するための処理。
 *
 * kintone の代理店マスタでやっていた「内容の修正」「承認（稼働中への切り替え）」
 * 「電話申込の手入力」を、この3つに置き換える。
 *
 * 画面から届く値は一切信用しない。権限の判定・値の絞り込み・上位のたどり直しは
 * すべてここで行う。稼働状況の切り替えは必ず記録を残す（誰がいつ承認したかを
 * 後から辿れるようにするため）。
 */

export type AgencyActionState = {
  error?: string;
  ok?: string;
  /** 登録が成功したときだけ変わる。画面側は入力欄を空に戻す合図に使う。 */
  at?: number;
};

/**
 * 本部以外は一切書き換えできない。
 * フォームから id を受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return "権限がありません。本部のアカウントでログインし直してからお試しください。";
  }
  return null;
}

/* ═══════════════ 受け付ける値 ═══════════════ */

const RANKS = ["総販売代理店", "2次代理店", "取次店"] as const;
const CHANNELS = [
  "サロン提携パートナー（取次）",
  "サロン代理店",
  "個人販売パートナー",
  "販売代理店",
  "未設定",
] as const;
const CODE_KINDS = ["00", "01", "02"] as const;
const STATUSES = ["未稼働", "稼働中", "停止・解約"] as const;
const TRAININGS = ["未受講", "受講中", "合格", "不合格"] as const;
const SIGNS = ["未署名", "署名済"] as const;
const AREA_CLASSES = [
  "本部",
  "北海道+東北",
  "関東",
  "中部",
  "関西+近畿",
  "中国+四国",
  "九州+沖縄",
] as const;
const ACCOUNT_TYPES = ["普通", "当座"] as const;

/** 枠の上限として受け付ける範囲。打ち間違いを止める。 */
const MAX_LIMIT = 200;

/** 上位をたどるときの上限。循環していても止まるようにする。 */
const MAX_HOPS = 20;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 実在する日付か。
 *
 * 形（0000-00-00）だけを見ていると 2026-02-31 や 2026-13-01 が通ってしまい、
 * 保存先で弾かれた英語のエラーがそのまま画面に出る。
 * ここで先に止めて、日本語で言い直す。
 */
function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // 「翌月の0日」＝その月の末日
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const ZIP_RE = /^[0-9〒\- ]{3,10}$/;

/* ═══════════════ 小さな道具 ═══════════════ */

type Row = Record<string, unknown>;

function s(r: Row | null, k: string): string {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** 決められた値のどれかに丸める。画面から知らない値が来ても弾く。 */
function pick(raw: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(raw) ? raw : fallback;
}

/** 空欄は null にする。データベース側の入力チェックに引っかからないようにするため。 */
function orNull(v: string): string | null {
  return v ? v : null;
}

/** 数字だけの id か確かめる。画面の値をそのまま絞り込みに使わない。 */
function readId(formData: FormData): string | null {
  const id = text(formData, "id");
  return /^\d+$/.test(id) ? id : null;
}

function failed(prefix: string, e: unknown): AgencyActionState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいてもう一度お試しください。`,
  };
}

/** 保存後に、本部の一覧・この代理店の画面・代理店側の組織図を出し直す。 */
function refresh(code: string): void {
  revalidatePath("/admin/agencies");
  revalidatePath(`/admin/agencies/${code}`);
  revalidatePath("/organization");
  // 増枠申請の画面も「上位」の名前を持っているので、あわせて出し直す。
  revalidatePath("/admin/requests");
}

async function findById(id: string): Promise<Row | null> {
  return selectOne<Row>(`agencies?select=*&id=eq.${encodeURIComponent(id)}`);
}

async function findByCode(code: string): Promise<Row | null> {
  return selectOne<Row>(`agencies?select=*&code=eq.${encodeURIComponent(code)}`);
}

/**
 * その代理店の下に、別の代理店をぶら下げてよいか調べる。
 *
 * 取次パートナー・スタッフ・取次店ランク・停止解約の下には付けられない
 * （4次以降の禁止。申込フォーム経由の判定と同じ決まり）。
 * 手で登録するときと、上位を付け替えるときの両方で、この同じ判定を使う。
 *
 * 付けられないときは理由の言葉を返す。返した言葉に、呼び出し側で次の一手を足す。
 */
function parentBlockReason(parent: Row): string | null {
  const label = s(parent, "name") || s(parent, "code") || "この代理店";
  const kind = s(parent, "code_kind");
  if (kind === "01" || kind === "02") {
    return `${label} は取次パートナーまたはスタッフです`;
  }
  if (s(parent, "rank") === "取次店") {
    return `${label} は取次店です`;
  }
  if (s(parent, "status") === "停止・解約") {
    return `${label} は停止・解約です`;
  }
  return null;
}

/** ぶら下がっている代理店の件数を数える。区分・ランクを下げてよいかの判断に使う。 */
async function countChildren(code: string): Promise<number> {
  const rows = await select<Row>(
    `agencies?select=id&parent_code=eq.${encodeURIComponent(code)}`,
  );
  return rows.length;
}

/**
 * 上位に付け替えたときに輪ができないか調べる。
 * 選んだ上位から親をたどって、自分自身に戻ってきたら付け替えられない。
 */
async function makesLoop(ownCode: string, parentCode: string): Promise<boolean> {
  let cursor = parentCode;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (!cursor) return false;
    if (cursor === ownCode) return true;
    const row = await selectOne<Row>(
      `agencies?select=parent_code&code=eq.${encodeURIComponent(cursor)}`,
    );
    if (!row) return false;
    cursor = s(row, "parent_code");
  }
  return true;
}

/* ═══════════════ 書き写した値の直し（連鎖） ═══════════════ */

/*
 * 代理店の表には、速く出すために「上位代理店名（parent_name）」と
 * 「ゼロ次代理店（zeroth_code）」を書き写して持たせている。
 * 元になる代理店を直しただけでは、この書き写した値は古いままになるので、
 * 保存のたびに配下の行もそろえ直す。
 *
 * ・名前を直したとき   → 直下の行が持つ「上位代理店名」を新しい名前に
 * ・上位を付け替えたとき → 配下・孫まで全部の「ゼロ次代理店」を新しい組織に
 */

/** 一度に書き換える件数の上限。長すぎる問い合わせを作らないため。 */
const CHAIN_CHUNK = 100;

/** 代理店コードの並びを PostgREST の in.(…) の形にする。 */
function inFilter(codes: string[]): string {
  const list = codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
  return `in.${encodeURIComponent(`(${list})`)}`;
}

/**
 * 直下の代理店が持つ「上位代理店名」を、新しい名前にそろえる。
 * 直した件数を返す。
 */
async function renameParentLabel(code: string, name: string): Promise<number> {
  const rows = await update<Row>(
    `agencies?parent_code=eq.${encodeURIComponent(code)}`,
    { parent_name: name },
  );
  return rows.length;
}

/**
 * 配下・孫までの「ゼロ次代理店」を、新しい組織にそろえる。
 * 直した件数を返す。
 *
 * ここを直さないと、以後の受注登録が古いゼロ次を拾い、
 * 組織ごとの集計が合わなくなる。
 */
async function retagZeroth(codes: string[], zeroth: string): Promise<number> {
  let done = 0;
  for (let i = 0; i < codes.length; i += CHAIN_CHUNK) {
    const chunk = codes.slice(i, i + CHAIN_CHUNK);
    const rows = await update<Row>(`agencies?code=${inFilter(chunk)}`, {
      zeroth_code: zeroth,
    });
    done += rows.length;
  }
  return done;
}

/* ═══════════════ 内容の修正 ═══════════════ */

const editSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "法人名（またはお名前）を入力してください。")
    .max(120, "法人名は120文字以内で入力してください。"),
  repName: z.string().trim().max(60, "代表者名は60文字以内で入力してください。"),
  email: z.string().trim().max(200, "メールアドレスは200文字以内で入力してください。"),
  phone: z.string().trim().max(30, "電話番号は30文字以内で入力してください。"),
  zip: z.string().trim().max(10, "郵便番号は10文字以内で入力してください。"),
  address: z.string().trim().max(200, "住所は200文字以内で入力してください。"),
  shopName: z.string().trim().max(120, "店舗名は120文字以内で入力してください。"),
  branchName: z.string().trim().max(120, "支店名は120文字以内で入力してください。"),
  area: z.string().trim().max(60, "エリアは60文字以内で入力してください。"),
  bankName: z.string().trim().max(60, "金融機関名は60文字以内で入力してください。"),
  bankBranch: z.string().trim().max(60, "支店名は60文字以内で入力してください。"),
  accountNo: z.string().trim().max(20, "口座番号は20文字以内で入力してください。"),
  accountHolder: z.string().trim().max(60, "口座名義は60文字以内で入力してください。"),
  note: z.string().trim().max(2000, "本部の覚書は2000文字以内で入力してください。"),
});

/** 画面に出すときの項目名。どこを直したかを記録に残すために使う。 */
const LABELS: Record<string, string> = {
  name: "法人名・お名前",
  rep_name: "代表者名",
  rank: "ランク",
  channel: "販路種別",
  code_kind: "コード区分",
  parent_code: "上位代理店",
  parent_name: "上位代理店名",
  zeroth_code: "ゼロ次代理店",
  email: "メールアドレス",
  phone: "電話番号",
  zip: "郵便番号",
  address: "住所",
  shop_name: "店舗名",
  branch_name: "支店名",
  birthday: "生年月日",
  area: "エリア",
  area_class: "エリア区分",
  training_status: "研修の進み方",
  training_passed_on: "研修に合格した日",
  sign_status: "電子署名",
  limit_hanbai: "販売代理店の枠",
  limit_salon: "サロン代理店の枠",
  limit_kojin: "個人販売パートナーの枠",
  limit_toritsugi: "取次パートナーの枠",
  special_slot: "特別枠",
  bank_name: "金融機関名",
  bank_branch: "支店名（振込先）",
  account_type: "預金の種類",
  account_no: "口座番号",
  account_holder: "口座名義",
  note: "本部の覚書",
};

/** 保存前と保存後を見比べるために、値を同じ形の文字列にそろえる。 */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return norm(a) === norm(b);
}

/** 枠の上限をひとつ読む。 */
function readLimit(
  formData: FormData,
  key: string,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const raw = text(formData, key);
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 0 || value > MAX_LIMIT) {
    return {
      ok: false,
      error: `${label}は 0〜${MAX_LIMIT} の半角数字で入力してください。`,
    };
  }
  return { ok: true, value };
}

/** 代理店の内容を書き換える。代理店コードだけは変えられない。 */
export async function updateAgencyAction(
  _prev: AgencyActionState,
  formData: FormData,
): Promise<AgencyActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const parsed = editSchema.safeParse({
    name: formData.get("name") ?? "",
    repName: formData.get("repName") ?? "",
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
    zip: formData.get("zip") ?? "",
    address: formData.get("address") ?? "",
    shopName: formData.get("shopName") ?? "",
    branchName: formData.get("branchName") ?? "",
    area: formData.get("area") ?? "",
    bankName: formData.get("bankName") ?? "",
    bankBranch: formData.get("bankBranch") ?? "",
    accountNo: formData.get("accountNo") ?? "",
    accountHolder: formData.get("accountHolder") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }
  const t = parsed.data;

  const birthday = text(formData, "birthday");
  const trainingPassedOn = text(formData, "trainingPassedOn");
  const hanbai = readLimit(formData, "limitHanbai", "販売代理店の枠");
  if (!hanbai.ok) return { error: hanbai.error };
  const salon = readLimit(formData, "limitSalon", "サロン代理店の枠");
  if (!salon.ok) return { error: salon.error };
  const kojin = readLimit(formData, "limitKojin", "個人販売パートナーの枠");
  if (!kojin.ok) return { error: kojin.error };
  const toritsugi = readLimit(formData, "limitToritsugi", "取次パートナーの枠");
  if (!toritsugi.ok) return { error: toritsugi.error };

  let current: Row | null = null;
  try {
    current = await findById(id);
  } catch (e) {
    return failed("代理店の情報を読み込めませんでした。", e);
  }
  if (!current) {
    return {
      error: "この代理店は見つかりませんでした。すでに削除されている可能性があります。",
    };
  }

  const code = s(current, "code");

  /*
   * 形の確認は「その欄を直したとき」だけにする。
   * kintone から移した古いデータには「1992-10-6」のような書き方が混じっており、
   * 触っていない欄のせいで別の修正まで保存できなくなるのを防ぐため。
   */
  if (t.email !== s(current, "email") && t.email && !EMAIL_RE.test(t.email)) {
    return { error: "メールアドレスの形が違うようです。（例）info@example.co.jp" };
  }
  if (t.zip !== s(current, "zip") && t.zip && !ZIP_RE.test(t.zip)) {
    return { error: "郵便番号は半角の数字とハイフンで入力してください。（例）812-0011" };
  }
  if (birthday !== s(current, "birthday") && birthday && !isRealDate(birthday)) {
    return {
      error: "生年月日は「2000-04-01」の形式で、実在する日付を入力してください。",
    };
  }
  if (
    trainingPassedOn !== s(current, "training_passed_on") &&
    trainingPassedOn &&
    !isRealDate(trainingPassedOn)
  ) {
    return {
      error: "研修に合格した日は「2026-08-11」の形式で、実在する日付を入力してください。",
    };
  }

  const parentCode = text(formData, "parentCode");
  const parentChanged = parentCode !== s(current, "parent_code");

  let parentName = s(current, "parent_name");
  let zeroth: string | null = null;
  if (parentCode) {
    if (parentCode === code) {
      return { error: "自分自身を上位代理店にはできません。別の代理店を選んでください。" };
    }
    let parent: Row | null = null;
    try {
      parent = await findByCode(parentCode);
      if (parent && parentChanged && (await makesLoop(code, parentCode))) {
        return {
          error:
            "その代理店は、この代理店の配下にいます。上位に選ぶと組織図が輪になってしまうため設定できません。",
        };
      }
    } catch (e) {
      return failed("上位代理店を確認できませんでした。", e);
    }
    if (!parent) {
      return {
        error: `上位代理店コード「${parentCode}」が見つかりませんでした。選び直してください。`,
      };
    }
    /*
     * 上位に選べる相手かどうかを、ここで必ず確かめる。
     * 画面の選択肢は取次パートナー・スタッフ・取次店ランク・停止解約を外しているが、
     * 送られてくる値は信用しない（選択肢を通さずに送られても止められるようにする）。
     * 付け替えたときだけ見る。移行前からの古い組み合わせのせいで、
     * 別の項目の修正まで保存できなくなるのを防ぐため。
     */
    if (parentChanged) {
      const blocked = parentBlockReason(parent);
      if (blocked) {
        return {
          error: `${blocked}。この下にはぶら下げられません（4次以降の禁止）。ひとつ上の代理店を選び直してください。`,
        };
      }
    }
    parentName = s(parent, "name");
    if (parentChanged) {
      // 上位にゼロ次が無いときは、実在が確かな総販売代理店を入れる
      // （英字をそのまま入れると、実在しない代理店を指して報酬が立たなくなる。
      //   src/lib/intake.ts と同じ扱い）
      zeroth =
        s(parent, "zeroth_code") ||
        (s(parent, "rank") === "総販売代理店" ? s(parent, "code") : ZEROTH_CODE);
    }
  } else if (parentChanged) {
    parentName = "";
  }

  const nextRank = pick(text(formData, "rank"), RANKS, s(current, "rank") || "取次店");
  const nextKind = pick(text(formData, "codeKind"), CODE_KINDS, "");

  /*
   * 取次パートナー・スタッフ・取次店の下には代理店をぶら下げられない決まりのため、
   * 配下がいるまま、この区分・ランクへ下げることはできない。
   * （下げてしまうと、画面からは直せない「4次以降」の並びができてしまう）
   * いま既にその区分・ランクの場合は素通しにする。古いデータの修正を止めないため。
   */
  const kindGoesLeaf =
    (nextKind === "01" || nextKind === "02") && nextKind !== s(current, "code_kind");
  const rankGoesLeaf = nextRank === "取次店" && nextRank !== s(current, "rank");
  if (kindGoesLeaf || rankGoesLeaf) {
    let childCount = 0;
    try {
      childCount = await countChildren(code);
    } catch (e) {
      return failed("配下の代理店を確認できませんでした。", e);
    }
    if (childCount > 0) {
      const what =
        kindGoesLeaf && rankGoesLeaf
          ? "この区分・ランク"
          : kindGoesLeaf
            ? "この区分"
            : "このランク";
      return {
        error: `配下が ${childCount} 件いるため、${what}には変更できません。先に配下の上位代理店を別の代理店へ付け替えてから、もう一度お試しください。`,
      };
    }
  }

  const patch: Record<string, unknown> = {
    name: t.name,
    rep_name: orNull(t.repName),
    rank: nextRank,
    channel: pick(text(formData, "channel"), CHANNELS, s(current, "channel") || "未設定"),
    code_kind: orNull(nextKind),
    parent_code: orNull(parentCode),
    parent_name: orNull(parentName),
    email: orNull(t.email),
    phone: orNull(t.phone),
    zip: orNull(t.zip),
    address: orNull(t.address),
    shop_name: orNull(t.shopName),
    branch_name: orNull(t.branchName),
    birthday: orNull(birthday),
    area: orNull(t.area),
    area_class: orNull(pick(text(formData, "areaClass"), AREA_CLASSES, "")),
    training_status: pick(
      text(formData, "trainingStatus"),
      TRAININGS,
      s(current, "training_status") || "未受講",
    ),
    training_passed_on: orNull(trainingPassedOn),
    sign_status: pick(
      text(formData, "signStatus"),
      SIGNS,
      s(current, "sign_status") || "未署名",
    ),
    limit_hanbai: hanbai.value,
    limit_salon: salon.value,
    limit_kojin: kojin.value,
    limit_toritsugi: toritsugi.value,
    special_slot: formData.get("specialSlot") === "on",
    bank_name: orNull(t.bankName),
    bank_branch: orNull(t.bankBranch),
    account_type: orNull(pick(text(formData, "accountType"), ACCOUNT_TYPES, "")),
    account_no: orNull(t.accountNo),
    account_holder: orNull(t.accountHolder),
    note: orNull(t.note),
  };
  if (zeroth) patch.zeroth_code = zeroth;

  const changed = Object.keys(patch)
    .filter((key) => !same(current[key], patch[key]))
    .map((key) => LABELS[key] ?? key);

  if (changed.length === 0) {
    return { ok: "変更された項目はありませんでした。内容はそのままです。" };
  }

  try {
    await update(`agencies?id=eq.${encodeURIComponent(id)}`, patch);
  } catch (e) {
    return failed("変更を保存できませんでした。", e);
  }

  /*
   * ここから、書き写した値の直し。
   * 本体の保存はもう済んでいるので、途中で失敗しても「保存できなかった」とは言わない。
   * どこまで直せたかを画面と記録の両方に残し、本部が影響の範囲を分かるようにする。
   */
  const nameChanged = !same(current["name"], t.name);
  const zerothChanged = Boolean(zeroth) && !same(current["zeroth_code"], zeroth);

  const notes: string[] = [];
  const troubles: string[] = [];
  let renamed = 0;
  let retagged = 0;

  if (nameChanged) {
    try {
      renamed = await renameParentLabel(code, t.name);
      if (renamed > 0) {
        notes.push(`直下 ${renamed} 件の「上位」の表示も新しい名前に直しました。`);
      }
    } catch {
      troubles.push(
        "配下の一覧に出る「上位」の名前が古いままになっています。もう一度この画面から保存し直してください。",
      );
    }
  }

  if (zerothChanged && zeroth) {
    try {
      const family = await listDescendants(code);
      const codes = family.map((a) => a.code).filter(Boolean);
      if (codes.length > 0) {
        retagged = await retagZeroth(codes, zeroth);
        notes.push(
          `配下・孫あわせて ${retagged} 件のゼロ次代理店も ${zeroth} に付け替えました。`,
        );
      }
    } catch {
      troubles.push(
        "配下・孫のゼロ次代理店が元の組織のままになっています。このままだと新しい受注が古い組織で集計されるため、もう一度この画面から保存し直すか、開発担当にご連絡ください。",
      );
    }
  }

  await audit("HQ", "代理店情報の更新", { type: "agency", key: code }, {
    代理店: t.name,
    変更した項目: changed.join("、"),
    上位表示を直した配下: nameChanged ? `${renamed}件` : "なし",
    ゼロ次を付け替えた配下: zerothChanged ? `${retagged}件（${zeroth}）` : "なし",
    連鎖の直しで起きた不具合: troubles.length > 0 ? troubles.join(" / ") : "なし",
  });

  refresh(code);

  const head = `${t.name}（${code}）の内容を保存しました。直したのは「${changed.join("」「")}」です。`;
  if (troubles.length > 0) {
    return { ok: [head, ...notes].join(" "), error: troubles.join(" ") };
  }
  return { ok: [head, ...notes].join(" ") };
}

/* ═══════════════ 承認したときの案内メール ═══════════════ */

/*
 * 本部が「稼働中」にした（＝承認した）ときに、その代理店へ案内メールを送る。
 *
 * 文面はコード区分と販路種別の2つで選ぶ。会社に個人向けのQR案内を送ってしまう
 * 取り違えを起こさないため、選び分けはこの一か所だけで行う
 * （2026-08-07 会議の指摘 #2）。
 *
 * コード区分だけでは足りない。個人販売パートナー（税理士・保険の方など、
 * ご自身でお客様に販売する個人事業主）は、申込フォーム経由でも手で登録しても
 * コード区分が会社と同じ 00 になるため、区分だけを見ると会社と見分けがつかない。
 * 見分けられるのは販路種別だけなので、そちらもあわせて見る。
 *
 * メールが送れなくても承認そのものは取り消さない。
 * 届いていないことを画面と記録の両方に残し、本部が次の手を打てるようにする。
 */

/** 案内メールを送ろうとした結果。呼び出し側が画面の文面を組み立てるのに使う。 */
type GuideMail =
  /** 送れた。recorded が false のときは送信日時を残せていない。 */
  | { kind: "sent"; to: string; recorded: boolean }
  /** すでに送ってあるので送らなかった。at は前回送った日時。 */
  | { kind: "already"; at: string }
  /** メールアドレスが未登録で送れなかった。 */
  | { kind: "noEmail" }
  /** 送信そのものに失敗した。 */
  | { kind: "failed"; reason: string };

/** ご本人が個人でお客様に販売する販路種別。会社あての文面を送ってはいけない相手。 */
const PERSONAL_CHANNEL = "個人販売パートナー";

/** 案内メールの送り方。文面の種類・記録に残す言い方・QRを載せてよいかの3つ。 */
type MailPlan = {
  /** どの文面を使うか。 */
  kind: "会社" | "スタッフ" | "取次パートナー";
  /** 操作の記録に残す言い方。誰あてに送ったのかを後から辿れるようにする。 */
  label: string;
  /** ご本人が使う個別のQR（QR1／QR2）を載せてよい相手か。 */
  withQr: boolean;
};

/**
 * コード区分と販路種別から、どの文面で送るかを決める。
 *
 *   取次パートナー（区分01）… 紹介だけの相手。個別のQRは出さず、
 *                             共通の公式LINEとご紹介フォームをご案内する。
 *   スタッフ（区分02）      … 代理店に所属する個人。ご本人がお客様にQRをお見せする。
 *   個人販売パートナー      … コード区分は会社と同じ 00 だが、実際に販売するのは
 *                             ご本人。会社あての「御中」も、「QRは販売ライセンスを
 *                             お持ちのスタッフの方それぞれにお渡しします」という
 *                             案内も当てはまらないので、個人あての文面で送る。
 *   会社（区分00）          … 「御中」の文面。QRは載せない
 *                             （お客様にお見せするQRは、販売する個人にお渡しするもの）。
 */
function mailPlanOf(codeKind: string, channel: string): MailPlan {
  if (codeKind === "01") {
    return { kind: "取次パートナー", label: "取次パートナー", withQr: false };
  }
  if (codeKind === "02") {
    return { kind: "スタッフ", label: "スタッフ", withQr: true };
  }
  if (channel === PERSONAL_CHANNEL) {
    // 文面はスタッフと同じ（「様」＋ご本人のQR）だが、記録には販路種別のまま残す。
    return { kind: "スタッフ", label: "個人販売パートナー", withQr: true };
  }
  // 区分が入っていない古いデータは会社あつかい。
  // 会社の文面にはQRが入らないので、取り違えても個人向けのQRは送られない。
  return { kind: "会社", label: "会社", withQr: false };
}

/** 日時を画面に出せる形にする。読めない値はそのまま返す。 */
function jpStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * 案内メールを1通送る。
 *
 * resend が false のときは、すでに送ってある相手には送らない（二重送信の防止）。
 * 送れたら送信日時（guide_mailed_at）を残す。
 */
async function sendGuideMail(
  row: Row,
  opts: { resend: boolean },
): Promise<GuideMail> {
  const code = s(row, "code");
  // コードが読めない行に送ると、送信日時の書き戻し先も決められない
  if (!code) {
    return { kind: "failed", reason: "代理店コードを読み取れませんでした。" };
  }
  const label = s(row, "name") || code;
  const to = s(row, "email");
  if (!to) return { kind: "noEmail" };

  const already = s(row, "guide_mailed_at");
  if (already && !opts.resend) return { kind: "already", at: already };

  const plan = mailPlanOf(s(row, "code_kind"), s(row, "channel"));
  const isToss = plan.kind === "取次パートナー";
  const mail = approvalMail({
    name: label,
    code,
    kind: plan.kind,
    portalUrl: PORTAL_URL,
    // パスワードの値は渡さない。発行済みかどうかだけを伝える。
    passwordIssued: Boolean(s(row, "portal_password")),
    // ご本人が使う個別のQRは、その相手にだけ載せる（発行済みのときだけ）。
    // 取次パートナーには出さない。共通の公式LINEとご紹介フォームだけ。
    qr1Url: plan.withQr ? s(row, "qr1_url") || undefined : undefined,
    qr2Url: plan.withQr ? s(row, "qr2_url") || undefined : undefined,
    lineQrUrl: isToss ? OFFICIAL_LINE_URL : undefined,
    tossFormUrl: isToss ? tossUpUrl(code) || undefined : undefined,
  });

  const sent = await sendMail(to, mail.subject, mail.body);
  const common = {
    代理店: label,
    宛先: to,
    文面: plan.label,
    再送: opts.resend ? "はい" : "いいえ",
  };

  if (!sent.ok) {
    await audit("HQ", "承認メール送信失敗", { type: "agency", key: code }, {
      ...common,
      理由: sent.error,
    });
    return { kind: "failed", reason: sent.error };
  }

  /*
   * 送信日時を残す。ここが失敗しても「送れた」ことは変わらないので、
   * メールを送り直したりはしない。次に承認の操作をすると
   * 同じ案内がもう一通届きうるため、その旨を記録と画面に残す。
   */
  let recorded = true;
  try {
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      guide_mailed_at: new Date().toISOString(),
    });
  } catch {
    recorded = false;
  }

  await audit("HQ", "承認メール送信", { type: "agency", key: code }, {
    ...common,
    送信日時の記録: recorded ? "残しました" : "残せませんでした",
    前回の送信: already ? jpStamp(already) : "なし",
  });

  return { kind: "sent", to, recorded };
}

/**
 * 案内メールが送れなかったときに、本部へ出す言葉。
 *
 * 送り直す操作は、まだどの画面にも出していない（下の resendGuideMailAction を参照）。
 * 押せないボタンの名前を出すと本部が探し回ることになるため、
 * いまは「本部から直接ご連絡ください」までにとどめる。
 */
const NO_EMAIL_NOTE =
  "メールアドレスが未登録のため案内を送れませんでした。「内容を直す」欄にメールアドレスを登録したうえで、ポータルのご案内は本部から直接ご連絡ください。";

/* ═══════════════ 稼働状況の切り替え（＝承認の操作） ═══════════════ */

/**
 * 稼働状況を切り替える。
 *
 * 「稼働中」にすることが、本部がこの代理店を承認したという意味になる。
 * 誰がいつ承認・停止したかを必ず記録に残す。
 * 停止・解約にするときは理由を必ず受け取り、日時とあわせて保存する。
 *
 * 稼働中にしたときは、その代理店へ案内メールを送る（相手ごとに文面を変える）。
 * メールが送れなくても承認は取り消さない。届いていないことを正直に画面へ出す。
 */
export async function changeStatusAction(
  _prev: AgencyActionState,
  formData: FormData,
): Promise<AgencyActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const next = pick(text(formData, "status"), STATUSES, "");
  if (!next) {
    return { error: "変更後の状態（未稼働・稼働中・停止・解約）を選んでください。" };
  }

  const reason = text(formData, "reason");
  if (next === "停止・解約") {
    if (!reason) {
      return {
        error:
          "停止・解約にする理由を入力してください。後から経緯をたどれるよう、記録に残します。",
      };
    }
    if (reason.length > 500) {
      return { error: "理由は500文字以内で入力してください。" };
    }
  }

  let current: Row | null = null;
  try {
    current = await findById(id);
  } catch (e) {
    return failed("代理店の情報を読み込めませんでした。", e);
  }
  if (!current) {
    return {
      error: "この代理店は見つかりませんでした。すでに削除されている可能性があります。",
    };
  }

  const code = s(current, "code");
  const label = s(current, "name") || code;
  const before = s(current, "status");
  if (before === next) {
    return { error: `${label} はすでに「${before}」です。変更の必要はありません。` };
  }

  const patch: Record<string, unknown> =
    next === "停止・解約"
      ? {
          status: next,
          suspended_at: new Date().toISOString(),
          suspended_reason: reason,
        }
      : {
          status: next,
          // 停止から戻すときは、停止の記載を消してしまう（経緯は操作の記録に残る）
          suspended_at: null,
          suspended_reason: null,
        };

  try {
    await update(`agencies?id=eq.${encodeURIComponent(id)}`, patch);
  } catch (e) {
    return failed("状態を変更できませんでした。", e);
  }

  await audit("HQ", "稼働状況の変更", { type: "agency", key: code }, {
    代理店: label,
    変更前: before,
    変更後: next,
    理由: reason || (next === "停止・解約" ? "" : "（停止の解除）"),
    元の停止理由: s(current, "suspended_reason") || "",
  });

  /*
   * 承認（稼働中）のときだけ案内メールを送る。
   * ここから先で何が起きても、稼働中になった事実は取り消さない。
   */
  const guide =
    next === "稼働中" ? await sendGuideMail(current, { resend: false }) : null;

  refresh(code);

  if (next === "稼働中") {
    const head = `${label}（${code}）を稼働中にしました。承認済みの取引先として一覧に出ます。`;
    const loginNote = s(current, "portal_password")
      ? ""
      : "ログイン用のパスワードはまだ発行されていません。代理店管理の一覧の下にある発行欄から出して、ご本人へお伝えください。";

    if (guide?.kind === "sent") {
      const twice = guide.recorded
        ? ""
        : "ただし送った日時を記録できませんでした。もう一度この操作をすると、同じ案内がもう一通届くことがあります。";
      return {
        ok: `${head}ご登録のメールアドレス（${guide.to}）へ案内メールをお送りしました。${twice}${loginNote}`,
      };
    }
    if (guide?.kind === "already") {
      return {
        ok: `${head}案内メールは ${jpStamp(guide.at)} にお送りしているため、今回は送っていません。届いていないとご連絡があった場合は、本部から直接ご連絡ください。${loginNote}`,
      };
    }
    if (guide?.kind === "failed") {
      return {
        ok: `${head}${loginNote}`,
        error: `承認しましたが案内メールは届いていません。（${guide.reason}）お手数ですが、ポータルのご案内は本部から直接ご連絡ください。`,
      };
    }
    // 残るのはメールアドレスが未登録のときだけ
    return { ok: `${head}${loginNote}`, error: NO_EMAIL_NOTE };
  }
  if (next === "停止・解約") {
    return {
      ok: `${label}（${code}）を停止・解約にしました。この代理店はポータルにログインできなくなります。理由と日時は記録に残しました。`,
    };
  }
  return {
    ok: `${label}（${code}）を未稼働に戻しました。ポータルには入れますが、本部の確認前の扱いになります。`,
  };
}

/* ═══════════════ 案内メールの再送 ═══════════════ */

/** 代理店コードの形。画面から来た値をそのまま検索条件に使わないため。 */
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * 案内メールをもう一度送る。
 *
 * 「届いていない」とご連絡があったとき、メールアドレスを直したとき、
 * ログイン情報を発行し直したときに使う。すでに稼働中の代理店だけが対象。
 * 稼働状況は何も変えない（承認の操作とは切り離す）。
 *
 * 二重送信の防止は効かせない。送り直すための操作だから。
 * 送るたびに記録に残るので、何通送ったかは後から辿れる。
 *
 * ⚠️ この処理は、まだどの画面からも呼ばれていない（配線待ち）。
 * 代理店の詳細画面（/admin/agencies/[code]）の「稼働状況の切り替え」の下に、
 * この処理を呼ぶ送り直しの欄（id を隠し項目で渡し、確認を挟むボタン）を足す想定。
 * 画面に出したら、承認したときの案内文（上）とメール未登録のときの案内文を
 * 「案内メールを再送する」でお送りください、という言い方に戻すこと。
 * それまでは、押せないボタンの名前を本部に案内しないようにしてある。
 */
export async function resendGuideMailAction(
  _prev: AgencyActionState,
  formData: FormData,
): Promise<AgencyActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  // 画面によって id で渡すところと、代理店コードで渡すところがある
  const id = readId(formData);
  const code = text(formData, "code");
  if (!id && !CODE_RE.test(code)) {
    return {
      error: "対象の代理店を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  let current: Row | null = null;
  try {
    current = id ? await findById(id) : await findByCode(code);
  } catch (e) {
    return failed("代理店の情報を読み込めませんでした。", e);
  }
  if (!current) {
    return {
      error: "この代理店は見つかりませんでした。すでに削除されている可能性があります。",
    };
  }

  const label = s(current, "name") || s(current, "code");
  const status = s(current, "status");
  if (status !== "稼働中") {
    return {
      error:
        status === "停止・解約"
          ? `${label} は停止・解約のため、案内メールは送れません。取引を再開する場合は、先に稼働中に戻してください。`
          : `${label} はまだ稼働中ではありません。上の欄で「稼働中」に切り替えると、そのときに案内メールをお送りします。`,
    };
  }

  const guide = await sendGuideMail(current, { resend: true });

  refresh(s(current, "code"));

  if (guide.kind === "noEmail") return { error: NO_EMAIL_NOTE };
  if (guide.kind === "failed") {
    return {
      error: `案内メールを送れませんでした。（${guide.reason}）時間をおいてもう一度お試しいただくか、本部から直接ご連絡ください。`,
    };
  }
  if (guide.kind === "already") {
    // 再送では通らない道だが、扱いを決めておく
    return { ok: `${label} には ${jpStamp(guide.at)} に案内メールをお送りしています。` };
  }

  const twice = guide.recorded
    ? ""
    : "ただし送った日時を記録できませんでした。次に承認の操作をすると、同じ案内がもう一通届くことがあります。";
  return {
    ok: `${label} のご登録のメールアドレス（${guide.to}）へ案内メールをもう一度お送りしました。${twice}`,
    at: Date.now(),
  };
}

/* ═══════════════ 本部が手で新規登録する ═══════════════ */

/**
 * 枠の空きを確かめた結果。
 * over には「上限を超えたが特別枠なので通した」ときの言葉が入る（記録に残すため）。
 */
type SlotRoom =
  | { ok: true; over: string | null }
  | { ok: false; error: string };

/**
 * 上位代理店に、この相手を入れる空きがあるか確かめる。
 *
 * 数え方は代理店の詳細画面に出ている枠と必ず同じにする（同じ関数を使う）。
 *   ・統括代理店（2次代理店）の配下 … 販路種別ごとの枠。合計100（10/30/30/30）
 *   ・総販売代理店の配下           … 統括代理店のエリア枠。全国60社
 * スタッフ（区分02）は代理店ではないので枠を使わない。
 *
 * 上限に達しているときは登録を止める。本部がどうしても入れる必要があるときは、
 * 上位を「特別枠」に切り替えてもらう。そのときは超えた事実を記録に残す。
 * 空きを数えられなかったときも登録は止める（黙って上限を破らないため）。
 */
async function checkSlotRoom(opts: {
  parentCode: string;
  parentLabel: string;
  kind: string;
  rank: string;
  channel: string;
  areaClass: string;
}): Promise<SlotRoom> {
  if (opts.kind === "02") return { ok: true, over: null };

  let all: Agency[] = [];
  try {
    all = await listAllAgencies();
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `枠の空きを確認できなかったため、登録を中止しました。${e.message}`
          : "枠の空きを確認できなかったため、登録を中止しました。時間をおいてもう一度お試しください。",
    };
  }

  const parent = all.find((a) => a.code === opts.parentCode);
  if (!parent) {
    return {
      ok: false,
      error:
        "上位代理店の枠を読み込めませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const model = slotModelOf(parent);
  if (model === "none") return { ok: true, over: null };

  const special = parent.specialSlot;

  /* ── 総販売代理店の配下に統括代理店を作るとき：全国60社のエリア枠 ── */
  if (model === "area") {
    if (opts.rank !== "2次代理店") return { ok: true, over: null };

    // エリア区分「本部」は、もともと全国60社の数に入れない決まり（既存5社の扱い）
    if (opts.areaClass === "本部") return { ok: true, over: null };

    const usage = areaUsage(all);
    const room = usage.rows.find((r) => r.area === opts.areaClass);
    if (!room) {
      // エリアが決まっていないと、どのエリアの枠を使うのか数えられない。
      // 空欄のまま通すと、全国60社の決まりを素通りできてしまう。
      return {
        ok: false,
        error:
          "統括代理店を登録するときは、エリア区分（関東・九州+沖縄など）を選んでください。エリアごとの上限（全国60社）を数えられません。",
      };
    }

    const relief = `全国60社は契約上の決まりのため、上限そのものは画面から変えられません。どうしても登録する場合は、${opts.parentLabel} の「内容を直す」欄で特別枠に切り替えてから、もう一度お試しください。超えて登録したことは操作の記録に残ります。`;

    if (room.isFull) {
      if (!special) {
        return {
          ok: false,
          error: `${opts.areaClass} の統括代理店は上限 ${room.limit} 社に達しています（いま ${room.used} 社）。${relief}`,
        };
      }
      return {
        ok: true,
        over: `${opts.areaClass} の統括代理店の枠（上限 ${room.limit} 社）はすでにいっぱいですが、特別枠のため登録しました`,
      };
    }
    if (usage.total.remaining <= 0) {
      if (!special) {
        return {
          ok: false,
          error: `統括代理店は全国で上限 ${usage.total.limit} 社に達しています（いま ${usage.total.used} 社）。${relief}`,
        };
      }
      return {
        ok: true,
        over: `全国の統括代理店の枠（上限 ${usage.total.limit} 社）はすでにいっぱいですが、特別枠のため登録しました`,
      };
    }
    return { ok: true, over: null };
  }

  /* ── 統括代理店の配下：販路種別ごとの枠（合計100） ── */
  const children = all.filter(
    (a) => a.parentCode === opts.parentCode && a.code !== opts.parentCode,
  );
  const breakdown = breakdownSlots(parent, children, slotLimitsOf(parent));
  const relief = `続けて登録する場合は、${opts.parentLabel} の「内容を直す」欄で枠の上限を引き上げるか、特別枠に切り替えてから、もう一度お試しください。特別枠で超えて登録したことは操作の記録に残ります。`;

  const line = breakdown.lines.find((l) => l.key === opts.channel);
  if (line && line.isFull) {
    if (!special) {
      return {
        ok: false,
        error: `${opts.parentLabel} の「${line.label}」の枠は上限 ${line.limit} 件に達しています（いま ${line.used} 件）。${relief}`,
      };
    }
    return {
      ok: true,
      over: `${opts.parentLabel} の「${line.label}」の枠（上限 ${line.limit} 件）はすでにいっぱいですが、特別枠のため登録しました`,
    };
  }

  // 販路種別が「未設定」の配下も実在する代理店なので、合計の枠は消費している。
  if (breakdown.totalUsed >= breakdown.totalLimit) {
    if (!special) {
      return {
        ok: false,
        error: `${opts.parentLabel} の配下は合計の上限 ${breakdown.totalLimit} 件に達しています（いま ${breakdown.totalUsed} 件）。${relief}`,
      };
    }
    return {
      ok: true,
      over: `${opts.parentLabel} の配下の合計枠（上限 ${breakdown.totalLimit} 件）はすでにいっぱいですが、特別枠のため登録しました`,
    };
  }

  return { ok: true, over: null };
}

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "法人名（またはお名前）を入力してください。")
    .max(120, "法人名は120文字以内で入力してください。"),
  repName: z.string().trim().max(60, "代表者名は60文字以内で入力してください。"),
  email: z.string().trim().max(200, "メールアドレスは200文字以内で入力してください。"),
  phone: z.string().trim().max(30, "電話番号は30文字以内で入力してください。"),
  note: z.string().trim().max(2000, "本部の覚書は2000文字以内で入力してください。"),
});

/**
 * 電話やFAXで届いた申込を、本部が手で登録する。
 *
 * 代理店コードは「組織の英字＋4桁の通し番号」で自動採番する（申込フォーム経由と同じ決まり）。
 * 登録した時点では「未稼働」。内容を確かめてから稼働中に切り替える運用は変えない。
 */
export async function createAgencyAction(
  _prev: AgencyActionState,
  formData: FormData,
): Promise<AgencyActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const parentCode = text(formData, "parentCode");
  if (!parentCode) {
    return { error: "どの代理店の配下として登録するかを指定してください。" };
  }

  const kind = pick(text(formData, "codeKind"), CODE_KINDS, "");
  if (!kind) {
    return {
      error: "コード区分（00＝会社 / 01＝取次パートナー / 02＝スタッフ）を選んでください。",
    };
  }

  const parsed = createSchema.safeParse({
    name: formData.get("name") ?? "",
    repName: formData.get("repName") ?? "",
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }
  const t = parsed.data;
  if (t.email && !EMAIL_RE.test(t.email)) {
    return { error: "メールアドレスの形が違うようです。（例）info@example.co.jp" };
  }

  let parent: Row | null = null;
  try {
    parent = await findByCode(parentCode);
  } catch (e) {
    return failed("上位代理店を確認できませんでした。", e);
  }
  if (!parent) {
    return {
      error: `上位代理店コード「${parentCode}」が見つかりませんでした。画面を読み込み直してからお試しください。`,
    };
  }

  const parentLabel = s(parent, "name") || parentCode;
  // 停止・解約の代理店は、もう配下を増やせない（取引そのものが止まっているため）
  if (s(parent, "status") === "停止・解約") {
    return {
      error: `${parentLabel} は停止・解約のため、この下に新しく登録できません。取引を再開する場合は、先に「稼働状況の切り替え」で稼働中に戻してからお試しください。`,
    };
  }
  // 上位に選べる相手かどうかは、内容の修正と同じ判定を使う（判断がずれないようにするため）
  const blocked = parentBlockReason(parent);
  if (blocked) {
    return {
      error: `${blocked}。この下には登録できません（4次以降の禁止）。ひとつ上の代理店の画面から登録してください。`,
    };
  }

  const rank = pick(
    text(formData, "rank"),
    RANKS,
    kind === "00" ? "2次代理店" : "取次店",
  );
  const channel = pick(
    text(formData, "channel"),
    CHANNELS,
    kind === "01" ? "サロン提携パートナー（取次）" : "未設定",
  );
  const areaClass = pick(text(formData, "areaClass"), AREA_CLASSES, "");

  /*
   * 枠の確認。本部の操作でも、契約で決めた上限は黙って超えられないようにする。
   * 申込フォーム経由と同じ判定を通したうえで、
   * 画面に出ている枠（販路種別ごと・エリアごと）でもう一度数え直す。
   */
  let allowed: { ok: true } | { ok: false; reason: string };
  try {
    allowed = await canRegisterUnder(parent, kind, channel);
  } catch (e) {
    return failed("枠の空きを確認できなかったため、登録を中止しました。", e);
  }
  if (!allowed.ok) {
    return {
      error: `${allowed.reason}続けて登録する場合は、${parentLabel} の「内容を直す」欄で枠の上限を引き上げるか、特別枠に切り替えてから、もう一度お試しください。`,
    };
  }

  const room = await checkSlotRoom({
    parentCode,
    parentLabel,
    kind,
    rank,
    channel,
    areaClass,
  });
  if (!room.ok) return { error: room.error };

  /*
   * 手動登録は上位の組織をそのまま引き継ぐ（英字＋4桁で採番）。
   * 新しい組織を作るときは、代理店の詳細画面から自社コードを設定する。
   */
  const orgCode = orgOf(parent);
  let code: string | null = null;
  try {
    code = await nextAgencyCode(orgCode);
  } catch (e) {
    return failed("代理店コードを採番できませんでした。", e);
  }
  if (!code) {
    return {
      error: `${orgCode} で始まる代理店コードが9999番まで埋まっています。採番の決まりを見直す必要があるため、開発担当にご連絡ください。`,
    };
  }

  try {
    await insert("agencies", [
      {
        code,
        name: t.name,
        rep_name: orNull(t.repName),
        rank,
        channel,
        code_kind: kind,
        // 列を足す SQL を流す前でも登録できるようにする（lib/intake.ts の説明を参照）
        ...((await hasOrgCodeColumn()) ? { org_code: orgCode } : {}),
        branch_no: Number(code.slice(orgCode.length)) || null,
        parent_code: parentCode,
        parent_name: s(parent, "name"),
        // 上位にゼロ次が無いときは、実在が確かな総販売代理店を入れる（理由は intake.ts と同じ）
        zeroth_code:
          s(parent, "zeroth_code") ||
          (s(parent, "rank") === "総販売代理店" ? s(parent, "code") : ZEROTH_CODE),
        area_class: orNull(areaClass),
        status: "未稼働",
        email: orNull(t.email),
        phone: orNull(t.phone),
        registered_via: "手動登録",
        applied_at: new Date().toISOString(),
        note: orNull(t.note),
      },
    ]);
  } catch (e) {
    return failed("登録できませんでした。", e);
  }

  await audit("HQ", "代理店の手動登録", { type: "agency", key: code }, {
    代理店: t.name,
    上位: parentCode,
    コード区分: kind,
    ランク: rank,
    販路種別: channel,
    // 特別枠で上限を超えて入れた場合は、その事実を必ず残す
    ...(room.over ? { 枠の超過: room.over } : {}),
  });

  refresh(parentCode);
  revalidatePath(`/admin/agencies/${code}`);

  return {
    ok:
      `${t.name} を ${code} として、${parentLabel} の配下に登録しました。いまは未稼働です。内容を確かめてから稼働中に切り替えてください。` +
      (room.over ? `なお、${room.over}。超えたことは操作の記録に残しました。` : ""),
    at: Date.now(),
  };
}
