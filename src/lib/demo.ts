import "server-only";
import { select } from "./db";
import { todayInJapan } from "./jst";

/**
 * デモ機（App13「VIS端末・デモ機管理」）の読み取り。
 *
 * 登録はデモ機登録フォームから行われ、本部が App13 に反映する。
 * ポータル側は読み取りだけを行う（代理店が自分の保有台数と貸出状況を確認できればよい）。
 *
 * フィールド名は App13 の実物に合わせている。
 * 「製造番号」と呼ばれている項目は、kintone 上のフィールドコードは
 * 製品番号_シリアル。画面では業務で使われている「製造番号」で表示する。
 */

export type DemoMachine = {
  recordId: string;
  /** 保有している代理店のコード */
  holderCode: string;
  /** 保有している代理店の名前 */
  holderName: string;
  /** 申込のときに名乗った会社名（デモ機登録フォームの「自社会社名」） */
  ownerCompany: string;
  /** 製造番号（シリアル） */
  serial: string;
  model: string;
  /** 在庫 / 設置済 / 貸出中 / 返却済 / 故障・修理 / 廃棄 */
  condition: string;
  /** 個人購入 / デモ機購入 / 無料貸与 */
  acquisition: string;
  acquiredOn: string;
  lentTo: string;
  lentOn: string;
  dueOn: string;
  returnedOn: string;
  purpose: string;
  customerName: string;
  /** 該当なし / 転用済 / 未転用 */
  reuseFlag: string;
  note: string;
};

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const inList = (codes: string[]): string =>
  "(" + codes.map((c) => '"' + c.replace(/"/g, '\\"') + '"').join(",") + ")";

function toDemoMachine(r: Row): DemoMachine {
  return {
    recordId: s_(r, "id"),
    holderCode: s_(r, "holder_code"),
    holderName: s_(r, "holder_name"),
    ownerCompany: s_(r, "owner_company"),
    serial: s_(r, "serial_no"),
    model: s_(r, "model"),
    condition: s_(r, "state"),
    acquisition: s_(r, "acquired_kind"),
    acquiredOn: s_(r, "acquired_on"),
    lentTo: s_(r, "lend_to"),
    lentOn: s_(r, "lend_on"),
    dueOn: s_(r, "return_due_on"),
    returnedOn: s_(r, "returned_on"),
    purpose: s_(r, "purpose"),
    customerName: s_(r, "customer_name"),
    reuseFlag: s_(r, "converted"),
    note: s_(r, "note"),
  };
}


/** 取得日の新しい順。取得日が空のものは後ろに回す。 */
function byAcquiredDesc(a: DemoMachine, b: DemoMachine): number {
  if (a.acquiredOn !== b.acquiredOn) {
    if (!a.acquiredOn) return 1;
    if (!b.acquiredOn) return -1;
    return a.acquiredOn < b.acquiredOn ? 1 : -1;
  }
  return Number(b.recordId) - Number(a.recordId);
}

/**
 * 指定した代理店コード（自分＋配下）が保有しているデモ機を返す。
 *
 * コードが多くなってもクエリが壊れないよう 100件ずつに分けて問い合わせ、
 * レコード番号で重複を除いてから並べ直す。
 */
export async function listDemoMachines(codes: string[]): Promise<DemoMachine[]> {
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const rows = await select<Row>(
    `demo_machines?select=*&holder_code=in.${inList(unique)}&order=acquired_on.desc`,
  );
  const found = new Map<string, DemoMachine>();
  for (const r of rows) {
    const m = toDemoMachine(r);
    found.set(m.recordId, m);
  }
  return [...found.values()].sort(byAcquiredDesc);
}

/** 今日の日付を日本時間の "YYYY-MM-DD" で返す。返却予定日の判定に使う。 */
export { todayInJapan };

/** 手元を離れている（返却済・廃棄）扱いかどうか。 */
function isClosed(m: DemoMachine): boolean {
  return m.condition === "返却済" || m.condition === "廃棄";
}

/**
 * 返却予定日を過ぎているか。
 * すでに返却日が入っているもの、返却済・廃棄になっているものは対象外。
 */
export function isOverdue(m: DemoMachine, today: string = todayInJapan()): boolean {
  if (!m.dueOn || m.returnedOn) return false;
  if (isClosed(m)) return false;
  return m.dueOn < today;
}

export type DemoSummary = {
  /** 登録されている全件 */
  total: number;
  /** 手元にある台数（返却済・廃棄を除く） */
  held: number;
  /** 貸出中 */
  onLoan: number;
  /** 故障・修理 */
  inRepair: number;
  /** 返却予定日を過ぎているもの */
  overdue: number;
};

export function summarizeDemoMachines(
  machines: DemoMachine[],
  today: string = todayInJapan(),
): DemoSummary {
  return {
    total: machines.length,
    held: machines.filter((m) => !isClosed(m)).length,
    onLoan: machines.filter((m) => m.condition === "貸出中").length,
    inRepair: machines.filter((m) => m.condition === "故障・修理").length,
    overdue: machines.filter((m) => isOverdue(m, today)).length,
  };
}
