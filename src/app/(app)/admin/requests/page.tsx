import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import {
  listAllAgencies,
  listPendingSlotRequests,
  slotLimitsOf,
} from "@/lib/agencies";
import { select } from "@/lib/db";
import { areaUsage, breakdownSlots, slotModelOf } from "@/lib/slots";
import { agencyTypeOf } from "@/lib/labels";
import {
  parseSort,
  sortRows,
  type Accessors,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import type { Agency } from "@/lib/types";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  cn,
  jpDate,
} from "@/components/ui";
import { SortableTh } from "@/components/SortableTh";
import { DecisionForm, type DecisionKind } from "./DecisionForm";

const BASE = "/admin/requests";

/** 「枠が埋まりつつある」とみなす使用率。 */
const NEAR_FULL_RATIO = 0.8;

/** ランクは五十音順ではなく、上下関係の順に並べたい。 */
const RANK_ORDER = ["総販売代理店", "2次代理店", "取次店"];

/** 並び替えに使える列。URL を手で書き換えられても、知らない列では並び替えない。 */
const SORT_COLUMNS = [
  "code",
  "name",
  "rank",
  "area",
  "slot",
  "limit",
  "used",
  "requested",
];

/** 既定は「申請の古い順」。待たせている代理店から順に片づけられるようにする。 */
const DEFAULT_SORT: SortState = { column: "requested", desc: false };

/** いちばん埋まっている枠（販路種別ごとの枠のうち、いちばん残りが少ないもの）。 */
type TightSlot = {
  label: string;
  limit: number;
  used: number;
  ratio: number;
};

type NearFull = {
  agency: Agency;
  /** 枠の合計。エリア枠なら全国の合計、それ以外は販路種別4つの合計 */
  limit: number;
  /** 埋まっている数の合計 */
  used: number;
  /** 合計での使用率 */
  ratio: number;
  /** 枠の数え方 */
  model: "area" | "channel";
  /** 販路種別ごとの枠のうち、いちばん埋まっているもの。エリア枠のときは無し */
  tight: TightSlot | null;
};

/** 一覧に出す1行ぶん。 */
type PendingRow = {
  agency: Agency;
  /** いまの上限（枠の合計） */
  limit: number;
  /** 実際に埋まっている数（配下を数え直した実数） */
  used: number;
  /** 上限まで埋まっている枠の呼び方。空なら満枠なし */
  fullLabels: string[];
  /** 承認するときに選べる枠 */
  kinds: DecisionKind[];
  /** 最初に選んでおく枠 */
  defaultKind: string;
  /** 申請を受け付けた日（データベースの最終更新日時） */
  requestedAt: string;
  /** 枠の考え方が違う相手（総販売代理店）のときの補足 */
  note?: string;
};

/** 合計と、いちばん埋まっている枠のうち、高いほうの使用率。並び替えと絞り込みに使う。 */
function peakRatio(r: NearFull): number {
  return Math.max(r.ratio, r.tight?.ratio ?? 0);
}

/**
 * 申請はまだ出ていないが、枠が残りわずかな代理店を洗い出す。
 *
 * 枠の数え方は上の一覧表とそろえる。
 *   総販売代理店 … 配下は統括代理店なので、エリアごとの枠（全国60社）の合計
 *   統括代理店   … 販路種別ごとの枠の合計（販売10＋サロン30＋個人30＋取次30＝100枠）
 *
 * 販売代理店の枠（既定10）だけを分母にして配下を全部数えると、サロン代理店を
 * かかえた統括代理店が、実際は100枠中8社しか使っていないのに「満枠」と出てしまう。
 */
function nearFullAgencies(
  all: Agency[],
  childrenOf: Map<string, Agency[]>,
  areaTotal: { limit: number; used: number },
): NearFull[] {
  const rows: NearFull[] = [];

  for (const a of all) {
    if (a.codeKind !== "00" || a.status === "停止・解約") continue;
    // すでに申請が出ている代理店は、上の一覧表に出ているので重ねて出さない。
    if (a.slotRequestStatus === "申請中") continue;

    const model = slotModelOf(a);
    // 取次パートナーやスタッフは配下を持たない。枠の話そのものが当てはまらない。
    if (model === "none") continue;

    if (model === "area") {
      rows.push({
        agency: a,
        limit: areaTotal.limit,
        used: areaTotal.used,
        ratio: areaTotal.limit > 0 ? areaTotal.used / areaTotal.limit : 0,
        model,
        tight: null,
      });
      continue;
    }

    const breakdown = breakdownSlots(a, childrenOf.get(a.code) ?? [], slotLimitsOf(a));
    let tight: TightSlot | null = null;
    for (const line of breakdown.lines) {
      const ratio = line.limit > 0 ? line.used / line.limit : 0;
      if (!tight || ratio > tight.ratio) {
        tight = { label: line.label, limit: line.limit, used: line.used, ratio };
      }
    }
    rows.push({
      agency: a,
      limit: breakdown.totalLimit,
      used: breakdown.totalUsed,
      ratio: breakdown.totalLimit > 0 ? breakdown.totalUsed / breakdown.totalLimit : 0,
      model,
      tight,
    });
  }

  return rows
    .filter((r) => peakRatio(r) >= NEAR_FULL_RATIO)
    .sort((a, b) => peakRatio(b) - peakRatio(a) || b.used - a.used);
}

/**
 * 申請を受け付けた日を引く。
 *
 * 代理店の型（src/lib/types.ts）は最終更新日時を持っていないため、必要な2列だけ
 * ここで読み足す。申請中のあいだは最後の更新＝申請なので、これを申請日として出す。
 */
async function fetchRequestedAt(): Promise<Map<string, string>> {
  const rows = await select<{ id: number | string; updated_at: string | null }>(
    `agencies?select=id,updated_at&slot_request=eq.${encodeURIComponent("申請中")}`,
  );
  const out = new Map<string, string>();
  for (const r of rows) out.set(String(r.id), r.updated_at ?? "");
  return out;
}

export default async function AdminRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let pending: Agency[] = [];
  let all: Agency[] = [];
  let requestedAt = new Map<string, string>();
  let loadError: string | null = null;

  try {
    [pending, all, requestedAt] = await Promise.all([
      listPendingSlotRequests(),
      listAllAgencies(),
      fetchRequestedAt(),
    ]);
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "代理店の情報を取得できませんでした。時間をおいてもう一度お試しください。";
  }

  const header = (
    <PageHeader
      title="増枠申請"
      description="代理店から届いている枠の増枠申請の一覧です。見出しを押すと、その列で並び替えられます。承認すると、その代理店はすぐに新しい枠まで登録できるようになります。"
      actions={
        loadError ? null : (
          <Badge tone={pending.length > 0 ? "warn" : "neutral"}>
            承認待ち {pending.length} 件
          </Badge>
        )
      }
    />
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          申請の一覧を読み込めませんでした。{loadError}
          <br />
          しばらく待ってから画面を読み込み直してください。続くようであれば、データベースの
          接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  /* --- 配下は全件から引く（1社ずつ取りに行くと申請の数だけ読み込みが増えるため） --- */
  const childrenOf = new Map<string, Agency[]>();
  for (const a of all) {
    if (!a.parentCode) continue;
    const list = childrenOf.get(a.parentCode) ?? [];
    list.push(a);
    childrenOf.set(a.parentCode, list);
  }
  const areaTotal = areaUsage(all).total;

  const pendingRows: PendingRow[] = pending.map((a) => {
    const children = childrenOf.get(a.code) ?? [];
    const breakdown = breakdownSlots(a, children, slotLimitsOf(a));
    const kinds: DecisionKind[] = breakdown.lines.map((l) => ({
      key: l.key,
      label: l.label,
      limit: l.limit,
      used: l.used,
      isFull: l.isFull,
    }));
    const full = kinds.filter((k) => k.isFull);
    const isArea = slotModelOf(a) === "area";

    return {
      agency: a,
      // 配下が統括代理店の相手（総販売代理店）は、枠の考え方が全国のエリア枠になる。
      limit: isArea ? areaTotal.limit : breakdown.totalLimit,
      used: isArea ? areaTotal.used : breakdown.totalUsed,
      fullLabels: isArea
        ? areaTotal.remaining === 0
          ? ["エリア枠（全国）"]
          : []
        : full.map((k) => k.label),
      kinds,
      defaultKind: (full[0] ?? kinds[0])?.key ?? "販売代理店",
      requestedAt: requestedAt.get(a.recordId) ?? "",
      note: isArea
        ? "この代理店の配下は統括代理店です。枠はエリアごと（全国60社）に決まっているため、ここで上限を変えても配下の枠は増えません。エリア枠の見直しが必要かどうか、本部でご確認ください。"
        : undefined,
    };
  });

  const accessors: Accessors<PendingRow> = {
    code: (r) => r.agency.code,
    name: (r) => r.agency.name,
    rank: (r) => {
      const i = RANK_ORDER.indexOf(r.agency.rank);
      return i < 0 ? null : i;
    },
    area: (r) => r.agency.area,
    slot: (r) => r.fullLabels.join("・"),
    limit: (r) => r.limit,
    used: (r) => r.used,
    requested: (r) => r.requestedAt,
  };
  const rows = sortRows(pendingRows, sort.column, sort.desc, accessors);

  const nearFull = nearFullAgencies(all, childrenOf, areaTotal);
  const fullCount = pendingRows.filter((r) => r.fullLabels.length > 0).length;

  const th = (column: string, label: string, align?: "left" | "right") => (
    <SortableTh
      column={column}
      label={label}
      sort={sort}
      basePath={BASE}
      params={params}
      align={align}
    />
  );

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="承認待ちの申請"
          value={String(pending.length)}
          unit="件"
          tone={pending.length > 0 ? "warn" : "default"}
          hint={pending.length > 0 ? "本部の判断待ちです" : "いま届いている申請はありません"}
        />
        <StatTile
          label="うち満枠"
          value={String(fullCount)}
          unit="件"
          hint="どれかの枠が上限まで埋まっている申請"
        />
        <StatTile
          label="枠が埋まりつつある代理店"
          value={String(nearFull.length)}
          unit="社"
          hint={`使用率 ${Math.round(NEAR_FULL_RATIO * 100)}% 以上・申請はまだ出ていません`}
        />
      </div>

      <Card title={`承認待ちの申請　${rows.length} 件`}>
        {rows.length === 0 ? (
          <EmptyState
            title="いま届いている申請はありません"
            description="代理店が枠の上限に達して増枠を申請すると、ここに表示されます。申請を待たずに上限を調整したい場合は、下の「枠が埋まりつつある代理店」をご覧ください。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                {th("code", "代理店コード")}
                {th("name", "法人名")}
                {th("rank", "ランク")}
                {th("area", "エリア")}
                {th("slot", "申請中の枠")}
                {th("limit", "いまの上限", "right")}
                {th("used", "実際の登録数", "right")}
                {th("requested", "申請日")}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const a = r.agency;
                return (
                  <Fragment key={a.recordId || a.code}>
                  <tr>
                    <Td numeric className="whitespace-nowrap font-medium text-ink-100">
                      {a.code ? (
                        <Link
                          href={`/admin/agencies/${encodeURIComponent(a.code)}`}
                          className="underline underline-offset-4 hover:text-gold-300"
                        >
                          {a.code}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <div className="min-w-0">
                        <div className="truncate text-ink-100">
                          {a.name || "（名称未登録）"}
                        </div>
                        <div className="truncate text-xs text-ink-400">
                          上位: {a.parentName || a.parentCode || "なし（総販売代理店の直下）"}
                        </div>
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {agencyTypeOf(a.rank, a.channel, a.codeKind, a.staffType)}
                      {a.specialSlot ? (
                        <span className="ml-1.5 align-middle">
                          <Badge tone="gold">特別枠</Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">{a.area || "—"}</Td>
                    <Td>
                      {r.fullLabels.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {r.fullLabels.map((label) => (
                            <Badge key={label} tone="warn">
                              {label}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-400">
                          満枠の枠はありません
                        </span>
                      )}
                    </Td>
                    <Td numeric align="right" className="whitespace-nowrap">
                      {r.limit}
                    </Td>
                    <Td
                      numeric
                      align="right"
                      className={cn(
                        "whitespace-nowrap",
                        r.used >= r.limit && "font-medium text-warn-500",
                      )}
                    >
                      {r.used}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {r.requestedAt ? jpDate(r.requestedAt) : "—"}
                    </Td>
                  </tr>

                  {/* 承認・却下は行の下に敷く。列にすると表が横に伸びて、
                      毎日いちばん押すボタンが画面の外に出てしまうため。 */}
                  <tr>
                    <td
                      colSpan={8}
                      className="border-b border-ink-800 bg-ink-950/40 px-4 pb-4 pt-1"
                    >
                      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                        <span className="pb-2 text-xs text-ink-400">
                          {a.code || a.name || "この申請"} への対応
                        </span>
                        <DecisionForm
                          recordId={a.recordId}
                          kinds={r.kinds}
                          defaultKind={r.defaultKind}
                          note={r.note}
                        />
                      </div>
                    </td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {rows.length > 0 ? (
        <p className="text-xs leading-relaxed text-ink-400">
          「いまの上限」と「実際の登録数」は、販路種別ごとの枠（販売代理店・サロン代理店・
          個人販売パートナー・取次パートナー）の合計です。どの枠が埋まっているかは
          「申請中の枠」の欄と、承認するときの「増やす枠」の選択肢に出ています。
          申請そのものには枠の種類が入っていないため、増やす枠は本部が選んで承認してください。
        </p>
      ) : null}

      <Card title="枠が埋まりつつある代理店（参考）">
        <p className="px-5 pt-4 text-sm leading-relaxed text-ink-300">
          申請はまだ出ていませんが、枠の使用率が {Math.round(NEAR_FULL_RATIO * 100)}%
          を超えている代理店です。申請を待たずに上限を調整することもできます。
          数え方は上の一覧表とそろえてあり、統括代理店は販路種別ごとの枠（販売代理店・
          サロン代理店・個人販売パートナー・取次パートナー）の合計、総販売代理店は
          エリアごとの枠（全国60社）の合計で見ています。合計にまだ余裕があっても、
          どれか1つの販路種別が埋まりかけている場合はここに出ます。
        </p>
        {nearFull.length === 0 ? (
          <EmptyState
            title="枠が埋まりつつある代理店はありません"
            description={`各社ともまだ枠に余裕があります。枠の使用率が ${Math.round(
              NEAR_FULL_RATIO * 100,
            )}% を超えた代理店が出ると、ここに表示されます。`}
          />
        ) : (
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>代理店</Th>
                  <Th>代理店種別</Th>
                  <Th>エリア</Th>
                  <Th>上位代理店</Th>
                  <Th>いちばん埋まっている枠</Th>
                  <Th align="right">登録済（枠の合計）</Th>
                  <Th align="right">上限（枠の合計）</Th>
                  <Th align="right">使用率（合計）</Th>
                  <Th align="center">状態</Th>
                </tr>
              </thead>
              <tbody>
                {nearFull.map(({ agency, limit, used, ratio, model, tight }) => {
                  // 合計にまだ余裕があっても、販路種別の枠が1つ埋まればその枠には
                  // もう登録できない。どちらの満枠かが分かる言い方にする。
                  const totalFull = used >= limit;
                  const tightFull = tight ? tight.used >= tight.limit : false;
                  const isFull = totalFull || tightFull;
                  const label =
                    tight && tightFull
                      ? `${tight.label}が満枠`
                      : totalFull
                        ? "満枠"
                        : `残り ${limit - used} 社`;
                  return (
                  <tr key={agency.recordId || agency.code}>
                    <Td>
                      <div className="font-medium text-ink-100">
                        {agency.name || "（名称未登録）"}
                      </div>
                      <div className="tabnum text-xs text-ink-500">
                        {agency.code ? (
                          <Link
                            href={`/admin/agencies/${encodeURIComponent(agency.code)}`}
                            className="underline underline-offset-4 hover:text-gold-300"
                          >
                            {agency.code}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {agencyTypeOf(agency.rank, agency.channel, agency.codeKind, agency.staffType)}
                    </Td>
                    <Td>{agency.area || "—"}</Td>
                    <Td>{agency.parentName || agency.parentCode || "—"}</Td>
                    <Td>
                      {model === "area" ? (
                        <span className="whitespace-nowrap text-ink-200">
                          エリア枠（全国）
                        </span>
                      ) : tight ? (
                        <span className="whitespace-nowrap text-ink-200">
                          {tight.label}{" "}
                          <span className="tabnum text-xs text-ink-400">
                            {tight.used} / {tight.limit}（
                            {Math.round(tight.ratio * 100)}%）
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </Td>
                    <Td numeric align="right">
                      {used}
                    </Td>
                    <Td numeric align="right">
                      {limit}
                    </Td>
                    <Td numeric align="right">
                      {Math.round(ratio * 100)}%
                    </Td>
                    <Td align="center">
                      <Badge tone={isFull ? "bad" : "warn"}>{label}</Badge>
                    </Td>
                  </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
