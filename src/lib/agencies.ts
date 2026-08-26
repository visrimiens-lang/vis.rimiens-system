import "server-only";
import { select, selectAll, selectOne, update, val } from "./db";
import type { Agency, AgencyRank, CodeKind, OrgNode, SalesChannel } from "./types";
import { DEFAULT_STAFF_LIMIT, breakdownSlots } from "./slots";

/**
 * 旧・販売代理店枠の既定値。
 * 枠がスタッフ1本になる前の値で、いまは古いデータを読むときだけ使う。
 */
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
    companyName: s_(r, "company_name"),
    staffType: s_(r, "staff_type"),
    area: s_(r, "area_class") || s_(r, "area"),
    email: s_(r, "email"),
    phone: s_(r, "phone"),
    zip: s_(r, "zip"),
    address: s_(r, "address"),
    invoiceNo: s_(r, "invoice_no"),
    bankName: s_(r, "bank_name"),
    bankBranch: s_(r, "bank_branch"),
    accountType: s_(r, "account_type"),
    accountNo: s_(r, "account_no"),
    accountHolder: s_(r, "account_holder"),
    status: s_(r, "status"),
    staffLimit:
      r["limit_staff"] === null || r["limit_staff"] === undefined
        ? DEFAULT_STAFF_LIMIT
        : n_(r, "limit_staff"),
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
    qr2Status: s_(r, "qr2_status"),
    qr2RejectedNote: s_(r, "qr2_rejected_note"),
    trainingStatus: s_(r, "training_status"),
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
 * 画面には何も出ないため気づけない。代理店は1社あたり100名の枠なので、
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
 * 枠を消費するか。
 *
 * 2026-08-22 から「直下にいる稼働中の相手は、区分にかかわらず1人ぶん枠を使う」。
 * 判定は lib/slots.ts の consumesSlot 1か所に集めてある。
 * 以前はこの関数（区分00だけ）と slots.ts（区分02以外）が別の答えを出しており、
 * 画面によって使用数が食い違っていた。
 */
export { consumesSlot as countsTowardSlot } from "./slots";

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
  const b = breakdownSlots(agency, direct);
  return {
    limit: b.limit,
    used: b.used,
    remaining: b.limit === 0 ? Number.POSITIVE_INFINITY : b.remaining,
    requestStatus: agency.slotRequestStatus,
    isOver: b.isFull,
    members: b.members,
    others: direct.filter((a) => a.status === "停止・解約"),
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
 * 2026-08-22 に枠はスタッフ1本になったので、増やす列も1つだけ。
 * それまでは販路種別ごとに4列あり、本部がどの枠かを選んでいた。
 */
export async function approveSlotIncrease(
  recordId: string,
  newLimit: number,
): Promise<void> {
  await update(`agencies?id=eq.${encodeURIComponent(recordId)}`, {
    limit_staff: newLimit,
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
 * 販路種別ごとの枠上限（2026-08-22 より前の持ち方）。
 * 枠はスタッフ1本にまとめたので、いまは本部の操作記録を読むためだけに残している。
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
