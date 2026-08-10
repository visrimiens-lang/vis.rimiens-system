import "server-only";
import { APP, getRecords, q, str, type KintoneRecord } from "./kintone";

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

const FIELDS = [
  "レコード番号",
  "保有代理店コード",
  "保有代理店名",
  "製品番号_シリアル",
  "機種",
  "端末状態",
  "取得区分",
  "取得日",
  "貸出先",
  "貸出日",
  "返却予定日",
  "返却日",
  "貸与目的",
  "保有顧客名",
  "デモ機転用フラグ",
  "備考",
];

export type DemoMachine = {
  recordId: string;
  /** 保有している代理店のコード */
  holderCode: string;
  /** 保有している代理店の名前 */
  holderName: string;
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

function toDemoMachine(r: KintoneRecord): DemoMachine {
  return {
    recordId: str(r, "レコード番号") || str(r, "$id"),
    holderCode: str(r, "保有代理店コード"),
    holderName: str(r, "保有代理店名"),
    serial: str(r, "製品番号_シリアル"),
    model: str(r, "機種"),
    condition: str(r, "端末状態"),
    acquisition: str(r, "取得区分"),
    acquiredOn: str(r, "取得日"),
    lentTo: str(r, "貸出先"),
    lentOn: str(r, "貸出日"),
    dueOn: str(r, "返却予定日"),
    returnedOn: str(r, "返却日"),
    purpose: str(r, "貸与目的"),
    customerName: str(r, "保有顧客名"),
    reuseFlag: str(r, "デモ機転用フラグ"),
    note: str(r, "備考"),
  };
}

/**
 * App13 からレコードを取る。
 * 項目がまだ揃っていない環境ではフィールド指定が 400 になるため、
 * その場合は全フィールド取得に落として動かし続ける。
 */
async function fetchDemoRecords(query: string): Promise<KintoneRecord[]> {
  try {
    return await getRecords(APP.demo, query, FIELDS);
  } catch {
    return await getRecords(APP.demo, query);
  }
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

  const found = new Map<string, DemoMachine>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const query = `保有代理店コード in (${chunk.map(q).join(", ")}) order by 取得日 desc limit 500`;
    for (const r of await fetchDemoRecords(query)) {
      const machine = toDemoMachine(r);
      found.set(machine.recordId, machine);
    }
  }
  return [...found.values()].sort(byAcquiredDesc);
}

/** 今日の日付を日本時間の "YYYY-MM-DD" で返す。返却予定日の判定に使う。 */
export function todayInJapan(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

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
