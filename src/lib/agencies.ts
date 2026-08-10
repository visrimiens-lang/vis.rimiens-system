import "server-only";
import { APP, getRecords, num, q, str, updateRecord, type KintoneRecord } from "./kintone";
import type { Agency, AgencyRank, CodeKind, OrgNode, SalesChannel } from "./types";

const FIELDS = [
  "$id",
  "レコード番号",
  "代理店コード",
  "法人名または氏名",
  "代表者名",
  "代理店ランク",
  "販路種別",
  "コード区分",
  "上位代理店コード",
  "上位代理店",
  "エリア区分",
  "メールアドレス",
  "電話番号",
  "稼働ステータス",
  "販売代理店枠上限",
  "サロン代理店枠上限",
  "個人代理店枠上限",
  "取次店枠上限",
  "登録済件数",
  "増枠申請ステータス",
  "特別枠フラグ",
  "登録経路",
  "作成日時",
  "紹介URL_QR1",
  "紹介URL_QR2",
];

/** 枠の既定値。App9 側が未設定でもこの値で扱う。 */
export const DEFAULT_SLOT_LIMIT = 10;

function toAgency(r: KintoneRecord): Agency {
  return {
    recordId: str(r, "レコード番号") || str(r, "$id"),
    code: str(r, "代理店コード"),
    name: str(r, "法人名または氏名"),
    representative: str(r, "代表者名"),
    rank: (str(r, "代理店ランク") || "") as AgencyRank | "",
    channel: (str(r, "販路種別") || "") as SalesChannel | "",
    codeKind: (str(r, "コード区分") || "") as CodeKind,
    parentCode: str(r, "上位代理店コード"),
    parentName: str(r, "上位代理店"),
    area: str(r, "エリア区分"),
    email: str(r, "メールアドレス"),
    phone: str(r, "電話番号"),
    status: str(r, "稼働ステータス"),
    slotLimit: num(r, "販売代理店枠上限") || DEFAULT_SLOT_LIMIT,
    slotLimits: {
      販売代理店枠上限: num(r, "販売代理店枠上限") || 0,
      サロン代理店枠上限: num(r, "サロン代理店枠上限") || 0,
      個人代理店枠上限: num(r, "個人代理店枠上限") || 0,
      取次店枠上限: num(r, "取次店枠上限") || 0,
    },
    slotUsed: num(r, "登録済件数"),
    slotRequestStatus: str(r, "増枠申請ステータス") || "なし",
    specialSlot: str(r, "特別枠フラグ") === "特別枠",
    registeredVia: str(r, "登録経路"),
    createdAt: str(r, "作成日時"),
    qr1Url: str(r, "紹介URL_QR1"),
    qr2Url: str(r, "紹介URL_QR2"),
  };
}


/**
 * App9 からレコードを取る。
 * 枠フィールドがまだ作られていない環境ではフィールド指定が 400 になるため、
 * その場合は全フィールド取得に落として動かし続ける。
 */
async function fetchAgencies(query: string): Promise<Agency[]> {
  try {
    return (await getRecords(APP.agency, query, FIELDS)).map(toAgency);
  } catch {
    return (await getRecords(APP.agency, query)).map(toAgency);
  }
}

/** 代理店コードで1件引く。 */
export async function findAgencyByCode(code: string): Promise<Agency | null> {
  if (!code.trim()) return null;
  const rows = await fetchAgencies(`代理店コード = ${q(code.trim())} limit 1`);
  return rows[0] ?? null;
}

/** 全代理店を取得する（本部用）。 */
export async function listAllAgencies(): Promise<Agency[]> {
  return fetchAgencies("order by 代理店コード asc limit 500");
}

/**
 * ある代理店の配下を、階層をたどって全部集める。
 * 自分自身は含まない。循環参照があっても無限ループしない。
 */
export async function listDescendants(rootCode: string): Promise<Agency[]> {
  const all = await listAllAgencies();
  const byParent = new Map<string, Agency[]>();
  for (const a of all) {
    if (!a.parentCode) continue;
    const list = byParent.get(a.parentCode) ?? [];
    list.push(a);
    byParent.set(a.parentCode, list);
  }

  const out: Agency[] = [];
  const seen = new Set<string>([rootCode]);
  const queue = [rootCode];
  while (queue.length) {
    const code = queue.shift()!;
    for (const child of byParent.get(code) ?? []) {
      if (seen.has(child.code)) continue;
      seen.add(child.code);
      out.push(child);
      queue.push(child.code);
    }
  }
  return out;
}

/** 配下を組織図の形（木構造）で返す。 */
export async function buildOrgTree(rootCode: string): Promise<OrgNode | null> {
  const all = await listAllAgencies();
  const byCode = new Map(all.map((a) => [a.code, a]));
  const root = byCode.get(rootCode);
  if (!root) return null;

  const byParent = new Map<string, Agency[]>();
  for (const a of all) {
    if (!a.parentCode || a.code === a.parentCode) continue;
    const list = byParent.get(a.parentCode) ?? [];
    list.push(a);
    byParent.set(a.parentCode, list);
  }

  const seen = new Set<string>();
  const build = (agency: Agency): OrgNode => {
    seen.add(agency.code);
    const children = (byParent.get(agency.code) ?? [])
      .filter((c) => !seen.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(build);
    return { agency, children };
  };
  return build(root);
}

/**
 * 枠の消費数。
 * 7/9 の設計どおり「コード区分 = 00（正規代理店）」だけが枠を消費する。
 * 取次パートナー(01) とスタッフ(02) は枠を消費しない。
 */
export function countsTowardSlot(a: Agency): boolean {
  return a.codeKind === "00" && a.status !== "停止・解約";
}

export type SlotSummary = {
  limit: number;
  used: number;
  remaining: number;
  requestStatus: string;
  isOver: boolean;
  /** 枠を消費している直下の代理店 */
  members: Agency[];
  /** 枠を消費しない直下（取次・スタッフ） */
  others: Agency[];
};

export async function getSlotSummary(agency: Agency): Promise<SlotSummary> {
  const all = await listAllAgencies();
  const direct = all.filter((a) => a.parentCode === agency.code);
  const members = direct.filter(countsTowardSlot);
  const others = direct.filter((a) => !countsTowardSlot(a));
  const limit = agency.slotLimit || DEFAULT_SLOT_LIMIT;
  const used = members.length;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    requestStatus: agency.slotRequestStatus,
    isOver: used >= limit,
    members,
    others,
  };
}

/** 増枠を申請する（App9 の増枠申請ステータスを「申請中」にする）。 */
export async function requestSlotIncrease(recordId: string): Promise<void> {
  await updateRecord(APP.agency, recordId, {
    増枠申請ステータス: { value: "申請中" },
  });
}

/** 本部が増枠申請を承認する。上限を増やしたうえでステータスを承認済にする。 */
export async function approveSlotIncrease(
  recordId: string,
  newLimit: number,
): Promise<void> {
  await updateRecord(APP.agency, recordId, {
    販売代理店枠上限: { value: String(newLimit) },
    増枠申請ステータス: { value: "承認済" },
  });
}

/** 本部が増枠申請を却下する。 */
export async function rejectSlotIncrease(recordId: string): Promise<void> {
  await updateRecord(APP.agency, recordId, {
    増枠申請ステータス: { value: "却下" },
  });
}

/** 増枠申請が出ている代理店を集める（本部の承認画面用）。 */
export async function listPendingSlotRequests(): Promise<Agency[]> {
  return fetchAgencies(`増枠申請ステータス in ("申請中") order by 更新日時 asc limit 200`);
}


/** 直下の代理店（1階層だけ）を返す。枠の判定に使う。 */
export async function listDirectChildren(code: string): Promise<Agency[]> {
  const all = await listAllAgencies();
  return all.filter((a) => a.parentCode === code && a.code !== code);
}

/**
 * App9 に入っている枠上限を、0 のものは既定値に落として返す。
 * フィールドがまだ作られていない環境でも既定値で動く。
 */
export function slotLimitsOf(agency: Agency): Record<string, number> {
  const l = agency.slotLimits;
  return {
    販売代理店枠上限: l.販売代理店枠上限 || 10,
    サロン代理店枠上限: l.サロン代理店枠上限 || 30,
    個人代理店枠上限: l.個人代理店枠上限 || 30,
    取次店枠上限: l.取次店枠上限 || 30,
  };
}
