import "server-only";
import { audit, count, insert, remove, select, selectOne, update } from "./db";
import { todayInJapan } from "./jst";
import { usesPortal } from "./labels";
import { OFFICIAL_LINE_URL, QR2_APPROVED, buildQrUrl, tossUpUrl } from "./qr";
import { initialPaymentStatus } from "./payment-status";
import { AREA_QUOTA, DEFAULT_STAFF_LIMIT } from "./slots";
import {
  HQ_MAIL,
  PORTAL_URL,
  acquisitionMail,
  approvalMail,
  licenseTestMail,
  sendMail,
} from "./mail";

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
 * 申込フォームに入力されたコードを、照合できる形にそろえる。
 *
 * 全角で打たれた「ＭＥＮＯ」や小文字の「meno」がそのまま届くことがある。
 * 代理店コードの照合は大文字と小文字を区別するので、そのまま使うと
 * 正しいコードを打ったのに「上位代理店が見つかりません」になってしまう。
 *
 * ※ 大文字小文字を無視する検索（ilike）に変えてはいけない。
 *   ilike は `_` や `%` がワイルドカードとして効くため、
 *   招待コードに `R_M` と打つだけで別の会社の配下として登録が通ってしまう。
 *   入口でそろえて、照合は完全一致のままにする。
 */
/**
 * 個人販売代理店みんなで使う共通の英字（2026-08-20 決定）。
 * 個人は会社名が無く一人ずつ英字を決められないため、皆で同じ英字を使い
 * KVIS0001・KVIS0002 と番号で分かれる。KVIS という会社は存在しない。
 */
export const KOJIN_ORG = "KVIS";

export function normalizeCode(input: string): string {
  return (input || "")
    .normalize("NFKC")   // 全角英数字を半角に
    .replace(/\s+/g, "") // 途中の空白も落とす
    .toUpperCase();
}

/**
 * 統括エリア区分を、代理店マスタが受け付ける言葉にそろえる。
 *
 * 申込フォームの選択肢は末尾に「エリア」が付いている（関東エリア）が、
 * 代理店マスタが受け付けるのは付かない形（関東）だけ。
 * そのまま保存すると入力チェックに弾かれ、登録そのものが失敗する。
 * エリア統括代理店の申込でしか出ない欄なので、
 * 直さないと 60 社の統括が1社も登録できない。
 *
 * 知らない言葉が来たときは空にする。エリアが空でも登録は通り、
 * 本部があとから選び直せる。ここで登録ごと止めるほうが困る。
 */
const AREA_CLASSES = [
  "本部",
  "北海道+東北",
  "関東",
  "中部",
  "関西+近畿",
  "中国+四国",
  "九州+沖縄",
];

export function normalizeArea(input: string): string {
  const raw = (input || "").normalize("NFKC").trim();
  if (!raw) return "";
  // 「関東エリア」→「関東」。全角の＋も半角にそろえる
  const body = raw.replace(/エリア$/, "").replace(/＋/g, "+").trim();
  return AREA_CLASSES.includes(body) ? body : "";
}

/**
 * 組織を表す英字（自社コード）として使える形か確かめる。
 *
 * 申込フォーム側は4文字のマスク（例 目のトレーニング株式会社 → MENO）だが、
 * 先に作った RIM・MET は3文字のまま動いている。
 * どちらも通るように、英字2〜6文字を受け付ける。
 */
export function isOrgCode(code: string): boolean {
  return /^[A-Z]{2,6}$/.test(code);
}

/**
 * 代理店コードの頭につく、組織を表す英字（MENO / RIM など）を取り出す。
 *
 * 上位が RIM0003 でも、配下のコードは組織の英字から始まる。
 * 新しく登録するものは org_code 列を見るので、ここを使うのは
 * org_code がまだ入っていない古い行を読むときだけ。
 */
export function orgPrefixOf(code: string): string {
  const m = /^[A-Za-z]+/.exec(code.trim());
  return m ? m[0].toUpperCase() : normalizeCode(code);
}

/**
 * org_code 列がもう入っているか。
 *
 * 列を足す SQL（supabase/migrations/2026-08-20_org_code.sql）を流す前に
 * この画面が動くことがある。知らない列を指定した書き込みは弾かれるので、
 * 先に一度だけ確かめて、無ければその列を外して書き込む。
 * 一度調べたら覚えておく（毎回問い合わせない）。
 */
let orgCodeColumn: Promise<boolean> | null = null;
export function hasOrgCodeColumn(): Promise<boolean> {
  if (!orgCodeColumn) {
    orgCodeColumn = select<Row>("agencies?select=org_code&limit=1")
      .then(() => true)
      .catch(() => false);
  }
  return orgCodeColumn;
}

let extraColumns: Promise<boolean> | null = null;

/**
 * フリガナ・担当者・インボイスの列（2026-08-25 追加）があるか。
 * SQLを流す前の環境で INSERT に載せると、申込の登録ごと落ちるため、
 * org_code と同じく「列があるときだけ書く」。
 */
export function hasExtraColumns(): Promise<boolean> {
  if (!extraColumns) {
    extraColumns = select<Row>("agencies?select=name_kana&limit=1")
      .then(() => true)
      .catch(() => false);
  }
  return extraColumns;
}

/**
 * その代理店が属する組織の英字を返す。
 *
 * org_code 列を先に見て、まだ入っていない古い行だけコードの頭の英字で補う。
 * 自社コードを決める前から動いている会社（RIM0004 の comvace など）は、
 * 本部が自社コードを設定するまで RIM のままになる。
 */
export function orgOf(agency: Row | null): string {
  const stored = normalizeCode(s_(agency, "org_code"));
  if (stored) return stored;
  return orgPrefixOf(s_(agency, "code"));
}

/**
 * 次の代理店コードを決める。
 *
 * 形は「組織の英字 ＋ 4桁の通し番号」。
 *   MENO + 0001 → MENO0001（目のトレーニング組織の1人目）
 *   ASUE + 0002 → ASUE0002
 *
 * 2026-08-20 の打合せで決まった形に合わせている。それまでは
 * 「組織の英字 ＋ 区分2桁 ＋ 枝番2桁」で、区分ごとに99人までしか採番できなかった。
 * 統括60社ぶんのスタッフが入ると足りなくなるため、区分をコードから外して
 * 通し番号を4桁にした。区分（会社・取次パートナー・スタッフ）はコードの
 * 文字ではなく code_kind 列だけで持つ。
 *
 * 数える相手は org_code 列でそろえる。コードの前方一致で数えると、
 * MET と METO のように英字の長さが違う組織どうしが混ざってしまう。
 *
 * ※ コード自体はどの統括代理店の配下かを表さない。所属は上位代理店コードで持つ。
 */
export async function nextAgencyCode(orgCode: string): Promise<string | null> {
  const org = normalizeCode(orgCode);
  if (!org) return null;

  /*
   * 数え方は、書き込み側（org_code を入れるかどうか）と必ずそろえる。
   *
   * 別々に判定すると、列を足した直後に
   * 「書き込みでは org_code を省くのに、数えるときは org_code で数える」
   * というずれが起きる。数えた側からは前の行が見えないので同じコードを
   * もう一度出してしまい、コードの重複で登録が落ちる。
   * 列がまだ無いときは、コードの前方一致で数える。
   */
  const rows = (await hasOrgCodeColumn())
    ? await select<Row>(`agencies?select=code&org_code=eq.${encodeURIComponent(org)}`)
    : await select<Row>(`agencies?select=code&code=like.${encodeURIComponent(org + "%")}`);

  let max = 0;
  for (const r of rows) {
    const code = s_(r, "code");
    if (!code.startsWith(org)) continue;
    const n = Number(code.slice(org.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  const next = max + 1;
  if (next > 9999) return null;
  return `${org}${String(next).padStart(4, "0")}`;
}

/* ═══════════════════════ 上位代理店を探す ═══════════════════════ */

/**
 * 招待コードから上位代理店を探す。
 *
 * 招待コードは、上位代理店が配る文字列。代理店コードそのものが使われることも多い。
 * 見つからなければ null（本部で手当てが必要）。
 */
export async function resolveParent(inviteCode: string): Promise<Row | null> {
  // 全角・小文字で届いても引けるようにそろえる（normalizeCode の説明を参照）
  const c = normalizeCode(inviteCode);
  if (!c) return null;

  /*
   * まず代理店コードとして探す。
   * 2026-08-20 からは会社の代理店コードが自社コードそのもの（MENO など）に
   * なるため、ふつうはここで見つかる。
   */
  const byCode = await selectOne<Row>(
    `agencies?select=*&code=eq.${encodeURIComponent(c)}`,
  );
  if (byCode) return byCode;

  /*
   * 次に招待コードとして探す。
   * 自社コードを決める前から動いている会社（RIM0004 の comvace など）は
   * 代理店コードが数字混じりのままなので、本部が設定した自社コードを
   * この欄にも入れて引けるようにしている（setOrgCodeAction）。
   */
  /*
   * 会社に限って、古い順に1件だけ引く。
   *
   * 絞り込みと並び順を付けないと、同じ招待コードを持つ行が複数あったとき
   * どれが返るか決まらない。実際 invite_code=RIM の行は7件あり、
   * 何も指定しないと会社の RIM ではなく取次パートナーの RIM0102 が返っていた。
   * 上位を取り違えると、その配下の売上と報酬がまるごと別の相手に付く。
   */
  return selectOne<Row>(
    `agencies?select=*&invite_code=eq.${encodeURIComponent(c)}` +
      `&code_kind=eq.${KIND_COMPANY}&order=id.asc`,
  );
}

/* ═══════════════════════ 登録してよいかの確認 ═══════════════════════ */

/** 上位代理店の下に、この区分の相手を登録してよいか確かめる。 */
export async function canRegisterUnder(
  parent: Row,
  kind: string,
  channel: string,
  /** 申込に入っていたエリア区分。統括代理店のエリア枠（全国60社）を見るのに使う。 */
  areaClass = "",
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

  /*
   * 会社の下に代理店はぶら下げられない（4次以降の禁止）。
   * ただしスタッフは「人」なので、どのランクの会社の下にも登録できる。
   *
   * ここは順番が大事。3次代理店（販売代理店・サロン代理店）はランクが
   * 「取次店」なので、先に取次店を弾くとスタッフの登録が全部はじかれる。
   */
  if (kind !== KIND_STAFF && parentRank === "取次店") {
    return { ok: false, reason: `${s_(parent, "name")} の下に代理店は登録できません。` };
  }

  // 特別枠は上限の対象外
  if (parent["special_slot"] === true) return { ok: true };

  /*
   * 上位が総販売代理店のときは、配下がエリア統括代理店になる。
   * 枠は「スタッフ100名」ではなく、全国60社のエリア枠で見る。
   *
   * ここを見ていなかったため、関東が 15/15 で埋まっていても
   * 申込フォームからは 16 社目が登録できてしまっていた
   * （本部が手で登録すると checkSlotRoom が弾くので、経路で答えが違った）。
   */
  if (s_(parent, "rank") === "総販売代理店" && kind !== KIND_STAFF) {
    const area = normalizeArea(areaClass || "");
    const quota = AREA_QUOTA.find((q) => q.area === area);
    if (quota) {
      const rows = await select<Row>(
        `agencies?select=id,rank,status,area_class,area&rank=eq.${encodeURIComponent("2次代理店")}`,
      );
      const used = rows.filter(
        (a) =>
          s_(a, "status") !== "停止・解約" &&
          normalizeArea(s_(a, "area_class") || s_(a, "area")) === area,
      ).length;
      if (used >= quota.limit) {
        return {
          ok: false,
          reason: `${area}の統括代理店は上限（${quota.limit}社）に達しています。本部での確認が必要です。`,
        };
      }
    }
  }

  /*
   * 枠の空きを見る。
   *
   * 2026-08-22 から枠は「スタッフ100名」の1本になり、
   * 直下にいる稼働中の相手は区分にかかわらず1名ぶん使う。
   * 数え方は画面（lib/slots.ts の consumesSlot）と必ずそろえること。
   * ここだけ古い数え方が残ると「画面では空きがあるのに申込は弾かれる」
   * （またはその逆）という食い違いが起きる。申込は受信箱に
   * needsReview として溜まるだけなので、気づくのが遅れる。
   */
  /*
   * 列がまだ無い／NULL のときは既定（100名）で見る。
   * ここを 0（上限なし）に倒すと、画面が「100 / 100 名・枠が埋まりました」と
   * 出しているのに、申込フォームからの登録だけが素通りして 101 人目が入る。
   * 数え方も既定値も、画面（lib/agencies.ts の toAgency）と必ずそろえること。
   */
  const rawLimit = parent["limit_staff"];
  const limit =
    rawLimit === null || rawLimit === undefined
      ? DEFAULT_STAFF_LIMIT
      : Number(rawLimit) || 0;
  if (limit <= 0) return { ok: true }; // 0 は「上限なし」

  const siblings = await select<Row>(
    `agencies?select=id,status&parent_code=eq.${encodeURIComponent(s_(parent, "code"))}`,
  );
  const used = siblings.filter((a) => s_(a, "status") !== "停止・解約").length;

  if (used >= limit) {
    return {
      ok: false,
      reason: `${s_(parent, "name")} の枠が上限（${limit}名）に達しています。増枠の承認が必要です。`,
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
  /*
   * 新しく1件受け取ったついでに、保存期間を過ぎたものを片付ける。
   * 受信箱が増えるのは受け取ったときだけなので、ここに置けば
   * 定期実行の仕組みを足さなくても保存期間を守れる。
   */
  await purgeInbox();
  return { id: Number(row["id"]), duplicate: false };
}

/** 受信箱に残す日数。これを過ぎた受信記録は消す。 */
export const INBOX_KEEP_DAYS = 7;

/**
 * 古い受信記録を消す。
 *
 * 受信箱は「届いたものが受注・申込になったか」を確かめるための控えで、
 * 確かめ終わったあとまで持っておく必要がない。
 * 中身には氏名・電話・住所がそのまま入っているので、
 * 用が済んだものを溜め続けるのは個人情報の持ちすぎでもある。
 *
 * 取り込めていないものも消す（2026-08-31 の依頼「過ぎたものは削除」）。
 * 取り込めていない＝受注が作られなかった、ではない点に注意。
 * いま残っている7件も受注そのものは登録済みで、
 * 「報酬が立たなかった」という但し書きが付いているだけ。
 * それでも消えるのは警告のほうなので、1週間のうちに受信箱を見て
 * 片付ける運用とセットで使う。
 *
 * 消せなくても業務は止めない（呼び出し元は受注の登録が本番）。
 */
export async function purgeInbox(days = INBOX_KEEP_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const n = await count("inbox", `created_at=lt.${cutoff}`);
    if (n === 0) return 0;
    await remove(`inbox?created_at=lt.${cutoff}`);
    await audit("system", "受信箱の自動削除", { type: "inbox" }, {
      保存日数: days,
      削除件数: n,
      これより前を削除: cutoff,
    });
    return n;
  } catch {
    // 消せなくても、受け取り自体は続ける
    return 0;
  }
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
  /** 会社名フリガナ・担当者・法人番号・インボイス。無いフォームもあるので任意 */
  nameKana?: string;
  contactName?: string;
  corporateNo?: string;
  invoiceStatus?: string;
  invoiceNo?: string;
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
  /**
   * 申込者が自分で決めた組織の英字（自社代理店コード）。半角大文字4文字。
   *
   * 2026-08-20 の打合せで決まった項目。申込フォームでは
   *   ・代理店システム登録 … 「自社代理店コード発行」（input53・必須）
   *   ・取次パートナー登録 … 「代理店招待コード」（input43・必須）＝所属する会社の自社コード
   *   ・ライセンス認定登録 … 「自社コード」（inviteCode・必須）＝所属する会社の自社コード
   * にあたる。会社はこの英字がそのまま代理店コードになり、
   * スタッフ・取次パートナー・個人販売代理店は「英字＋4桁」で採番される。
   */
  orgCode?: string;
  /**
   * 申込フォームの「登録区分」（法人 / 個人）。
   *
   * 個人の方は自社コードを一人ずつ決められないので、全員が同じ英字（KVIS）を
   * 入力する決まりになっている。同じ英字を皆で使うため、
   * 会社のように英字だけのコードにはせず「KVIS＋4桁」で採番する。
   * 代理店種別の選び間違いで英字だけのコードを取ってしまわないよう、
   * ここでも個人かどうかを見る。
   */
  entityType?: string;
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
  /*
   * 種別の欄が無いとき。
   *
   * 2026-08-22 に代理店システム登録フォームが作り替えられ、
   * 「代理店種別」「招待コード」「エリア」の欄がなくなった。
   * このフォームはエリア統括代理店の申込専用になり、上位は総販売代理店で固定。
   * 販売代理店・サロン代理店・個人販売代理店は、このフォームからは入らず、
   * 販売ライセンス認定登録（スタッフ）として登録して、
   * 所属会社と種別をポータル側で設定する運用に変わった。
   *
   * 以前はここで「販売代理店」に倒していたが、いまの申込は必ず統括なので、
   * そのまま通すと上位が決まらず受信箱に取り残される。
   */
  const area = AGENCY_TYPES["エリア統括代理店"];
  return {
    kind: KIND_COMPANY,
    rank: area.rank,
    channel: area.channel,
    parentFixed: area.parentFixed,
  };
}

/**
 * すでに登録されている同じ人を探す。
 *
 * 販売ライセンス認定登録は、これから登録する人だけでなく、
 * すでに個人販売代理店として登録済みの人からも届く
 * （個人販売代理店の方がライセンスを取った場合）。
 * そのまま流すと同じ人が2件になり、QRも報酬の付け先も二重になる。
 *
 * お名前が同じで、メールアドレスが一致すれば同一人物として扱う。
 * 解約済みは除く（同じ名前の別の方が入り直すことがあるため）。
 */
async function findSamePerson(name: string, email: string): Promise<Row | null> {
  const nm = (name || "").replace(/[\s\u3000]/g, "");
  const mail = (email || "").trim().toLowerCase();
  if (!nm || !mail) return null;
  /*
   * QRの列も一緒に引く。ensureQrAndGuide がこの行で凍結（QR停止中）を
   * 見分けるため。列が足りないと停止の目印が読めず、
   * 本部が止めたQRを再登録が黙って復活させてしまう。
   */
  const rows = await select<Row>(
    `agencies?select=code,name,status,code_kind,qr1_url,qr2_url,qr2_status,qr2_rejected_note` +
      `&email=eq.${encodeURIComponent(mail)}`,
  );
  return (
    rows.find(
      (r) =>
        s_(r, "name").replace(/[\s\u3000]/g, "") === nm && s_(r, "status") !== "停止・解約",
    ) ?? null
  );
}

/**
 * すでにいる相手に、お客様へのご案内（QR1・QR2）をお渡しする。
 *
 * 未発行なら発行してから、案内のメールを送る。
 * 取次パートナー（区分01）には個別のQRを出さない決まりなので発行しない。
 * QRを停止している相手は、止めたURLが戻ってしまうので触らない。
 */
async function ensureQrAndGuide(row: Row): Promise<string> {
  const code = s_(row, "code");
  if (!code) return "";
  const frozen =
    s_(row, "qr2_status") === "差戻し" && s_(row, "qr2_rejected_note").startsWith("【QR停止】");
  if (frozen) return "（QRを停止中のため、ご案内はお送りしていません）";

  const withQr = s_(row, "code_kind") !== KIND_REFERRER;
  const patch: Record<string, unknown> = {};
  if (withQr && !s_(row, "qr1_url")) patch.qr1_url = buildQrUrl("qr1", code);
  if (withQr && !s_(row, "qr2_url")) patch.qr2_url = buildQrUrl("qr2", code);
  if (withQr && s_(row, "qr2_status") !== QR2_APPROVED) patch.qr2_status = QR2_APPROVED;

  try {
    if (Object.keys(patch).length > 0) {
      await update(`agencies?code=eq.${encodeURIComponent(code)}`, patch);
    }
    const fresh = await selectOne<Row>(
      `agencies?select=*&code=eq.${encodeURIComponent(code)}`,
    );
    const to = s_(fresh, "email");
    if (!to) return "（メールアドレスが未登録のため、ご案内はお送りしていません）";
    const kindOfRow = s_(fresh, "code_kind");
    const mail = approvalMail({
      name: s_(fresh, "name") || code,
      code,
      kind:
        kindOfRow === KIND_STAFF ? "スタッフ"
        : kindOfRow === KIND_REFERRER ? "取次パートナー"
        : "会社",
      usesPortal: usesPortal(s_(fresh, "rank"), kindOfRow),
      portalUrl: PORTAL_URL,
      passwordIssued: Boolean(s_(fresh, "portal_password")),
      qr1Url: s_(fresh, "qr1_url") || undefined,
      qr2Url: s_(fresh, "qr2_url") || undefined,
      lineQrUrl: kindOfRow === KIND_REFERRER ? OFFICIAL_LINE_URL : undefined,
      tossFormUrl: kindOfRow === KIND_REFERRER ? tossUpUrl(code) || undefined : undefined,
    });
    const sent = await sendMail(to, mail.subject, mail.body);
    if (!sent.ok) {
      return "（ご案内のメールは送れませんでした。代理店管理から送り直してください）";
    }
    await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
      guide_mailed_at: new Date().toISOString(),
    });
    return "お客様へのご案内（QR）をメールでお送りしました。";
  } catch {
    // 送れなくても、受け止めたこと自体は成立させる
    return "（ご案内のメールは送れませんでした。代理店管理から送り直してください）";
  }
}

/**
 * 申込から代理店を登録する。
 *
 * 2026-08-21 に承認フローを廃止した。登録した時点で「稼働中」になり、
 * 案内のメールもその場で送る（研修の合否は待たない）。
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

  /*
   * 販売ライセンス認定登録は、すでに登録済みの方からも届く。
   * 実際、個人販売代理店として KVIS0002 で登録済みの方が、
   * 自社コードに「KVIS」と入れてこのフォームを出したことがあった
   * （KVIS は個人販売代理店みんなの共通コードで、会社としては存在しない）。
   * 同じ人をもう1件作らず、登録済みとして受け止める。
   */
  if (kind === KIND_STAFF) {
    const same = await findSamePerson(name, app.email || "");
    if (same) {
      const code = s_(same, "code");
      /*
       * すでに登録済みでも、お客様へのご案内（QR1・QR2）はお渡しする。
       * 未発行なら発行して、案内のメールをあらためてお送りする。
       */
      const mailed = await ensureQrAndGuide(same);
      return {
        ok: true,
        code,
        message:
          `${name} さんは ${code} として登録済みです。販売ライセンス認定の登録として受け付けました。` +
          mailed,
      };
    }
  }
  // 申込フォームが販路種別を直接送ってきていればそれを優先する
  const channel = app.channel || decided.channel;

  /*
   * 「会社そのものの申込」か「会社に属する人の申込」かで、
   * 上位の探し方もコードの決め方も変わる。
   *   スタッフ（ライセンス認定登録）と取次パートナー … 会社に属する人
   *   それ以外                                   … 会社そのもの
   */
  const isMember = kind === KIND_STAFF || kind === KIND_REFERRER;

  /*
   * 上位代理店を決める。
   *
   * エリア統括代理店は上位が Rimiens で固定なので、申込フォームに招待コードの欄が無い
   * （JotForm③の仕様どおり）。招待コードを必須にしていたため、
   * これから募集する統括代理店の申込が1件も登録できない状態だった。
   *
   * スタッフ登録（ライセンス認定登録）と取次パートナー登録は、2026-08-20 の
   * 打合せで招待コードの欄をなくし、代わりに所属する会社の自社コードだけを
   * 入力する形になった。どちらも「その会社を指す文字」なので同じ探し方でよい。
   */
  const belongsTo = isMember ? app.orgCode || app.inviteCode : app.inviteCode;

  /*
   * エリア統括代理店は上位が総販売代理店（RIM）で固定という決まりだが、
   * 入力された招待コードを黙って捨ててはいけない。
   *
   * 実際、招待コードに「AAAA」と打った申込がそのまま RIM の配下として
   * 登録されたことがあった。打ち間違いに誰も気づけないまま、
   * 別の系統に代理店が1社ぶら下がることになる。
   *
   * 入っていれば必ずその会社を探し、見つからなければ登録せず本部に知らせる。
   * 空のときだけ、決まりどおり RIM を上位にする。
   */
  const wantsFixed = Boolean(decided.parentFixed) && !normalizeCode(app.inviteCode);
  const parent = wantsFixed
    ? await agencyByCode(decided.parentFixed as string)
    : await resolveParent(belongsTo);

  if (!parent) {
    return {
      ok: false,
      needsReview: true,
      message: wantsFixed
        ? `上位となる代理店（${decided.parentFixed}）が見つかりませんでした。本部での確認が必要です。`
        : isMember
          ? normalizeCode(belongsTo) === KOJIN_ORG
            ? `自社コード「${KOJIN_ORG}」は個人販売代理店みんなの共通コードで、会社としては登録されていません。所属先の代理店コード（例 SASA）を入れ直してもらうか、ご本人がすでに個人販売代理店として登録済みであれば、そのままで結構です。`
            : `自社コード「${belongsTo || "（未入力）"}」に合う代理店が見つかりませんでした。入力された文字が合っているか、その会社が登録済みかをご確認ください。`
          : `招待コード「${app.inviteCode || "（未入力）"}」に合う上位代理店が見つかりませんでした。本部での確認が必要です。`,
    };
  }

  const allowed = await canRegisterUnder(parent, kind, channel, app.areaClass || "");
  if (!allowed.ok) return { ok: false, needsReview: true, message: allowed.reason };

  /*
   * 個人販売代理店かどうか。販路種別と登録区分（法人／個人）の両方で見る。
   * コードの決め方と、英字だけのコードを取らせない判定の両方で使う。
   */
  const isIndividual =
    channel === "個人販売パートナー" || (app.entityType || "").includes("個人");

  /*
   * 組織の英字（自社コード）を決める。
   *
   *   会社の申込          … 申込者が入力した自社代理店コードが、その会社の組織になる
   *   個人販売代理店       … 全員 KVIS で固定（2026-08-20 決定）。
   *                        個人は会社名が無く一人ずつ英字を決められないため、
   *                        皆で同じ英字を使い KVIS0001・KVIS0002 と番号で分かれる。
   *                        欄に別の文字を打っても KVIS に直す。誰の配下かはコードではなく
   *                        招待コードで決まった上位（parent_code）で持つので、困らない。
   *   スタッフ・取次パートナー … 所属する会社の組織を引き継ぐ
   *
   * 会社が自社コードを入れずに申し込んだとき（欄を必須にする前の申込や、
   * 本部の代理入力）は、上位の組織をそのまま引き継いで従来どおり採番する。
   */
  const orgCode = isMember
    ? orgOf(parent)
    : isIndividual
      ? KOJIN_ORG
      : normalizeCode(app.orgCode || "") || orgOf(parent);

  if (!isOrgCode(orgCode)) {
    return {
      ok: false,
      needsReview: true,
      message:
        `自社代理店コード「${app.orgCode || "（未入力）"}」は使えません。` +
        "半角大文字のアルファベット4文字（例 MENO）でご入力ください。",
    };
  }

  /*
   * 代理店コードを決める。
   *
   *   会社              … 自社コードそのもの（MENO・ASUE）。RIM・MET と同じ形。
   *   個人販売代理店      … 自社コードを皆で共有するため「英字＋4桁」（KVIS0001）
   *   スタッフ・取次パートナー … 所属する会社の「英字＋4桁」
   */
  const wantsBareCode = kind === KIND_COMPANY && !isIndividual;

  /*
   * 会社の申込で自社コードが入っていないときは登録しない。
   *
   * 入っていないと上位の組織をそのまま引き継ぐため、エリア統括の申込では
   * Rimiens 自身の英字（RIMI）が代理店コードとして取られてしまう。
   * 1社目は登録できてしまい、2社目から「RIMI はすでに使っています」で
   * 止まるので、気づいたときには親子関係が壊れている。
   * 自社コードの欄が無い古い申込フォームが残っているため、ここで受け止める。
   */
  if (wantsBareCode && !normalizeCode(app.orgCode || "")) {
    return {
      ok: false,
      needsReview: true,
      message:
        "自社代理店コード（半角大文字4文字）が入っていません。" +
        "申込フォームに欄が無い場合は、本部で4文字を決めて代理店管理から登録してください。",
    };
  }

  let code: string | null = orgCode;

  if (wantsBareCode) {
    const taken = await agencyByCode(orgCode);
    if (taken) {
      return {
        ok: false,
        needsReview: true,
        message:
          `自社代理店コード「${orgCode}」は ${s_(taken, "name")} がすでに使っています。` +
          "別の4文字を決めていただくよう、本部からご連絡してください。",
      };
    }
  } else {
    code = await nextAgencyCode(orgCode);
    if (!code) {
      return {
        ok: false,
        needsReview: true,
        message: `${orgCode} の連番が上限（9999）に達しました。本部で採番してください。`,
      };
    }
  }

  /*
   * お客様へのご案内（QR1・QR2）は、登録した時点でお渡しする。
   *
   * 2026-08-21 決定：ご契約のご案内（QR2）に研修の合格も本部の承認も要らない。
   * 以前は研修に合格するまで出せなかったため、登録のご案内が届いても
   * 肝心のQR2が空欄のまま、本部が発行するのを待つことになっていた。
   *
   * 取次パートナー（区分01）には個別のQRを出さない決まりなので、ここでも作らない
   * （共通の公式LINEとご紹介フォームをメールでご案内する）。
   */
  const withQr = kind !== KIND_REFERRER;
  const qr1Url = withQr ? buildQrUrl("qr1", code) : "";
  const qr2Url = withQr ? buildQrUrl("qr2", code) : "";

  await insert("agencies", [
    {
      code,
      name,
      rep_name: app.repName || null,
      ...((await hasExtraColumns())
        ? {
            name_kana: (app.nameKana || "").trim() || null,
            contact_name: (app.contactName || "").trim() || null,
            corporate_no: (app.corporateNo || "").trim() || null,
            invoice_status: (app.invoiceStatus || "").trim() || null,
            invoice_no: (app.invoiceNo || "").trim() || null,
          }
        : {}),
      rank,
      channel,
      code_kind: kind,
      // その代理店が属する組織の英字。採番はこの列で数える。
      ...((await hasOrgCodeColumn()) ? { org_code: orgCode } : {}),
      branch_no: Number(code.slice(orgCode.length)) || null,
      parent_code: s_(parent, "code"),
      parent_name: s_(parent, "name"),
      /*
       * ゼロ次（総販売代理店）は、上位に入っていればそれを引き継ぐ。
       *
       * 入っていないときは、実在することが確かな総販売代理店（RIM）を入れる。
       * 以前はここでコードの頭の英字を使っていたが、
       * 2026-08-20 から会社ごとに英字が変わる（comvace なら COMV）ため、
       * その英字を0次コードにすると実在しない代理店を指してしまい、
       * 総販売代理店への 77,000 円が計上されないまま処理が正常終了してしまう。
       * エラーも警告も出ないので、月次の支払いを突き合わせるまで気づけない。
       */
      zeroth_code:
        s_(parent, "zeroth_code") ||
        (s_(parent, "rank") === "総販売代理店" ? s_(parent, "code") : ZEROTH_CODE),
      /*
       * 会社は自分の自社コードを招待コード欄にも入れておく。
       * 配下の3次代理店・取次パートナー・スタッフが自社コードで申し込んだとき、
       * 代理店コードが数字混じりの会社でもここから引けるようにするため。
       */
      /*
       * 招待コード欄は「この代理店が配る文字」として使う。
       *
       * ここに「自分が入る時に使った上位の文字」を入れてはいけない。
       * 上位を探すとき（resolveParent）はこの列を完全一致で引くので、
       * 同じ文字を持つ行が複数できると、会社ではなく配下の個人や
       * 取次パートナーが上位として選ばれてしまう。
       * 誰の配下かは parent_code 列で持っているので、ここには残さない。
       */
      invite_code: wantsBareCode ? orgCode : null,
      area_class: normalizeArea(app.areaClass || "") || null,
      /*
       * 申込フォームから届いたものは、その時点で稼働中にする。
       *
       * どのフォームも、実世界の関門を通ったあとに入力する決まりになっている
       * （会社は業務委託契約を結んだあと、スタッフは研修を受けたあと）。
       * 画面上でもう一度承認を挟むと、本部が押すまで代理店が
       * 自分のコードもポータルのURLも受け取れないまま止まる。
       *
       * 本部が電話やFAXの申込を手で登録するときは「未稼働」のままで、
       * 内容を確かめてから稼働中にする（createAgencyAction）。
       */
      status: "稼働中",
      // 登録と同時にお渡しするご案内。承認の状態も「承認済」で入れておく
      // （QRの停止は、この列を「差戻し」に変えて表す仕組みのため）。
      ...(withQr ? { qr1_url: qr1Url, qr2_url: qr2Url, qr2_status: QR2_APPROVED } : {}),
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
    稼働状況: "稼働中（申込フォーム経由のため自動）",
  });

  /*
   * 届いた時点でご案内を送る。研修の合否は待たない。
   *
   * これまで案内メールは本部が稼働中に切り替えたときだけ送られていた。
   * 承認の操作をなくしたので、ここで送らないと
   * 代理店・スタッフが自分のコードもポータルのURLも受け取れない。
   *
   * ご契約のご案内（QR2）は研修の合格が要るため、この時点では載らない。
   * 合格して発行したあとに、本部が「案内メールを送り直す」で改めて届けられる。
   *
   * パスワードはまだ発行していないので、その旨だけ伝える
   * （発行は本部が代理店管理から行い、1度だけ画面に出る決まり）。
   * 送れなくても登録は成立させる。届かないことは記録で分かる。
   */
  if (app.email) {
    try {
      const mail = approvalMail({
        name,
        code,
        kind:
          kind === KIND_STAFF ? "スタッフ"
          : kind === KIND_REFERRER ? "取次パートナー"
          : "会社",
        // マイページを使うのはエリア統括代理店と総販売代理店だけ（2026-08-21 決定）
        usesPortal: usesPortal(rank, kind),
        portalUrl: PORTAL_URL,
        passwordIssued: false,
        // 登録と同時に発行したご案内。取次パートナーには個別QRを出さない
        qr1Url: qr1Url || undefined,
        qr2Url: qr2Url || undefined,
        lineQrUrl: kind === KIND_REFERRER ? OFFICIAL_LINE_URL : undefined,
        tossFormUrl: kind === KIND_REFERRER ? tossUpUrl(code) || undefined : undefined,
      });
      const sent = await sendMail(app.email, mail.subject, mail.body);
      /*
       * 送信の記録は、実際に送れたときだけ残す。
       * sendMail は失敗しても例外を投げず {ok:false} を返すので、
       * 戻り値を見ずに記録すると、SMTP障害の間に届いた登録が
       * 「送信済み」の顔をしたまま残り、送り直しの導線でも
       * 「すでにお送りしています」と誤って案内されてしまう。
       */
      if (sent.ok) {
        await update(`agencies?code=eq.${encodeURIComponent(code)}`, {
          guide_mailed_at: new Date().toISOString(),
        });
      }
    } catch {
      // 送れなくても登録は成立させる
    }
  }

  return {
    ok: true,
    code,
    message: `${name} を ${code} として登録しました。ご案内のメールをお送りしています。`,
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

/**
 * 代理店マスタを1件引く。
 *
 * 受注の ?ref= は、QRを読んだ端末やお客様の手入力を経由して届くので、
 * 小文字や全角が混じることがある（asue0001・ＡＳＵＥ０００１）。
 * 招待コードと同じようにそろえてから引く。
 * ここでそろえないと、コードは正しいのに代理店が見つからず、
 * 売上の付け先が空のまま受注だけが積み上がる。
 */
async function agencyByCode(code: string): Promise<Row | null> {
  const c = normalizeCode(code);
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
  // 届いたコードを、代理店マスタと同じ表記にそろえる（agencyByCode の説明を参照）
  const out: SalesAttribution = {
    agencyCode: normalizeCode(rawAgencyCode),
    staffCode: normalizeCode(rawStaffCode),
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
      /*
       * ゼロ次が空なら、実在することが確かな総販売代理店（RIM）で補う。
       * ここでコードの頭の英字を使うと、会社ごとに英字が変わる新しい体系では
       * 実在しない代理店（COMV など）を指してしまい、
       * 総販売代理店の 77,000 円が黙って計上されなくなる。
       */
      out.zerothCode =
        s_(seller, "zeroth_code") ||
        (s_(seller, "rank") === "総販売代理店" ? s_(seller, "code") : ZEROTH_CODE);
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
  /** 顧客台帳の決済方法。本部の顧客管理で「銀行振込／クレジットカード／アプラス」を出すのに使う。 */
  paymentMethod?: string;
  /**
   * ご契約日。受注日をそのまま入れる。
   * 入れていなかったため、QR2 から入ったお客様は顧客管理の
   * 「ご契約日」が空のままだった（2026-08-31）。
   */
  contractedOn?: string;
}): Promise<number | null> {
  const name = (app.name || "").trim();
  if (!name) return null;

  const normalized = normalizePhone(app.phone ?? "");

  /*
   * 同じ方かどうかは「電話番号 ＋ お名前」で見る。
   *
   * 以前は電話番号だけで突き合わせていたため、会社の代表番号のように
   * 複数の方が同じ番号を使っていると、別の方が1人にまとめられていた。
   * 実際、石嶋秋人 様のご注文が松本人志 様の台帳に吸い込まれ、
   * 顧客管理にお名前が出てこなかった（2026-08-31）。
   *
   * お名前は、空白の入れ方だけが違うことがあるので詰めて比べる。
   * 同じ番号でお名前が違えば、別の方として新しく台帳を作る。
   */
  /*
   * ご注文ごとに台帳を1件作る。前のお客様を探して1つにまとめることはしない。
   *
   * 台帳は製造番号・保証・1年後の定期パッドをそれぞれ持つので、
   * 2台お買い上げなら2件あるのが正しい。
   * まとめていたころは、2台目のご注文が1台目の台帳に吸い込まれ、
   * 顧客管理に出てこなかった（2026-08-31）。
   */
  const found: Row | null = null;

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
    if (app.paymentMethod) patch["payment_method"] = app.paymentMethod;
    // ご契約日は「入っていなければ入れる」。最初のご契約の日を残したいため。
    if (app.contractedOn && !s_(found, "contracted_on")) {
      patch["contracted_on"] = app.contractedOn;
    }
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
      ...(app.paymentMethod ? { payment_method: app.paymentMethod } : {}),
      ...(app.contractedOn ? { contracted_on: app.contractedOn } : {}),
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
/**
 * 決済方法を、保存先が受け付ける言葉にそろえる。
 *
 * 保存先（orders.payment_method）は決まった言葉しか受け付けない。
 * UTAGE 側の呼び方が少し違うだけで（「銀行振込」「クレジットカード」など）
 * 受注の登録ごと失敗してしまうのは困るので、ここで読み替える。
 * どれにも当てはまらない言葉は null にして受注は必ず残し、
 * 元の言葉は備考で追えるように呼び出し側へ返す。
 */
const PAYMENT_METHODS = ["九州信販", "アプラス", "ライフカード", "Stripe", "スクエア", "代引き", "振込"] as const;
function normalizePaymentMethod(raw: string): { value: string | null; raw: string } {
  const t = (raw || "").trim();
  if (!t) return { value: null, raw: "" };
  const table: Record<string, string> = {
    "stripe": "Stripe", "クレジットカード": "Stripe", "クレジット": "Stripe", "カード": "Stripe",
    "square": "スクエア", "スクエア": "スクエア",
    "銀行振込": "振込", "振り込み": "振込", "お振込": "振込", "振込み": "振込",
    "代金引換": "代引き", "代引": "代引き",
  };
  const hit = (PAYMENT_METHODS as readonly string[]).find((m) => m === t) ?? table[t.toLowerCase()] ?? table[t];
  return { value: hit ?? null, raw: t };
}

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
    /*
     * 5分以内の同じ内容は、通知の二度届きとみなして前の受注を返す。
     * 名前と金額だけで見ると同姓同名の別人まで巻き込むので、
     * 電話番号が分かるときはそれも一致条件に足す。
     *
     * 受注にはメールアドレスの列が無い（連絡先の本体は顧客台帳）。
     * 以前ここでメールアドレスを条件にしていて、メール付きの通知が
     * 全部この場所で失敗していた。再送は同じ内容がそのまま届くので、
     * 電話番号の完全一致で十分見分けられる。
     */
    const phone5 = (app.phone || "").trim();
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recent = await selectOne<Row>(
      `orders?select=id,amount&customer_name=eq.${encodeURIComponent(name)}` +
        `&amount=eq.${Number(app.amount ?? 0)}` +
        (phone5 ? `&phone=eq.${encodeURIComponent(phone5)}` : "") +
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
    /*
     * 24時間以内に同じ連絡先・同額の受注があっても、そのまま登録する。
     *
     * 以前はここで「二重届きかもしれない」と受信箱に但し書きを残していた。
     * ただ同じ方が続けて2台買うことも普通にあり、機械では見分けられない。
     * 2件のご注文は2件のまま残す、という運用に決めた（2026-08-31）。
     *
     * 通知が本当に二度届いた場合は2件立つ。5分以内の再送は上で弾いているので、
     * 残るのは時間を空けた再送だけ。受注一覧で気づいたらキャンセルにする。
     */
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
      // 保存先が受け付ける言葉に読み替える。読めない言葉でも受注は必ず残す。
      payment_method: normalizePaymentMethod(app.paymentMethod ?? "").value,
      agency_code: agencyCode || null,
      staff_code: staffCode || null,
      niji_code: nijiCode || null,
      zeroth_code: zerothCode || null,
      referrer_code: referrerCode || null,
      match_status: matchStatus,
      stripe_payment_id: app.stripePaymentId || null,
      ship_status: "出荷待ち",
      // 決済方法が読み替えられなかったときは、元の言葉を備考に残して本部が直せるようにする
      ...(app.paymentMethod && !normalizePaymentMethod(app.paymentMethod).value
        ? { note: `決済方法「${app.paymentMethod}」を読み取れなかったため空欄にしています。本部で確認してください。` }
        : {}),
    },
  ]);

  // 受注が残ったので、お客様を顧客台帳に結びつける。
  // ここで失敗しても受注は消さない（進み具合の表示が出ないだけで、売上と報酬は残る）。
  // お支払いの初期値。orders.payment_status の列がまだ無くても受注は残す。
  try {
    await update(`orders?id=eq.${encodeURIComponent(String(order["id"]))}`, {
      payment_status: initialPaymentStatus(normalizePaymentMethod(app.paymentMethod ?? "").value),
    });
  } catch {
    // 列がまだ無い。supabase/migrations の payment_status を流すと入り始める。
  }

  let customerId: number | null = null;
  try {
    /*
     * お客様側のお支払い状況も受注と同じ初期値にする（2026-08-27）。
     * 銀行振込・アプラスは着金までお金が動いていないので「着金待ち」。
     * 本部が受注詳細で決済完了にすると、こちらにも写る。
     *
     * customers.payment_status には許可する値の決まりがあり、
     * 「着金待ち」はマイグレーション（2026-08-27_order_payment_status.sql）を
     * 流すまで弾かれる。そのせいでお客様の紐づけごと失敗すると、
     * 顧客一覧に出ない受注が生まれるので、弾かれたら従来の「決済完了」で
     * 登録し直す（お支払いの実態は受注側のステータスで追える）。
     */
    const link = (paymentStatus: string) =>
      linkCustomer({
        name,
        phone: app.phone,
        email: app.email,
        zip: app.zip,
        address: app.address,
        building: app.building,
        agencyCode,
        staffCode,
        referrerCode,
        paymentStatus,
        paymentMethod: normalizePaymentMethod(app.paymentMethod ?? "").value ?? undefined,
        contractedOn: todayInJapan(),
      });
    const initialPay = initialPaymentStatus(
      normalizePaymentMethod(app.paymentMethod ?? "").value,
    );
    try {
      customerId = await link(initialPay);
    } catch (e) {
      if (initialPay === "決済完了") throw e;
      customerId = await link("決済完了");
    }
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
        closed_on: todayInJapan(),
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
      /*
       * どちらが原因かは、ここで分かる。
       * 「両方をご確認ください」とだけ返していたので、本部が毎回2つとも
       * 調べ直すことになっていた（実際は代理店コードが空なだけ、という
       * 受注が7件たまっていた・2026-08-26）。
       */
      const noOwner = ![agencyCode, nijiCode, referrerCode, staffCode].some((c) =>
        (c || "").trim(),
      );
      trouble = noOwner
        ? "報酬が1件も計上されませんでした。この受注には代理店コードが入っていません" +
          "（お客様が代理店の紹介URLを通らずにお申し込みになった場合に起こります）。" +
          "受注一覧からこの受注を開き、担当の代理店を割り当ててください。"
        : "報酬が1件も計上されませんでした。商品名が商品マスタに見つかりません。" +
          `（受注の商品名：${app.productName || "（空）"}）` +
          "商品マスタに登録するか、受注の商品名をご確認ください。";
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
    message: `${name} 様のご注文を登録しました。${trouble ? ` ${trouble}` : ""}${
      ""
    }`,
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
  /**
   * 申込者が名乗った会社名（デモ機登録フォームの「自社会社名」）。
   * 保有代理店の名前とは別物で、エリア統括や個人販売代理店のように
   * 自分のコードを持たない申込では、ここにしか名前が残らない。
   */
  ownerCompany?: string;
  purpose?: string;
  note?: string;
};

export async function registerDemoMachine(app: DemoApplication): Promise<IntakeResult> {
  const serial = (app.serialNo || "").trim();
  if (!serial) return { ok: false, message: "製品番号（シリアル）が入っていません。" };

  /*
   * 同じ製品番号がすでにあったとき。
   *
   * 同じ代理店から同じ番号が届くのは、フォームの再送か本人の出し直しなので、
   * これまでどおり黙って通す。
   *
   * ところが別の代理店から届いたぶんまで「登録済み」で成功として返しており、
   * 受信箱には取り込めた扱いで残っていた。実際 2026-08-27 の
   * 「個人代理店キャプテン（CAPE）」の申込は、前日に SASA が出した
   * VIS0000-0000 とぶつかって捨てられたのに、本部の受信箱からは
   * 取り込めたようにしか見えず、デモ機一覧にも出てこなかった。
   *
   * 番号の打ち間違いなのか、本当に別の機体で番号を取り違えているのかは
   * 本部でないと分からない。勝手に上書きも二重登録もせず、
   * 取り込まずに理由を添えて受信箱へ残す。
   */
  const dup = await selectOne<Row>(
    `demo_machines?select=id,holder_code,holder_name&serial_no=eq.${encodeURIComponent(serial)}`,
  );
  if (dup) {
    const incoming = (app.holderCode || "").trim();
    const existing = s_(dup, "holder_code").trim();
    if (!incoming || !existing || incoming === existing) {
      return { ok: true, code: serial, message: "この製品番号は登録済みです。" };
    }
    const owner = s_(dup, "holder_name").trim() || existing;
    return {
      ok: false,
      message:
        `製品番号 ${serial} は、すでに ${owner}（${existing}）のデモ機として登録されています。` +
        `${incoming} からの申込は取り込んでいません。` +
        `製品番号の打ち間違いか、どちらの代理店の機体かをご確認ください。`,
    };
  }

  // 保有代理店の名前を補う
  let holderName = app.holderName || "";
  if (app.holderCode && !holderName) {
    const owner = await selectOne<Row>(
      `agencies?select=name&code=eq.${encodeURIComponent(app.holderCode.trim())}`,
    );
    holderName = s_(owner, "name");
  }

  // フォーム(261833737598069)の選択肢は「スターターセットとして購入」
  // 「個人購入製品をデモ機として登録」。旧kintoneの3値も受けられるよう残す。
  const kinds = [
    "個人購入",
    "デモ機購入",
    "無料貸与",
    "スターターセットとして購入",
    "個人購入製品をデモ機として登録",
  ];
  await insert("demo_machines", [
    {
      serial_no: serial,
      model: app.model || "VIS本体",
      acquired_kind: kinds.includes(app.acquiredKind ?? "") ? app.acquiredKind : null,
      acquired_on: app.acquiredOn || null,
      state: "在庫",
      holder_code: app.holderCode || null,
      holder_name: holderName || null,
      owner_company: app.ownerCompany || null,
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
      `agencies?select=name,email,code_kind,rank&code=eq.${encodeURIComponent(code)}`,
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
      // マイページを使うのはエリア統括・総販売代理店だけ（2026-08-21 決定）
      usesPortal: usesPortal(s_(agency, "rank"), s_(agency, "code_kind")),
      ...detail,
    });
    await sendMail(s_(agency, "email"), mail.subject, mail.body);
  }
}
