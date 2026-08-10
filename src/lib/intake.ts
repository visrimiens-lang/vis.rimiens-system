import "server-only";
import { audit, insert, select, selectOne, update } from "./db";

/**
 * 外から届いた申込を受け止めて、代理店・トスアップ・デモ機として登録する。
 *
 * これまで Make がやっていたことを、ここに集約している。
 *   ・代理店コードの採番
 *   ・招待コードから上位代理店を探す
 *   ・4次以降の禁止、枠の空き確認
 *   ・重複した送信をはじく
 *
 * 届いたものはまず inbox に丸ごと保存してから処理する。
 * 途中で失敗しても、あとから何度でもやり直せるようにするため。
 */

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/** コード区分。代理店コードの真ん中2桁になる。 */
export const KIND_COMPANY = "00";     // 会社としての代理店
export const KIND_REFERRER = "01";    // 取次パートナー（紹介のみ）
export const KIND_STAFF = "02";       // スタッフ（代理店に所属する個人）

export type IntakeResult =
  | { ok: true; code: string; message: string }
  | { ok: false; message: string; needsReview?: boolean };

/* ═══════════════════════ 代理店コードの採番 ═══════════════════════ */

/**
 * 代理店コードの頭につく、組織を表す英字（RIM / MET など）を取り出す。
 * 上位が RIM0003 でも、配下のコードは RIM01xx のように組織の頭文字から始まる。
 */
export function orgPrefixOf(code: string): string {
  const m = /^[A-Za-z]+/.exec(code.trim());
  return m ? m[0].toUpperCase() : code.trim().toUpperCase();
}

/**
 * 次の代理店コードを決める。
 *
 * 形は「組織の英字 + 区分2桁 + 枝番2桁」。実データの並びに合わせている。
 *   RIM + 00 + 06 → RIM0006（Rimiens 組織の会社6社目）
 *   RIM + 01 + 03 → RIM0103（Rimiens 組織の取次パートナー3人目）
 *   MET + 01 + 01 → MET0101
 *
 * 同じ組織・同じ区分の中で、いま使われている最大の枝番の次を返す。
 * 枝番が99を超えたら採番できない（そのときは本部で手当てする）。
 *
 * ※ コード自体はどの統括代理店の配下かを表さない。所属は上位代理店コードで持つ。
 */
export async function nextAgencyCode(
  parentCode: string,
  kind: string,
): Promise<string | null> {
  const prefix = `${orgPrefixOf(parentCode)}${kind}`;
  const rows = await select<Row>(
    `agencies?select=code&code=like.${encodeURIComponent(prefix + "%")}`,
  );
  let max = 0;
  for (const r of rows) {
    const tail = s_(r, "code").slice(prefix.length);
    const n = Number(tail);
    if (Number.isInteger(n) && n > max) max = n;
  }
  const next = max + 1;
  if (next > 99) return null;
  return `${prefix}${String(next).padStart(2, "0")}`;
}

/* ═══════════════════════ 上位代理店を探す ═══════════════════════ */

/**
 * 招待コードから上位代理店を探す。
 *
 * 招待コードは、上位代理店が配る文字列。代理店コードそのものが使われることも多い。
 * 見つからなければ null（本部で手当てが必要）。
 */
export async function resolveParent(inviteCode: string): Promise<Row | null> {
  const c = inviteCode.trim();
  if (!c) return null;

  // まず代理店コードとして探す
  const byCode = await selectOne<Row>(
    `agencies?select=*&code=eq.${encodeURIComponent(c)}`,
  );
  if (byCode) return byCode;

  // 次に招待コードとして探す
  return selectOne<Row>(
    `agencies?select=*&invite_code=eq.${encodeURIComponent(c)}`,
  );
}

/* ═══════════════════════ 登録してよいかの確認 ═══════════════════════ */

/** 上位代理店の下に、この区分の相手を登録してよいか確かめる。 */
export async function canRegisterUnder(
  parent: Row,
  kind: string,
  channel: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parentRank = s_(parent, "rank");
  const parentKind = s_(parent, "code_kind");

  // 取次パートナーとスタッフの下にはぶら下げられない（4次以降の禁止）
  if (parentKind === KIND_REFERRER || parentKind === KIND_STAFF) {
    return {
      ok: false,
      reason: `${s_(parent, "name")} は取次パートナーまたはスタッフのため、配下を登録できません。`,
    };
  }
  if (parentRank === "取次店") {
    return { ok: false, reason: `${s_(parent, "name")} の下に代理店は登録できません。` };
  }

  // スタッフと取次パートナーは枠を使わない
  if (kind === KIND_STAFF) return { ok: true };

  // 特別枠は上限の対象外
  if (parent["special_slot"] === true) return { ok: true };

  // 枠の空きを見る
  const column =
    channel === "サロン代理店" ? "limit_salon"
    : channel === "個人販売パートナー" ? "limit_kojin"
    : channel === "サロン提携パートナー（取次）" ? "limit_toritsugi"
    : "limit_hanbai";
  const limit = Number(parent[column] ?? 0) || 0;

  const siblings = await select<Row>(
    `agencies?select=id,channel,code_kind,status&parent_code=eq.${encodeURIComponent(s_(parent, "code"))}`,
  );
  const used = siblings.filter(
    (a) =>
      s_(a, "status") !== "停止・解約" &&
      s_(a, "code_kind") !== KIND_STAFF &&
      s_(a, "channel") === channel,
  ).length;

  if (limit > 0 && used >= limit) {
    return {
      ok: false,
      reason: `${s_(parent, "name")} の「${channel}」の枠が上限（${limit}）に達しています。増枠の承認が必要です。`,
    };
  }
  return { ok: true };
}

/* ═══════════════════════ 受信箱 ═══════════════════════ */

/**
 * 届いたものをそのまま保存する。
 * 同じ送信IDが再び届いても二重に登録しないよう、ここで弾く。
 */
export async function receive(
  source: string,
  externalId: string | null,
  formId: string | null,
  payload: unknown,
): Promise<{ id: number; duplicate: boolean }> {
  if (externalId) {
    const seen = await selectOne<Row>(
      `inbox?select=id,processed&source=eq.${encodeURIComponent(source)}&external_id=eq.${encodeURIComponent(externalId)}`,
    );
    if (seen) return { id: Number(seen["id"]), duplicate: true };
  }
  const [row] = await insert<Row>("inbox", [
    { source, external_id: externalId, form_id: formId, payload },
  ]);
  return { id: Number(row["id"]), duplicate: false };
}

/** 受信箱の1件を「処理済み」にする。 */
export async function markProcessed(id: number, error?: string): Promise<void> {
  await update(`inbox?id=eq.${id}`, {
    processed: !error,
    processed_at: new Date().toISOString(),
    error: error ?? null,
  });
}

/* ═══════════════════════ 代理店の登録 ═══════════════════════ */

export type AgencyApplication = {
  /** どのフォームから来たか */
  formKind: "代理店システム登録" | "取次パートナー登録" | "スタッフ登録";
  name: string;
  repName?: string;
  email?: string;
  phone?: string;
  zip?: string;
  address?: string;
  shopName?: string;
  birthday?: string;
  /** 上位代理店を指す文字列（招待コードまたは代理店コード） */
  inviteCode: string;
  /** 販路種別。会社登録のときに使う */
  channel?: string;
  areaClass?: string;
  bank?: { name?: string; branch?: string; type?: string; number?: string; holder?: string };
  jotformId?: string;
  ip?: string;
  userAgent?: string;
};

/** フォームの種類から、コード区分と既定のランクを決める。 */
function kindOf(formKind: AgencyApplication["formKind"]): { kind: string; rank: string } {
  if (formKind === "取次パートナー登録") return { kind: KIND_REFERRER, rank: "取次店" };
  if (formKind === "スタッフ登録") return { kind: KIND_STAFF, rank: "取次店" };
  return { kind: KIND_COMPANY, rank: "2次代理店" };
}

/**
 * 申込から代理店を登録する。
 *
 * 登録した時点では「未稼働」。本部が内容を確認して稼働中にする運用（承認制の維持）。
 * 2026-07-30 の会議で「自動発行にはしない」と決まっているため、ここで承認まではしない。
 */
export async function registerAgency(app: AgencyApplication): Promise<IntakeResult> {
  const name = (app.name || "").trim();
  if (!name) return { ok: false, message: "お名前または法人名が入っていません。" };

  // 同じ申込が二重に届いていないか
  if (app.jotformId) {
    const dup = await selectOne<Row>(
      `agencies?select=code&jotform_id=eq.${encodeURIComponent(app.jotformId)}`,
    );
    if (dup) {
      return { ok: true, code: s_(dup, "code"), message: "この申込は登録済みです。" };
    }
  }

  const parent = await resolveParent(app.inviteCode);
  if (!parent) {
    return {
      ok: false,
      needsReview: true,
      message: `招待コード「${app.inviteCode || "（未入力）"}」に合う上位代理店が見つかりませんでした。本部での確認が必要です。`,
    };
  }

  const { kind, rank } = kindOf(app.formKind);
  const channel =
    app.channel ||
    (kind === KIND_REFERRER ? "サロン提携パートナー（取次）" : "未設定");

  const allowed = await canRegisterUnder(parent, kind, channel);
  if (!allowed.ok) return { ok: false, needsReview: true, message: allowed.reason };

  const code = await nextAgencyCode(s_(parent, "code"), kind);
  if (!code) {
    return {
      ok: false,
      needsReview: true,
      message: `${s_(parent, "name")} 配下のコードが上限に達しました。本部で採番してください。`,
    };
  }

  await insert("agencies", [
    {
      code,
      name,
      rep_name: app.repName || null,
      rank,
      channel,
      code_kind: kind,
      branch_no: Number(code.slice(-2)),
      parent_code: s_(parent, "code"),
      parent_name: s_(parent, "name"),
      zeroth_code: s_(parent, "zeroth_code") || s_(parent, "code"),
      invite_code: app.inviteCode || null,
      area_class: app.areaClass || null,
      status: "未稼働",
      email: app.email || null,
      phone: app.phone || null,
      zip: app.zip || null,
      address: app.address || null,
      shop_name: app.shopName || null,
      birthday: app.birthday || null,
      bank_name: app.bank?.name || null,
      bank_branch: app.bank?.branch || null,
      account_type: app.bank?.type === "当座" ? "当座" : app.bank?.type ? "普通" : null,
      account_no: app.bank?.number || null,
      account_holder: app.bank?.holder || null,
      registered_via: app.formKind,
      jotform_id: app.jotformId || null,
      applied_at: new Date().toISOString(),
      applied_ip: app.ip || null,
      applied_ua: app.userAgent || null,
    },
  ]);

  await audit("intake", "代理店登録", { type: "agency", key: code }, {
    形式: app.formKind,
    上位: s_(parent, "code"),
  });

  return {
    ok: true,
    code,
    message: `${name} を ${code} として登録しました。本部の確認後に稼働中になります。`,
  };
}

/* ═══════════════════════ トスアップの登録 ═══════════════════════ */

export type LeadApplication = {
  customerName: string;
  phone: string;
  referrerCode: string;
  note?: string;
};

/** 電話番号から記号を落とす。同じ人を二重に登録しないための照合に使う。 */
export function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^0-9]/g, "");
}

export async function registerLead(app: LeadApplication): Promise<IntakeResult> {
  const name = (app.customerName || "").trim();
  const code = (app.referrerCode || "").trim();
  if (!name) return { ok: false, message: "お客様のお名前が入っていません。" };
  if (!code) return { ok: false, message: "取次店コードが入っていません。" };

  const referrer = await selectOne<Row>(
    `agencies?select=code,name&code=eq.${encodeURIComponent(code)}`,
  );
  if (!referrer) {
    return { ok: false, needsReview: true, message: `取次店コード「${code}」が見つかりません。` };
  }

  const normalized = normalizePhone(app.phone);

  // 同じ電話番号で、同じ取次店から、まだ成約していないものがあれば二重登録しない
  if (normalized) {
    const dup = await selectOne<Row>(
      `leads?select=id&referrer_code=eq.${encodeURIComponent(code)}&phone_normalized=eq.${normalized}&status=neq.${encodeURIComponent("成約")}`,
    );
    if (dup) return { ok: true, code, message: "同じお客様のご紹介が既に届いています。" };
  }

  await insert("leads", [
    {
      customer_name: name,
      phone: app.phone || null,
      phone_normalized: normalized || null,
      referrer_code: code,
      status: "トスアップ済",
      note: app.note || null,
    },
  ]);
  await audit("intake", "トスアップ登録", { type: "lead", key: code }, { 顧客: name });
  return { ok: true, code, message: `${name} 様のご紹介を受け付けました。` };
}

/* ═══════════════════════ 受注の登録 ═══════════════════════ */

export type OrderApplication = {
  customerName: string;
  email?: string;
  phone?: string;
  zip?: string;
  address?: string;
  building?: string;
  productName?: string;
  amount: number;
  quantity?: number;
  paymentMethod?: string;
  /** 代理店コード。UTAGE の ?ref= で渡ってくる */
  agencyCode?: string;
  stripePaymentId?: string;
};

/**
 * 受注を登録する。
 *
 * 代理店コードから階層（2次代理店・ゼロ次代理店）を自動で埋める。
 * 電話番号が一致するトスアップがあれば、その取次店を紹介元として結びつける
 * （これまで Make のシナリオC がやっていた照合）。
 */
export async function registerOrder(app: OrderApplication): Promise<IntakeResult> {
  const name = (app.customerName || "").trim();
  if (!name) return { ok: false, message: "注文者名が入っていません。" };

  if (app.stripePaymentId) {
    const dup = await selectOne<Row>(
      `orders?select=id&stripe_payment_id=eq.${encodeURIComponent(app.stripePaymentId)}`,
    );
    if (dup) return { ok: true, code: String(dup["id"]), message: "この決済は登録済みです。" };
  }

  // 代理店コードから階層をたどる
  let agency: Row | null = null;
  let nijiCode = "";
  let zerothCode = "";
  if (app.agencyCode) {
    agency = await selectOne<Row>(
      `agencies?select=*&code=eq.${encodeURIComponent(app.agencyCode.trim())}`,
    );
    if (agency) {
      // ゼロ次が空なら、コードの頭の英字（組織）で補う
      zerothCode = s_(agency, "zeroth_code") || orgPrefixOf(s_(agency, "code"));
      // 自分が2次代理店ならそのまま、下位なら上位をたどる
      nijiCode =
        s_(agency, "rank") === "2次代理店" ? s_(agency, "code") : s_(agency, "parent_code");
    }
  }

  // 電話番号でトスアップと照合する
  const normalized = normalizePhone(app.phone ?? "");
  let referrerCode = "";
  let matchStatus = "直販";
  if (normalized) {
    const leads = await select<Row>(
      `leads?select=id,referrer_code,status&phone_normalized=eq.${normalized}&order=tossed_at.asc`,
    );
    const open = leads.filter((l) => s_(l, "status") !== "不成立");
    if (open.length === 1) {
      referrerCode = s_(open[0], "referrer_code");
      matchStatus = "照合済";
    } else if (open.length > 1) {
      // 複数見つかったら自動で決めず、本部の確認に回す
      // （2026-07-09 の回答書「複数ヒット時は自動計上せず確認リストへ」）
      referrerCode = s_(open[0], "referrer_code");
      matchStatus = "要確認";
    }
  }

  const [order] = await insert<Row>("orders", [
    {
      customer_name: name,
      phone: app.phone || null,
      zip: app.zip || null,
      address: app.address || null,
      building: app.building || null,
      product_name: app.productName || null,
      quantity: app.quantity ?? 1,
      amount: app.amount ?? 0,
      payment_method: app.paymentMethod || null,
      agency_code: app.agencyCode || null,
      niji_code: nijiCode || null,
      zeroth_code: zerothCode || null,
      referrer_code: referrerCode || null,
      match_status: matchStatus,
      stripe_payment_id: app.stripePaymentId || null,
      ship_status: "出荷待ち",
    },
  ]);

  // トスアップを成約にする
  if (referrerCode && matchStatus === "照合済" && normalized) {
    await update(
      `leads?phone_normalized=eq.${normalized}&referrer_code=eq.${encodeURIComponent(referrerCode)}`,
      {
        status: "成約",
        closed_on: new Date().toISOString().slice(0, 10),
        order_id: order["id"],
      },
    );
  }

  await audit("intake", "受注登録", { type: "order", key: String(order["id"]) }, {
    顧客: name,
    金額: app.amount,
    照合: matchStatus,
  });

  return {
    ok: true,
    code: String(order["id"]),
    message: `${name} 様のご注文を登録しました。`,
  };
}
