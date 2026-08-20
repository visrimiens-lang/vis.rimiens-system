import "server-only";
import { select, selectAll, selectOne, update, val } from "./db";
import type { Agency, AgencyRank, CodeKind, OrgNode, SalesChannel } from "./types";

/** 枠の既定値。App9 側が未設定でもこの値で扱う。 */
export const DEFAULT_SLOT_LIMIT = 10;

/** データベースの1行を、画面が使う形に直す。 */
type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const n_ = (r: Row, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

function toAgency(r: Row): Agency {
  return {
    recordId: s_(r, "id"),
    code: s_(r, "code"),
    name: s_(r, "name"),
    representative: s_(r, "rep_name"),
    rank: (s_(r, "rank") || "") as AgencyRank | "",
    channel: (s_(r, "channel") || "") as SalesChannel | "",
    codeKind: (s_(r, "code_kind") || "") as CodeKind,
    orgCode: s_(r, "org_code"),
    parentCode: s_(r, "parent_code"),
    parentName: s_(r, "parent_name"),
    area: s_(r, "area_class") || s_(r, "area"),
    email: s_(r, "email"),
    phone: s_(r, "phone"),
    status: s_(r, "status"),
    slotLimit: n_(r, "limit_hanbai") || DEFAULT_SLOT_LIMIT,
    slotLimits: {
      販売代理店枠上限: n_(r, "limit_hanbai"),
      サロン代理店枠上限: n_(r, "limit_salon"),
      個人代理店枠上限: n_(r, "limit_kojin"),
      取次店枠上限: n_(r, "limit_toritsugi"),
    },
    slotUsed: 0, // 実際の配下数から数える（登録済件数は持たない）
    slotRequestStatus: s_(r, "slot_request"),
    specialSlot: r["special_slot"] === true,
    registeredVia: s_(r, "registered_via"),
    createdAt: s_(r, "created_at"),
    qr1Url: s_(r, "qr1_url"),
    qr2Url: s_(r, "qr2_url"),
    /*
     * 上位が決めた「この相手に払う額」。
     * 列がまだ無いうちは undefined で来るので null に倒す（既定の単価を使う扱い）。
     */
    payUnit: r["pay_unit"] === null || r["pay_unit"] === undefined ? null : n_(r, "pay_unit"),
    payUnitNote: s_(r, "pay_unit_note"),
  };
}


/**
 * 代理店を取る。並び順は必ず指定する（表示のたびに順序が変わらないように）。
 *
 * selectAll を使い、保存先の1回あたりの上限（1000件）で切られないようにする。
 * ここが切られると、枠の残りを数え間違えたり、組織図から枝が消えたりするが、
 * 画面には何も出ないため気づけない。代理店は1社あたり100枠の設計なので、
 * 取次パートナー・スタッフを含めれば1000件は現実に超えうる。
 */
async function fetchAgencies(filter: string): Promise<Agency[]> {
  const rows = await selectAll<Row>(
    `agencies?select=*&${filter}`,
  );
  return rows.map(toAgency);
}

/** 代理店コードで1件引く。 */
export async function findAgencyByCode(code: string): Promise<Agency | null> {
  const c = code.trim();
  if (!c) return null;
  const row = await selectOne<Row>(`agencies?select=*&code=eq.${encodeURIComponent(c)}`);
  return row ? toAgency(row) : null;
}

/** 全代理店を取得する（本部用）。 */
export async function listAllAgencies(): Promise<Agency[]> {
  // 枠の計算と組織図の土台になるので、必ず全件取る。
  return fetchAgencies("order=code.asc");
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

/** 増枠を申請する。 */
export async function requestSlotIncrease(recordId: string): Promise<void> {
  await update(`agencies?id=eq.${encodeURIComponent(recordId)}`, {
    slot_request: "申請中",
  });
}

/**
 * 本部が増枠申請を承認する。
 *
 * どの枠を増やすかは kind で指定する。指定が無ければ販売代理店枠。
 * 以前は必ず販売代理店枠だけを書き換えていたため、
 * サロン枠や取次枠が埋まって申請しても増えなかった。
 */
export async function approveSlotIncrease(
  recordId: string,
  newLimit: number,
  kind?: string,
): Promise<void> {
  const column =
    kind === "サロン代理店" ? "limit_salon"
    : kind === "個人販売パートナー" ? "limit_kojin"
    : kind === "サロン提携パートナー（取次）" ? "limit_toritsugi"
    : "limit_hanbai";
  await update(`agencies?id=eq.${encodeURIComponent(recordId)}`, {
    [column]: newLimit,
    slot_request: "承認済",
  });
}

/** 本部が増枠申請を却下する。 */
export async function rejectSlotIncrease(recordId: string): Promise<void> {
  await update(`agencies?id=eq.${encodeURIComponent(recordId)}`, {
    slot_request: "却下",
  });
}

/** 増枠申請が出ている代理店を集める（本部の承認画面用）。 */
export async function listPendingSlotRequests(): Promise<Agency[]> {
  return fetchAgencies("slot_request=eq." + encodeURIComponent("申請中") + "&order=updated_at.asc");
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
