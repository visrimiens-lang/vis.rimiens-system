import "server-only";
import { select } from "./db";

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

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const inList = (codes: string[]): string =>
  "(" + codes.map((c) => '"' + c.replace(/"/g, '\\"') + '"').join(",") + ")";

function toLead(r: Row): Lead {
  return {
    recordId: s_(r, "id"),
    customerName: s_(r, "customer_name"),
    phone: s_(r, "phone"),
    referrerCode: s_(r, "referrer_code"),
    status: s_(r, "status"),
    tossedAt: s_(r, "tossed_at"),
    orderNo: s_(r, "order_id"),
    closedAt: s_(r, "closed_on"),
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
  opts: { month?: string; all?: boolean } = {},
): Promise<Lead[]> {
  const targets = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  /*
   * all を付けると紹介元で絞らず全件返す。本部の一覧に使う。
   * kintone のトスアップ台帳（App14）を止めると、本部が
   * 「誰がどのお客様を紹介したか」を見る手段が無くなるため。
   * 代理店側からは絶対に呼ばない（画面側で本部かどうかを見てから渡す）。
   */
  if (!opts.all && targets.length === 0) return [];

  const rows = await select<Row>(
    opts.all
      ? `leads?select=*&order=tossed_at.desc&limit=${LEAD_LIMIT}`
      : `leads?select=*&referrer_code=in.${inList(targets)}&order=tossed_at.desc&limit=${LEAD_LIMIT}`,
  );

  const allowed = new Set(opts.all ? rows.map((r) => String(r["referrer_code"] ?? "")) : targets);
  const leads = rows
    .map(toLead)
    .filter((l) => allowed.has(l.referrerCode))
    .sort((a, b) => b.tossedAt.localeCompare(a.tossedAt));

  return opts.month ? leads.filter((l) => leadMonth(l) === opts.month) : leads;
}
