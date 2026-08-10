import "server-only";
import { APP, getRecords, q, str, type KintoneRecord } from "./kintone";

/**
 * トスアップ（取次店からのお客様紹介）。
 *
 * 取次店が専用フォームに「お客様氏名＋電話番号」を入れると App14 に先行レコードができ、
 * 商談・成約が進むと トスアップステータス が更新され、成約時に受注番号と成約日が入る。
 * 取次店本人は「自分が紹介したお客様が今どうなっているか」しか見られなくてよい（金額は対象外）。
 *
 * App14 の実フィールド（/app/form/fields.json?app=14 で確認）:
 *   レコード番号 / お客様氏名 / 電話番号 / phone_normalized /
 *   取次店コード（ラベルは「紹介元コード（取次店/スタッフ）」）/
 *   トスアップステータス（トスアップ済・商談中・成約・不成立・体験同意・検討中）/
 *   トスアップ日時（日時）/ 受注レコード番号 / 成約日（日付）
 */

/** 1回に取得するトスアップの上限。これを超えた分は画面に出さない。 */
export const LEAD_LIMIT = 500;

/** 成約を表すトスアップステータスの値。 */
export const CLOSED_STATUS = "成約";

const FIELDS = [
  "レコード番号",
  "お客様氏名",
  "電話番号",
  "取次店コード",
  "トスアップステータス",
  "トスアップ日時",
  "受注レコード番号",
  "成約日",
];

export type Lead = {
  recordId: string;
  customerName: string;
  phone: string;
  /** 紹介元（取次店またはスタッフ）のコード */
  referrerCode: string;
  status: string;
  /** kintone の日時。UTC の ISO 文字列でくる。 */
  tossedAt: string;
  /** 成約したときに入る App10 の受注番号 */
  orderNo: string;
  closedAt: string;
};

function toLead(r: KintoneRecord): Lead {
  return {
    recordId: str(r, "レコード番号"),
    customerName: str(r, "お客様氏名"),
    phone: str(r, "電話番号"),
    referrerCode: str(r, "取次店コード"),
    status: str(r, "トスアップステータス"),
    tossedAt: str(r, "トスアップ日時"),
    orderNo: str(r, "受注レコード番号"),
    closedAt: str(r, "成約日"),
  };
}

/**
 * kintone の日時（UTC）を日本時間の "YYYY-MM-DD" にする。
 * 夜のトスアップが前日扱いになると取次店の感覚と合わないため、必ず +9時間してから切る。
 */
export function jstDate(value: string): string {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value.slice(0, 10);
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** トスアップ日の月 "YYYY-MM"（日本時間）。 */
export function leadMonth(lead: Lead): string {
  return jstDate(lead.tossedAt).slice(0, 7);
}

/** 成約したトスアップかどうか。 */
export function isClosed(lead: Lead): boolean {
  return lead.status === CLOSED_STATUS;
}

export type LeadSummary = {
  total: number;
  closed: number;
  /** 成約率（0〜1）。トスアップが0件のときは算出できないので null。 */
  closeRate: number | null;
};

export function summarizeLeads(leads: Lead[]): LeadSummary {
  const closed = leads.filter(isClosed).length;
  return {
    total: leads.length,
    closed,
    closeRate: leads.length === 0 ? null : closed / leads.length,
  };
}

/**
 * 自分（と配下）のトスアップ一覧を、新しい順で返す。
 *
 * codes には見てよい紹介元コードを渡す。取次店なら自分のコードだけ、
 * 2次代理店なら自分＋配下のコードを渡すと、配下の取次店ぶんもまとまって出る。
 * 空配列を渡したときは何も返さない（誤って全件見えないようにするため）。
 */
export async function listLeads(
  codes: string[],
  opts: { month?: string } = {},
): Promise<Lead[]> {
  const targets = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (targets.length === 0) return [];

  const tail = `order by トスアップ日時 desc limit ${LEAD_LIMIT}`;
  const codeCondition = `取次店コード in (${targets.map(q).join(", ")})`;

  let rows: KintoneRecord[];
  try {
    rows = await getRecords(APP.lead, `${codeCondition} ${tail}`, FIELDS);
  } catch {
    // 紹介元コードでの絞り込みが使えない状態でも画面を止めない。
    // 取得しなおしたうえで、見てよいコードかどうかは下でもう一度必ず確かめる。
    rows = await getRecords(APP.lead, tail, FIELDS);
  }

  const allowed = new Set(targets);
  const leads = rows
    .map(toLead)
    .filter((l) => allowed.has(l.referrerCode))
    .sort((a, b) => b.tossedAt.localeCompare(a.tossedAt));

  return opts.month ? leads.filter((l) => leadMonth(l) === opts.month) : leads;
}
