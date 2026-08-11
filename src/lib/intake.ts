import "server-only";
import { audit, insert, select, selectOne, update } from "./db";
import { HQ_MAIL, acquisitionMail, licenseTestMail, sendMail } from "./mail";

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

/**
 * ゼロ次代理店（総販売代理店）のコード。
 *
 * エリア統括代理店の申込には招待コードが無い。上位は必ずここになる決まりなので、
 * 招待コードを求めずにここへぶら下げる
 * （make-blueprints/scenario-13-v3-FINAL3.json のエリア統括ルートが
 *   上位代理店コードに "RIM" を直接書いているのと同じ扱い）。
 */
export const ZEROTH_CODE = "RIM";

export type IntakeResult =
  /**
   * 登録できた。needsReview が true のときは登録自体は済んでいるが、
   * 報酬が立たなかったなど本部の手当てが要る点が残っている。
   * 受け口はこれを見て、受信箱に「取り込めていない」として残す。
   */
  | { ok: true; code: string; message: string; needsReview?: boolean }
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
 *
 * 同じ送信IDが再び届いたときの扱いを、前回どうなったかで分ける。
 *
 *   前回うまくいっていた   → duplicate。もう一度処理しない（二重登録を防ぐ）。
 *   前回しくじっていた     → duplicate にしない。同じ行を使ってやり直す。
 *
 * 「一度届いたら二度と処理しない」にしていると、
 * 保存先が一時的に落ちていた等でしくじった申込を、
 * JotForm 側から送り直しても「受付済みです」と返してしまい、
 * その申込は永久に登録されないまま消える。
 * 受け口はお客様の申込と決済の入口なので、やり直せることを優先する。
 *
 * 新しい行を作らず前回の行を使い回すので、受信箱に同じものが並ぶこともない。
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
    if (seen) {
      const id = Number(seen["id"]);
      // processed が true のときだけ「もう済んでいる」と見なす
      if (seen["processed"] === true) return { id, duplicate: true };
      // 前回しくじっている。届いた中身は最新のものに置き換えてやり直す。
      await update(`inbox?id=eq.${id}`, {
        payload,
        form_id: formId,
        error: null,
        processed_at: null,
      });
      return { id, duplicate: false };
    }
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
  /**
   * 申込フォームで選んだ代理店種別
   * （エリア統括代理店 / 販売代理店 / サロン代理店 / 個人販売代理店）。
   * ここからランク・販路種別・上位の決め方が変わる。
   */
  agencyType?: string;
  areaClass?: string;
  bank?: { name?: string; branch?: string; type?: string; number?: string; holder?: string };
  jotformId?: string;
  ip?: string;
  userAgent?: string;
};

/**
 * 会社としての申込で選ぶ「代理店種別」と、そこから決まる中身。
 *
 * 取り決めは make-blueprints/scenario-13-v3-FINAL3.json（Make のシナリオ#13）に
 * 残っている 4 分岐と同じ。
 *
 *   エリア統括代理店 … ランク 2次代理店・販路種別 販売代理店・上位は Rimiens 固定
 *   販売代理店       … ランク 取次店  ・販路種別 販売代理店      （3次）
 *   サロン代理店     … ランク 取次店  ・販路種別 サロン代理店     （3次）
 *   個人販売代理店   … ランク 取次店  ・販路種別 個人販売パートナー（3次）
 *
 * 代理店ランクの選択肢に「販売代理店」が無いため、3次は
 * 「取次店 ＋ 販路種別」の組み合わせで表す。報酬の単価を引くときも
 * この組み合わせを見る（src/lib/orders.ts の effectiveRank）。
 */
const AGENCY_TYPES: Record<
  string,
  { rank: string; channel: string; parentFixed?: string }
> = {
  エリア統括代理店: { rank: "2次代理店", channel: "販売代理店", parentFixed: ZEROTH_CODE },
  販売代理店: { rank: "取次店", channel: "販売代理店" },
  サロン代理店: { rank: "取次店", channel: "サロン代理店" },
  個人販売代理店: { rank: "取次店", channel: "個人販売パートナー" },
  // 申込フォームの表記ゆれを拾う
  個人販売パートナー: { rank: "取次店", channel: "個人販売パートナー" },
};

/**
 * フォームの種類と代理店種別から、コード区分・ランク・販路種別を決める。
 *
 * 代理店種別が読み取れなかったときは、いちばん影響の小さい3次として扱う。
 * 以前はここが「会社の申込は全部2次代理店」だったため、
 * 3次として申し込んだ会社が統括代理店として登録され、
 * 報酬が1台あたり 35,200 円多く計上されるうえ、
 * 本来の上位統括代理店には1円も計上されない状態になっていた。
 */
function kindOf(
  formKind: AgencyApplication["formKind"],
  agencyType = "",
): { kind: string; rank: string; channel: string; parentFixed?: string } {
  if (formKind === "取次パートナー登録") {
    return { kind: KIND_REFERRER, rank: "取次店", channel: "サロン提携パートナー（取次）" };
  }
  if (formKind === "スタッフ登録") {
    return { kind: KIND_STAFF, rank: "取次店", channel: "未設定" };
  }
  const t = AGENCY_TYPES[agencyType.trim()];
  if (t) {
    return { kind: KIND_COMPANY, rank: t.rank, channel: t.channel, parentFixed: t.parentFixed };
  }
  // 種別が分からないとき。多く払う側に倒さない。
  return { kind: KIND_COMPANY, rank: "取次店", channel: "販売代理店" };
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

  const decided = kindOf(app.formKind, app.agencyType);
  const { kind, rank } = decided;
  // 申込フォームが販路種別を直接送ってきていればそれを優先する
  const channel = app.channel || decided.channel;

  /*
   * 上位代理店を決める。
   *
   * エリア統括代理店は上位が Rimiens で固定なので、申込フォームに招待コードの欄が無い
   * （JotForm③の仕様どおり）。招待コードを必須にしていたため、
   * これから募集する統括代理店の申込が1件も登録できない状態だった。
   */
  const parent = decided.parentFixed
    ? await agencyByCode(decided.parentFixed)
    : await resolveParent(app.inviteCode);

  if (!parent) {
    return {
      ok: false,
      needsReview: true,
      message: decided.parentFixed
        ? `上位となる代理店（${decided.parentFixed}）が見つかりませんでした。本部での確認が必要です。`
        : `招待コード「${app.inviteCode || "（未入力）"}」に合う上位代理店が見つかりませんでした。本部での確認が必要です。`,
    };
  }

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
      /*
       * ゼロ次（総販売代理店）は、上位に入っていればそれを引き継ぐ。
       * 入っていないときは上位のコードではなく、組織を表す英字を使う。
       * 上位のコードをそのまま入れると、たとえば RIM0003 の配下が
       * ゼロ次＝RIM0003 になり、本来の総販売代理店 RIM に報酬が立たなくなる
       * （3次が1台売るたびに 77,000 円が計上されない）。
       * 受注時の判定（resolveAttribution）も組織の英字を使っているので、そこに揃える。
       */
      zeroth_code: s_(parent, "zeroth_code") || orgPrefixOf(s_(parent, "code")),
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
  /**
   * 代理店コード。UTAGE の ?ref= で渡ってくる。
   * スタッフや取次パートナーのコードが入ってくることもある（下の resolveAttribution を参照）。
   */
  agencyCode?: string;
  /** 誰が売ったか。フォームに担当者コードの欄があるときに渡ってくる */
  staffCode?: string;
  stripePaymentId?: string;
};

/** 代理店マスタを1件引く。 */
async function agencyByCode(code: string): Promise<Row | null> {
  const c = (code || "").trim();
  if (!c) return null;
  return selectOne<Row>(`agencies?select=*&code=eq.${encodeURIComponent(c)}`);
}

/** 受注1件の「誰が売ったか」と「どの代理店の売上か」。 */
export type SalesAttribution = {
  /** 売上を付ける代理店（会社） */
  agencyCode: string;
  /** 実際に売った個人（コード区分 02） */
  staffCode: string;
  /** 紹介した取次パートナー（コード区分 01） */
  referrerCode: string;
  /** 2次代理店（統括） */
  nijiCode: string;
  /** ゼロ次代理店 */
  zerothCode: string;
};

/**
 * 渡されたコードから、売上の付け先と担当者を割り出す。
 *
 * UTAGE の ?ref= には代理店コードが入る決まりだが、実際には
 * スタッフ（コード区分 02）や取次パートナー（同 01）のコードで来ることがある。
 * それをそのまま agency_code に入れると、
 *   ・「誰が売ったか」が顧客管理側に残らない（2026-08-07 会議での指摘）
 *   ・売上が個人に付き、所属先の代理店に付かない
 * という2つの取りこぼしが起きる。そこで区分ごとに置き場所を分ける。
 *
 *   区分 02（スタッフ）        … staff_code に本人、agency_code に所属先（上位）
 *   区分 01（取次パートナー）  … referrer_code に本人、agency_code に所属先（上位）
 *   区分 00（会社）・マスタ未登録 … agency_code にそのまま
 *
 * 上位が分からない（parent_code が空）ときは、本人のコードを売上の付け先として残す。
 * 付け先が消えると、報酬が誰にも計上されなくなるため。
 */
export async function resolveAttribution(
  rawAgencyCode: string,
  rawStaffCode = "",
): Promise<SalesAttribution> {
  const out: SalesAttribution = {
    agencyCode: (rawAgencyCode || "").trim(),
    staffCode: (rawStaffCode || "").trim(),
    referrerCode: "",
    nijiCode: "",
    zerothCode: "",
  };

  const given = out.agencyCode;
  const ref = await agencyByCode(given);
  const refKind = s_(ref, "code_kind");

  if (ref && refKind === KIND_STAFF) {
    // スタッフ本人が売った。売上は所属先の代理店に付ける。
    if (!out.staffCode) out.staffCode = s_(ref, "code");
    out.agencyCode = s_(ref, "parent_code") || s_(ref, "code");
  } else if (ref && refKind === KIND_REFERRER) {
    // 取次パートナーの紹介。紹介報酬は本人、販売報酬は所属先に立てる。
    out.referrerCode = s_(ref, "code");
    out.agencyCode = s_(ref, "parent_code") || s_(ref, "code");
  }

  // コードが無く、担当者だけが分かっているときは、その方の所属先を売上の付け先にする
  if (!out.agencyCode && out.staffCode) {
    const person = await agencyByCode(out.staffCode);
    if (person && s_(person, "code_kind") === KIND_STAFF) {
      out.agencyCode = s_(person, "parent_code") || s_(person, "code");
    }
  }

  // 付け先が決まったら、そこから階層をたどる
  if (out.agencyCode) {
    const seller =
      ref && s_(ref, "code") === out.agencyCode ? ref : await agencyByCode(out.agencyCode);
    if (seller) {
      // ゼロ次が空なら、コードの頭の英字（組織）で補う
      out.zerothCode = s_(seller, "zeroth_code") || orgPrefixOf(s_(seller, "code"));
      // 自分が2次代理店ならそのまま、下位なら上位をたどる
      out.nijiCode =
        s_(seller, "rank") === "2次代理店" ? s_(seller, "code") : s_(seller, "parent_code");
    }
  }

  return out;
}

/**
 * 受注のお客様を顧客台帳に結びつける。見つからなければ新しく作る。
 *
 * 顧客一覧は、受注の customer_id から顧客台帳の配達完了日を引いて進み具合を出している。
 * ここが空のままだと、どれだけ配達が終わっても「出荷済 80%」で止まって見える。
 *
 * 照合は電話番号で行う。台帳には記号を落とした電話番号の列が無いので、
 * 下4桁で絞ってから、記号を落とした形で突き合わせる。
 *
 * すでにある台帳の内容は上書きしない（本部が聞き取って直した内容を消さないため）。
 * 空いている欄だけを埋める。
 */
export async function linkCustomer(app: {
  name: string;
  phone?: string;
  email?: string;
  zip?: string;
  address?: string;
  building?: string;
  agencyCode?: string;
  staffCode?: string;
  referrerCode?: string;
  /**
   * 顧客台帳の決済状況に入れる値（未決済 / 審査中 / 決済完了 / 否決・キャンセル）。
   * 受注は決済が終わった知らせとして届くので、registerOrder は「決済完了」を渡す。
   * これを入れないと、お届けまで終わったお客様が一覧で「未決済」のまま残る。
   */
  paymentStatus?: string;
}): Promise<number | null> {
  const name = (app.name || "").trim();
  if (!name) return null;

  const normalized = normalizePhone(app.phone ?? "");

  let found: Row | null = null;
  if (normalized) {
    const tail = normalized.slice(-4);
    const rows = await select<Row>(
      `customers?select=id,name,phone,agency_code,staff_code,referrer_code&phone=like.*${encodeURIComponent(tail)}&limit=50`,
    );
    found = rows.find((c) => normalizePhone(s_(c, "phone")) === normalized) ?? null;
  }

  const attribution: Record<string, string> = {};
  if (app.agencyCode) attribution["agency_code"] = app.agencyCode;
  if (app.staffCode) attribution["staff_code"] = app.staffCode;
  if (app.referrerCode) attribution["referrer_code"] = app.referrerCode;

  if (found) {
    const patch: Record<string, string> = {};
    for (const [column, value] of Object.entries(attribution)) {
      if (!s_(found, column)) patch[column] = value;
    }
    /*
     * 決済状況は「空のときだけ入れる」ではなく、常に新しいほうで上書きする。
     * 帰属（誰の売上か）は先に付いたものを尊重するが、決済状況は
     * いちばん新しい決済の結果が正しいため。
     */
    if (app.paymentStatus) patch["payment_status"] = app.paymentStatus;
    if (Object.keys(patch).length > 0) {
      await update(`customers?id=eq.${encodeURIComponent(s_(found, "id"))}`, patch);
    }
    return Number(found["id"]) || null;
  }

  const [row] = await insert<Row>("customers", [
    {
      name,
      phone: app.phone || null,
      email: app.email || null,
      zip: app.zip || null,
      address: app.address || null,
      building: app.building || null,
      ...(app.paymentStatus ? { payment_status: app.paymentStatus } : {}),
      ...attribution,
    },
  ]);
  return Number(row?.["id"]) || null;
}

/**
 * 受注を登録する。
 *
 * 渡されたコードから「誰が売ったか（担当スタッフ・取次パートナー）」と
 * 「どの代理店の売上か」を割り出し、階層（2次代理店・ゼロ次代理店）まで埋める。
 * 電話番号が一致するトスアップがあれば、その取次店を紹介元として結びつける
 * （これまで Make のシナリオC がやっていた照合）。
 * あわせてお客様を顧客台帳に結びつける（進み具合の表示に使う）。
 */
export async function registerOrder(app: OrderApplication): Promise<IntakeResult> {
  const name = (app.customerName || "").trim();
  if (!name) return { ok: false, message: "注文者名が入っていません。" };

  if (app.stripePaymentId) {
    const dup = await selectOne<Row>(
      `orders?select=id&stripe_payment_id=eq.${encodeURIComponent(app.stripePaymentId)}`,
    );
    if (dup) return { ok: true, code: String(dup["id"]), message: "この決済は登録済みです。" };
  } else {
    /*
     * 決済の番号が入っていないとき。
     *
     * 番号があれば、それを鍵にして二重登録を防げる。無いときは鍵が無いので、
     * このままだと同じ通知が二度届いただけで受注が2件立ち、報酬も満額もう1件分
     * 計上される。確定・支払まで進めば実際に二重払いになる。
     *
     * そこで「同じお客様・同じ金額の受注が、ついさっき入っていないか」を見る。
     * 人が続けて2回申し込むことは実務上まず無いので、5分以内に同じ内容が来たら
     * 通知の二度届きとみなして、前の受注をそのまま返す。
     * 番号がある通常のときは、この判定は通らない（上の分岐で終わる）。
     */
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recent = await selectOne<Row>(
      `orders?select=id,amount&customer_name=eq.${encodeURIComponent(name)}` +
        `&amount=eq.${Number(app.amount ?? 0)}` +
        `&created_at=gte.${encodeURIComponent(since)}&order=id.desc`,
    );
    if (recent) {
      await audit("intake", "受注の二重登録を防いだ", { type: "order", key: s_(recent, "id") }, {
        顧客: name,
        金額: app.amount,
        理由: "決済の番号が無く、5分以内に同じ内容の受注があるため",
      });
      return {
        ok: true,
        code: String(recent["id"]),
        message: "この注文は登録済みです（同じ内容が続けて届いたため）。",
      };
    }
  }

  // 渡されたコードの持ち主を見て、売上の付け先と担当者を分ける
  const who = await resolveAttribution(app.agencyCode ?? "", app.staffCode ?? "");
  const { agencyCode, staffCode, nijiCode, zerothCode } = who;

  // 電話番号でトスアップと照合する
  const normalized = normalizePhone(app.phone ?? "");
  let referrerCode = "";
  let matchStatus = "直販";
  // 成約に書き換えるトスアップは、照合で選んだこの1件だけ
  let matchedLeadId = "";
  if (normalized) {
    const leads = await select<Row>(
      `leads?select=id,referrer_code,status&phone_normalized=eq.${normalized}&order=tossed_at.asc`,
    );
    const open = leads.filter((l) => s_(l, "status") !== "不成立");
    if (open.length === 1) {
      referrerCode = s_(open[0], "referrer_code");
      matchedLeadId = s_(open[0], "id");
      matchStatus = "照合済";
    } else if (open.length > 1) {
      // 複数見つかったら自動で決めず、本部の確認に回す
      // （2026-07-09 の回答書「複数ヒット時は自動計上せず確認リストへ」）
      referrerCode = s_(open[0], "referrer_code");
      matchStatus = "要確認";
    }
  }

  // 取次パートナーのコードで来た受注は、その方が紹介元。
  // トスアップの照合と食い違うときは、どちらが紹介元か決めずに本部の確認に回す。
  const leadMatched = referrerCode;
  if (who.referrerCode) {
    if (!referrerCode) {
      referrerCode = who.referrerCode;
      matchStatus = "照合済";
    } else if (referrerCode !== who.referrerCode) {
      matchStatus = "要確認";
    }
  }

  /*
   * 受注を先に立ててから、お客様を顧客台帳に結びつける。
   *
   * 逆にすると、顧客台帳だけ「決済完了」で増えたのに受注が無い、という状態が残りうる。
   * そのお客様は本部の顧客一覧では正常な成約客に見えるのに、受注も報酬も無く、
   * 件数が合わないことに気づくまで放置される。
   * 受注さえ残っていれば、紐づけは受信箱から送り直すか本部が手で直せる。
   */
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
      agency_code: agencyCode || null,
      staff_code: staffCode || null,
      niji_code: nijiCode || null,
      zeroth_code: zerothCode || null,
      referrer_code: referrerCode || null,
      match_status: matchStatus,
      stripe_payment_id: app.stripePaymentId || null,
      ship_status: "出荷待ち",
    },
  ]);

  // 受注が残ったので、お客様を顧客台帳に結びつける。
  // ここで失敗しても受注は消さない（進み具合の表示が出ないだけで、売上と報酬は残る）。
  let customerId: number | null = null;
  try {
    customerId = await linkCustomer({
      name,
      phone: app.phone,
      email: app.email,
      zip: app.zip,
      address: app.address,
      building: app.building,
      agencyCode,
      staffCode,
      referrerCode,
      // 受注は決済が済んだ知らせとして届く（kintone 顧客管理と同じ言葉づかい）
      paymentStatus: "決済完了",
    });
    if (customerId) {
      await update(`orders?id=eq.${encodeURIComponent(String(order["id"]))}`, {
        customer_id: customerId,
      });
    }
  } catch (e) {
    // 黙って消さない。本部が受注詳細で「顧客台帳の番号」が空なのを見て手当てできるよう記録に残す。
    console.error("[customer]", e);
    await audit("intake", "顧客台帳への紐づけの失敗", { type: "order", key: String(order["id"]) }, {
      顧客: name,
      電話: app.phone || null,
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
    });
  }

  // トスアップを成約にする（電話番号で照合できたときだけ）。
  // 書き換えるのは照合で選んだ1件だけ。同じ電話番号・同じ取次店の行がほかにあっても巻き込まない。
  // すでに成約になっている行は、前の受注番号を残すためそのままにする。
  if (leadMatched && matchStatus === "照合済" && matchedLeadId) {
    await update(
      `leads?id=eq.${encodeURIComponent(matchedLeadId)}&status=neq.${encodeURIComponent("成約")}`,
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
    受け取ったコード: (app.agencyCode || "").trim() || null,
    代理店: agencyCode || null,
    担当スタッフ: staffCode || null,
    紹介元: referrerCode || null,
    顧客台帳: customerId,
  });

  /*
   * 報酬を計上し、獲得した代理店に知らせる。
   * どちらも失敗しても受注の登録は取り消さない（お客様の注文が消えるほうが困る）。
   *
   * ただし黙って終わらせない。報酬の計上に失敗すると、代理店に払うべき報酬が
   * 丸ごと立たない。代理店の画面は商品マスタから見込み額を計算して出すので
   * 本人には報酬が見えているのに、本部の支払管理には1行も出ない、という
   * いちばん気づきにくいずれ方をする。
   * 失敗したことを呼び出し元に返し、受信箱にも残して本部が気づけるようにする。
   */
  let trouble = "";
  try {
    const { accrueRewards } = await import("./rewards");
    const n = await accrueRewards(String(order["id"]));
    if (n === 0) {
      trouble =
        "報酬が1件も計上されませんでした。商品名が商品マスタと一致しているか、" +
        "代理店コードが入っているかをご確認ください。";
      await audit("intake", "報酬が計上されなかった受注", { type: "order", key: String(order["id"]) }, {
        顧客: name,
        商品名: app.productName || null,
        代理店: agencyCode || null,
      });
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : "原因を特定できませんでした。";
    console.error("[reward]", e);
    trouble = `報酬の計上に失敗しました。${why} 本部での手当てが必要です。`;
    await audit("intake", "報酬計上の失敗", { type: "order", key: String(order["id"]) }, {
      顧客: name,
      金額: app.amount,
      代理店: agencyCode || null,
      理由: why,
    });
  }

  try {
    await notifyAcquisition(String(order["id"]));
  } catch (e) {
    // 通知が届かなくても受注と報酬は残る。気づけるように記録だけ残す。
    console.error("[notify]", e);
    await audit("intake", "成約通知の失敗", { type: "order", key: String(order["id"]) }, {
      顧客: name,
      代理店: agencyCode || null,
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
    });
  }

  return {
    ok: true,
    code: String(order["id"]),
    message: `${name} 様のご注文を登録しました。${trouble ? ` ${trouble}` : ""}`,
    // 受け口はこれを見て、受信箱に「取り込めていない」として残す
    needsReview: trouble ? true : undefined,
  };
}


/* ═══════════════════════ デモ機の登録（Make #16） ═══════════════════════ */

export type DemoApplication = {
  serialNo: string;
  model?: string;
  acquiredKind?: string;
  acquiredOn?: string;
  holderCode?: string;
  holderName?: string;
  purpose?: string;
  note?: string;
};

export async function registerDemoMachine(app: DemoApplication): Promise<IntakeResult> {
  const serial = (app.serialNo || "").trim();
  if (!serial) return { ok: false, message: "製品番号（シリアル）が入っていません。" };

  const dup = await selectOne<Row>(
    `demo_machines?select=id&serial_no=eq.${encodeURIComponent(serial)}`,
  );
  if (dup) return { ok: true, code: serial, message: "この製品番号は登録済みです。" };

  // 保有代理店の名前を補う
  let holderName = app.holderName || "";
  if (app.holderCode && !holderName) {
    const owner = await selectOne<Row>(
      `agencies?select=name&code=eq.${encodeURIComponent(app.holderCode.trim())}`,
    );
    holderName = s_(owner, "name");
  }

  const kinds = ["個人購入", "デモ機購入", "無料貸与"];
  await insert("demo_machines", [
    {
      serial_no: serial,
      model: app.model || "VIS本体",
      acquired_kind: kinds.includes(app.acquiredKind ?? "") ? app.acquiredKind : null,
      acquired_on: app.acquiredOn || null,
      state: "在庫",
      holder_code: app.holderCode || null,
      holder_name: holderName || null,
      purpose: app.purpose || null,
      note: app.note || null,
    },
  ]);
  await audit("intake", "デモ機登録", { type: "demo", key: serial });
  return { ok: true, code: serial, message: `デモ機 ${serial} を登録しました。` };
}

/* ═══════════════════════ 体験の事前登録（Make シナリオD） ═══════════════════════ */

/**
 * 体験前の事前登録フォームから届いた方を、トスアップとして先に記録する。
 * まだ紹介ではなく「体験に同意して検討中」の段階なので、状態を分けておく。
 */
export async function registerPreLead(app: LeadApplication): Promise<IntakeResult> {
  const name = (app.customerName || "").trim();
  if (!name) return { ok: false, message: "お名前が入っていません。" };

  const normalized = normalizePhone(app.phone);
  if (normalized) {
    const dup = await selectOne<Row>(
      `leads?select=id&phone_normalized=eq.${normalized}`,
    );
    if (dup) return { ok: true, code: name, message: "すでに受付済みです。" };
  }

  await insert("leads", [
    {
      customer_name: name,
      phone: app.phone || null,
      phone_normalized: normalized || null,
      referrer_code: (app.referrerCode || "").trim() || "（直接）",
      status: "体験同意・検討中",
      note: app.note || null,
    },
  ]);
  await audit("intake", "体験事前登録", { type: "lead", key: name });
  return { ok: true, code: name, message: `${name} 様の事前登録を受け付けました。` };
}

/* ═══════════════════════ ライセンステストの提出（Make #17） ═══════════════════════ */

export async function notifyLicenseTest(opts: {
  name: string;
  agencyCode?: string;
  score?: string;
  detail?: string;
}): Promise<IntakeResult> {
  const name = (opts.name || "").trim();
  if (!name) return { ok: false, message: "お名前が入っていません。" };

  const mail = licenseTestMail(opts);
  const sent = await sendMail(HQ_MAIL, mail.subject, mail.body);
  await audit("intake", "ライセンステスト提出", { type: "license", key: name }, {
    通知: sent.ok ? "送信済み" : sent.error,
  });

  // メールが送れなくても提出自体は受け付ける（受信箱に残っている）
  return {
    ok: true,
    code: name,
    message: sent.ok
      ? "提出を受け付け、本部へ採点を依頼しました。"
      : "提出を受け付けました。本部への通知は届いていないため、別途ご連絡ください。",
  };
}

/* ═══════════════════════ 受注の通知（Make #8） ═══════════════════════ */

/**
 * 受注が入ったことを、獲得した代理店と、実際に売った担当スタッフに知らせる。
 * 送信に失敗しても受注の登録は取り消さない。
 *
 * 宛先は最大2件になる。
 *   ・売上の付け先（agency_code）… 会社。報酬の見込みも案内する。
 *   ・担当スタッフ（staff_code）… 個人。報酬の金額は案内しない。
 * スタッフが売ったとき、売上は所属先の会社に付く（resolveAttribution）ため、
 * 会社だけに送ると「自分の成約が入ったことを本人が知らない」状態になる。
 * 2026-08-07 会議「誰が売ったかを追える形にする」の趣旨に沿って本人にも送る。
 *
 * 同じ宛先に二重で送らないよう、メールアドレスで重複を除く
 * （個人事業主など、会社と担当者が同じアドレスのことがあるため）。
 */
export async function notifyAcquisition(orderId: string): Promise<void> {
  const order = await selectOne<Row>(`orders?select=*&id=eq.${encodeURIComponent(orderId)}`);
  if (!order) return;

  const agencyCode = s_(order, "agency_code");
  const staffCode = s_(order, "staff_code");
  const codes = [agencyCode, staffCode].filter(Boolean);
  if (codes.length === 0) return;

  const detail = {
    customerName: s_(order, "customer_name"),
    amount: Number(order["amount"] ?? 0),
    productName: s_(order, "product_name"),
  };

  const sentTo = new Set<string>();
  for (const code of codes) {
    const agency = await selectOne<Row>(
      `agencies?select=name,email,code_kind&code=eq.${encodeURIComponent(code)}`,
    );
    const to = s_(agency, "email").trim().toLowerCase();
    if (!to || sentTo.has(to)) continue;
    sentTo.add(to);

    /*
     * スタッフ本人あてでは、報酬の金額に触れない。
     * マイページはスタッフに金額を出さない（2026-04-23 決定: 金額が見えるのは
     * 親アカウントだけ）ため、書くと「見られると書いてあるのに出ない」となる。
     */
    const mail = acquisitionMail({
      agencyName: s_(agency, "name"),
      isStaff: s_(agency, "code_kind") === KIND_STAFF,
      ...detail,
    });
    await sendMail(s_(agency, "email"), mail.subject, mail.body);
  }
}
