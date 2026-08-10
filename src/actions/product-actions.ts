"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, insert, selectOne, update } from "@/lib/db";

/**
 * 商品マスタ（販売単価とランク別の報酬額）の登録・修正。本部だけが使う。
 *
 * 商品は消さない。受注は「商品名」で商品マスタを引いて報酬額を出しているため、
 * 消してしまうと過去の受注の金額の根拠がたどれなくなる。
 * 使わなくなった商品は取扱を止めて（active を false にして）一覧の下にまとめる。
 *
 * 商品名は受注との突き合わせに使う唯一の手がかりなので、同じ名前を2つ作らせない。
 */

/** 画面に渡す商品1件ぶんの形。金額の「空欄」と「0円」は意味が違うので null と 0 を分ける。 */
export type Product = {
  id: string;
  name: string;
  /** 販売単価（税込・円）。 */
  price: number | null;
  /** 報酬の対象か。対象外の商品は売れても報酬が立たない。 */
  rewardTarget: boolean;
  /** 総販売代理店に払う1台あたりの報酬額。null は未設定。 */
  amountSo: number | null;
  /** 2次代理店ぶん。 */
  amountNiji: number | null;
  /** 販売代理店ぶん。 */
  amountHanbai: number | null;
  /** 取次店ぶん。 */
  amountToritsugi: number | null;
  /** 10台ボーナスの集計対象か。 */
  bonus10: boolean;
  points: number;
  /** 一覧の並び順。小さいものが上。 */
  sortOrder: number;
  /** 取扱中か。false なら取扱を止めた商品。 */
  active: boolean;
};

export type ProductFormState = {
  error?: string;
  ok?: string;
  /** 追加が成功したときだけ変わる。画面側はこれを合図に入力欄を空に戻す。 */
  savedAt?: number;
};

const NAME_MAX = 200;
/** 打ち間違いを止めるための上限。VIS本体でも 185,000 円なので、これで足りる。 */
const MAX_YEN = 9_999_999;
const MAX_POINTS = 100_000;
const MAX_SORT = 9_999;

/**
 * 本部以外は一切書き換えできない。
 * フォームから id を受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer) {
    return "ログインの有効期限が切れています。もう一度ログインしてからお試しください。";
  }
  if (viewer.kind !== "hq") return "この操作は本部のアカウントからのみ行えます。";
  return null;
}

/** 操作の記録に残す名前。 */
async function actorLabel(): Promise<string> {
  const viewer = await currentViewer();
  return viewer && viewer.kind === "hq" ? viewer.label || "本部" : "本部";
}

type Row = Record<string, unknown>;

function str(r: Row, k: string): string {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

/* ---------- 入力の読み取り ---------- */

type ProductInput = {
  name: string;
  price: number | null;
  rewardTarget: boolean;
  amountSo: number | null;
  amountNiji: number | null;
  amountHanbai: number | null;
  amountToritsugi: number | null;
  bonus10: boolean;
  points: number | null;
  sortOrder: number | null;
};

type NumParsed = { ok: true; value: number | null } | { ok: false; error: string };

/** 全角の数字・カンマ・「円」記号を取り除いて、素の数字だけにする。 */
function normalizeDigits(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,\s￥¥円]/g, "");
}

/** 金額・個数の欄をひとつ読む。空欄は「未設定」として null を返す。 */
function readNumber(
  formData: FormData,
  key: string,
  opts: { label: string; max: number; unit?: string; required?: boolean },
): NumParsed {
  const unit = opts.unit ?? "円";
  const raw = normalizeDigits(String(formData.get(key) ?? "").trim());

  if (!raw) {
    if (opts.required) return { ok: false, error: `${opts.label}を入力してください。` };
    return { ok: true, value: null };
  }
  if (raw.startsWith("-")) {
    return {
      ok: false,
      error: `${opts.label}にマイナスの数字は入れられません。0 以上で入力してください。`,
    };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      error: `${opts.label}は半角の数字だけで入力してください。小数点や記号は使えません。`,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > opts.max) {
    return {
      ok: false,
      error: `${opts.label}は ${opts.max.toLocaleString("ja-JP")}${unit} までで入力してください。桁を間違えていないかご確認ください。`,
    };
  }
  return { ok: true, value };
}

type Parsed = { ok: true; value: ProductInput } | { ok: false; error: string };

function parse(formData: FormData): Parsed {
  // 受注の商品名とそのまま突き合わせるため、前後の空白を取る以外は手を加えない。
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return {
      ok: false,
      error: "商品名を入力してください。受注に記録される商品名と同じ表記にしてください。",
    };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: `商品名は${NAME_MAX}文字以内で入力してください。` };
  }

  const price = readNumber(formData, "price", {
    label: "販売単価",
    max: MAX_YEN,
    required: true,
  });
  if (!price.ok) return { ok: false, error: price.error };

  const so = readNumber(formData, "amountSo", { label: "総販売代理店の報酬額", max: MAX_YEN });
  if (!so.ok) return { ok: false, error: so.error };

  const niji = readNumber(formData, "amountNiji", { label: "2次代理店の報酬額", max: MAX_YEN });
  if (!niji.ok) return { ok: false, error: niji.error };

  const hanbai = readNumber(formData, "amountHanbai", {
    label: "販売代理店の報酬額",
    max: MAX_YEN,
  });
  if (!hanbai.ok) return { ok: false, error: hanbai.error };

  const toritsugi = readNumber(formData, "amountToritsugi", {
    label: "取次店の報酬額",
    max: MAX_YEN,
  });
  if (!toritsugi.ok) return { ok: false, error: toritsugi.error };

  const points = readNumber(formData, "points", {
    label: "ポイント",
    max: MAX_POINTS,
    unit: "ポイント",
  });
  if (!points.ok) return { ok: false, error: points.error };

  const sortOrder = readNumber(formData, "sortOrder", {
    label: "並び順",
    max: MAX_SORT,
    unit: "",
  });
  if (!sortOrder.ok) return { ok: false, error: sortOrder.error };

  return {
    ok: true,
    value: {
      name,
      price: price.value,
      rewardTarget: formData.get("rewardTarget") === "on",
      amountSo: so.value,
      amountNiji: niji.value,
      amountHanbai: hanbai.value,
      amountToritsugi: toritsugi.value,
      bonus10: formData.get("bonus10") === "on",
      points: points.value,
      sortOrder: sortOrder.value,
    },
  };
}

/* ---------- 保存の共通処理 ---------- */

function toPayload(input: ProductInput, extra: Record<string, unknown> = {}) {
  return {
    name: input.name,
    price_incl_tax: input.price,
    reward_target: input.rewardTarget ? "対象" : "対象外",
    amount_so: input.amountSo,
    amount_niji: input.amountNiji,
    amount_hanbai: input.amountHanbai,
    amount_toritsugi: input.amountToritsugi,
    bonus_10: input.bonus10 ? "対象" : "対象外",
    points: input.points ?? 0,
    sort_order: input.sortOrder ?? 0,
    ...extra,
  };
}

/** 操作の記録に残す中身（あとから金額の変遷を追えるように日本語で残す）。 */
function logOf(input: ProductInput) {
  return {
    商品名: input.name,
    販売単価: input.price,
    報酬対象: input.rewardTarget ? "対象" : "対象外",
    総販売代理店: input.amountSo,
    "2次代理店": input.amountNiji,
    販売代理店: input.amountHanbai,
    取次店: input.amountToritsugi,
    "10台ボーナス": input.bonus10 ? "対象" : "対象外",
    ポイント: input.points ?? 0,
    並び順: input.sortOrder ?? 0,
  };
}

function logOfRow(row: Row) {
  return {
    商品名: str(row, "name"),
    販売単価: row["price_incl_tax"] ?? null,
    報酬対象: str(row, "reward_target"),
    総販売代理店: row["amount_so"] ?? null,
    "2次代理店": row["amount_niji"] ?? null,
    販売代理店: row["amount_hanbai"] ?? null,
    取次店: row["amount_toritsugi"] ?? null,
    "10台ボーナス": str(row, "bonus_10"),
    ポイント: row["points"] ?? null,
    並び順: row["sort_order"] ?? null,
    取扱: row["active"] === false ? "停止中" : "取扱中",
  };
}

/** 画面の値をそのまま絞り込みに使わない。数字だけの id か確かめる。 */
function readId(formData: FormData): string | null {
  const id = String(formData.get("id") ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * 同じ商品名がすでにあるか調べる。except を渡すと、その商品自身は除いて探す。
 *
 * 商品名には全角スペースや「185,000円」のようなカンマが入る。
 * 値をそのまま繋ぐと条件が途中で切れてしまうので、必ず符号化してから渡す
 * （カンマは %2C になり、名前の一部として扱われる）。
 */
async function findByName(name: string, except?: string): Promise<Row | null> {
  const filter = `name=eq.${encodeURIComponent(name)}`;
  const exclude = except ? `&id=neq.${except}` : "";
  return selectOne<Row>(`products?select=id,name,active&${filter}${exclude}`);
}

async function loadProduct(id: string): Promise<Row | null> {
  return selectOne<Row>(`products?select=*&id=eq.${id}`);
}

function failed(prefix: string, e: unknown): ProductFormState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいてもう一度お試しください。`,
  };
}

const NOT_FOUND =
  "対象の商品が見つかりませんでした。ほかの担当者が先に直した可能性があります。画面を読み込み直してご確認ください。";

/** 保存したら、商品の一覧と、単価を参照している受注一覧の両方を出し直す。 */
function refresh() {
  revalidatePath("/admin/products");
  revalidatePath("/admin/orders");
}

/* ---------- 新しい商品を追加する ---------- */

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const parsed = parse(formData);
  if (!parsed.ok) return { error: parsed.error };
  const input = parsed.value;

  try {
    const same = await findByName(input.name);
    if (same) {
      return {
        error:
          same["active"] === false
            ? `「${input.name}」は以前に登録され、いまは取扱を止めています。同じ商品名は2つ登録できないため、下の「取扱を止めた商品」から取扱を再開してください。`
            : `「${input.name}」はすでに登録されています。金額を変えるときは、一覧のその商品の「内容を直す」からお願いします。`,
      };
    }

    const rows = await insert<Row>("products", [toPayload(input, { active: true })]);
    const saved = rows[0];
    if (!saved) {
      return {
        error:
          "登録はできたようですが、保存された内容を確認できませんでした。一覧を読み込み直してご確認ください。",
      };
    }
    await audit(
      await actorLabel(),
      "商品の追加",
      { type: "product", key: str(saved, "id") },
      logOf(input),
    );
  } catch (e) {
    return failed("商品を追加できませんでした。", e);
  }

  refresh();
  return {
    ok: `「${input.name}」を追加しました。これから登録される受注は、この金額で報酬を計算します。`,
    savedAt: Date.now(),
  };
}

/* ---------- 登録ずみの商品を直す ---------- */

export async function updateProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象の商品を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const parsed = parse(formData);
  if (!parsed.ok) return { error: parsed.error };
  const input = parsed.value;

  let renamedFrom = "";
  try {
    const before = await loadProduct(id);
    if (!before) return { error: NOT_FOUND };

    const same = await findByName(input.name, id);
    if (same) {
      return {
        error: `「${input.name}」という商品名はほかの商品で使われています。受注と突き合わせられなくなるため、別の名前にしてください。`,
      };
    }

    const rows = await update<Row>(`products?id=eq.${id}`, toPayload(input));
    if (rows.length === 0) return { error: NOT_FOUND };

    renamedFrom = str(before, "name") === input.name ? "" : str(before, "name");
    await audit(
      await actorLabel(),
      "商品の変更",
      { type: "product", key: id },
      { 変更前: logOfRow(before), 変更後: logOf(input) },
    );
  } catch (e) {
    return failed("変更を保存できませんでした。", e);
  }

  refresh();
  const note = renamedFrom
    ? `商品名を「${renamedFrom}」から変えました。受注に記録される商品名も同じ表記に直さないと、報酬額を引けなくなります。販売ページの表記もあわせてご確認ください。`
    : "すでに計上ずみの報酬額は変わりません。";
  return { ok: `「${input.name}」の内容を保存しました。${note}` };
}

/* ---------- 取扱を止める・再開する ---------- */

/**
 * 商品は消さずに、取扱中かどうかだけを切り替える。
 * 過去の受注が商品名でこの商品を参照しているため、行を消すと金額の根拠が追えなくなる。
 */
export async function toggleActiveAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readId(formData);
  if (!id) {
    return {
      error: "対象の商品を特定できませんでした。画面を読み込み直してからお試しください。",
    };
  }

  const next = String(formData.get("next") ?? "");
  if (next !== "stop" && next !== "resume") {
    return {
      error: "取扱の切り替えを読み取れませんでした。画面を読み込み直してからお試しください。",
    };
  }
  const toActive = next === "resume";

  let name = "";
  try {
    const before = await loadProduct(id);
    if (!before) return { error: NOT_FOUND };
    name = str(before, "name") || "名前のない商品";

    const wasActive = before["active"] !== false;
    if (wasActive === toActive) {
      return {
        error: toActive
          ? `「${name}」はすでに取扱中です。画面を読み込み直してご確認ください。`
          : `「${name}」はすでに取扱を止めています。画面を読み込み直してご確認ください。`,
      };
    }

    const rows = await update<Row>(`products?id=eq.${id}`, { active: toActive });
    if (rows.length === 0) return { error: NOT_FOUND };

    await audit(
      await actorLabel(),
      toActive ? "商品の取扱再開" : "商品の取扱停止",
      { type: "product", key: id },
      { 商品名: name, 販売単価: before["price_incl_tax"] ?? null },
    );
  } catch (e) {
    return failed(
      toActive ? "取扱の再開を保存できませんでした。" : "取扱の停止を保存できませんでした。",
      e,
    );
  }

  refresh();
  return {
    ok: toActive
      ? `「${name}」の取扱を再開しました。「取扱中の商品」に戻しています。`
      : `「${name}」の取扱を止めました。「取扱を止めた商品」に移しています。過去の受注と報酬はそのまま残ります。`,
  };
}
