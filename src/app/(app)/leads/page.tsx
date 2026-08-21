import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listAllAgencies, listDescendants } from "@/lib/agencies";
import { currentMonth, listOrders, recentMonths, scopeCodes } from "@/lib/orders";
import {
  LEAD_LIMIT,
  isClosed,
  jstDate,
  leadMonth,
  listLeads,
  summarizeLeads,
  type Lead,
} from "@/lib/leads";
import type { Agency } from "@/lib/types";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  jpDate,
  jpMonthLabel,
} from "@/components/ui";
import {
  ALL,
  buildListHref,
  buildOptions,
  matchesKeyword,
  parseSort,
  readParam,
  sortRows,
  type Accessors,
  type FilterOption,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import {
  FilterActions,
  FilterBar,
  FilterSelect,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";

export const metadata = { title: "トスアップ状況｜VIS 代理店ポータル" };

const BASE = "/leads";

/**
 * トスアップの状態。保存先（leads.status）で決まっている5つで、この並びで出す。
 * 絞り込みはこの値のまま行う（画面の呼び方で比べない）。
 */
const STATUSES = ["トスアップ済", "商談中", "体験同意・検討中", "成約", "不成立"];

/** 見出しを押して並び替えられる列。 */
const SORT_COLUMNS = ["tossed", "customer", "phone", "referrer", "status", "closed", "order"];

/** 既定はトスアップの新しい順（取得したままの並び）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

/** "YYYY-MM" か "all" だけを受け付ける。それ以外は今月に落とす。 */
function normalizeMonth(raw: string, fallback: string): string {
  if (raw === ALL) return ALL;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return fallback;
}

/** 全期間表示のときだけ年を添える。 */
function showDate(ymd: string, withYear: boolean): string {
  if (!ymd) return "—";
  return withYear ? `${ymd.slice(0, 4)}/${jpDate(ymd)}` : jpDate(ymd);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    status?: string;
    q?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  /*
   * 本部もこの画面を開ける。
   *
   * kintone のトスアップ台帳（App14）を止めると、本部が
   * 「誰がどのお客様を紹介したか」を見る手段が無くなるため。
   * 本部のときは紹介元で絞らず全件を出す（下の listLeads の all）。
   */
  const isHq = viewer.kind === "hq";

  const params: SearchParams = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);
  const month = normalizeMonth(readParam(params, "month"), thisMonth);
  const status = readParam(params, "status") || ALL;
  const keyword = readParam(params, "q");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  const allPeriod = month === ALL;
  const periodLabel = allPeriod ? "全期間" : jpMonthLabel(month);

  let self: Agency | null = null;
  let members: Agency[] = [];
  let allLeads: Lead[] = [];
  /** 成約したトスアップのうち、受注一覧でも開ける受注番号。 */
  let openableOrders = new Set<string>();
  let error: string | null = null;

  try {
    if (isHq) {
      // 本部は全件。紹介元の名前を出せるよう、代理店マスタも読み込む
      members = await listAllAgencies();
      allLeads = await listLeads([], { all: true });
    } else {
      self = await findAgencyByCode(viewer.code);
      if (!self) {
        error = `代理店一覧にあなたのコード（${viewer.code}）が見つかりませんでした。本部にお問い合わせください。`;
      } else {
        const descendants = await listDescendants(self.code);
        members = [self, ...descendants];
        const codes = scopeCodes(self, descendants);
        allLeads = await listLeads(codes);

        // 成約したトスアップに受注番号が入っていても、その受注が自分の担当から
        // 外れていれば顧客一覧では開けない。開けるものだけリンクにする。
        if (allLeads.some((l) => l.orderNo)) {
          try {
            const { orders } = await listOrders(codes);
            openableOrders = new Set(orders.map((o) => o.recordId));
          } catch {
            // 受注が読めなくてもトスアップの一覧は出す（リンクだけ出さない）
          }
        }
      }
    }
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "トスアップの情報を取得できませんでした。時間をおいて画面を読み込み直してください。";
  }

  // 配下がいる（＝取次店を束ねている）ときは、誰からの紹介かを出す。
  const showReferrer = members.length > 1;

  const header = (
    <PageHeader
      title="トスアップ状況"
      description={
        showReferrer
          ? "専用フォームからご紹介いただいたお客様の進み具合です。ご自身と配下の取次店の分をまとめて表示しています。"
          : "専用フォームからご紹介いただいたお客様の進み具合です。ご成約になると成約日と受注番号が入ります。"
      }
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">{error}</Notice>
      </div>
    );
  }

  const inPeriod = allPeriod ? allLeads : allLeads.filter((l) => leadMonth(l) === month);

  /* --- 絞り込み --- */
  const found = inPeriod.filter((l) => {
    if (status !== ALL && l.status !== status) return false;
    return matchesKeyword(keyword, [l.customerName, l.phone]);
  });

  /* --- 並び替え --- */
  const nameByCode = new Map(members.map((m) => [m.code, m.name]));
  const accessors: Accessors<Lead> = {
    tossed: (l) => jstDate(l.tossedAt),
    customer: (l) => l.customerName,
    phone: (l) => l.phone,
    referrer: (l) => nameByCode.get(l.referrerCode) || l.referrerCode,
    // 状態は五十音順ではなく、商談の進む順（トスアップ済→商談中→…）で並べる
    status: (l) => {
      const i = STATUSES.indexOf(l.status);
      return i < 0 ? null : i;
    },
    closed: (l) => l.closedAt,
    order: (l) => l.orderNo,
  };
  const rows = sortRows(found, sort.column, sort.desc, accessors);

  const summary = summarizeLeads(rows);
  const truncated = allLeads.length >= LEAD_LIMIT;

  const statusOptions: FilterOption[] = buildOptions(
    inPeriod,
    (l) => l.status,
    STATUSES,
    status,
  );
  const monthOptions: FilterOption[] = months.map((m) => ({
    value: m,
    label: `${jpMonthLabel(m)}${m === thisMonth ? "（今月）" : ""}`,
    count: 0,
  }));

  const isFiltered = Boolean(keyword) || status !== ALL;
  const clearHref = buildListHref(BASE, params, { q: "", status: "" });

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            sort: sort.column,
            dir: sort.column ? (sort.desc ? "desc" : "asc") : "",
          }}
        >
          <FilterText
            name="q"
            label="お客様のお名前・電話番号"
            value={keyword}
            placeholder="例：山田／09012345678"
            width="w-60"
          />
          <FilterSelect
            name="status"
            label="状態"
            value={status}
            options={statusOptions}
            allLabel={`すべて（${inPeriod.length}）`}
            width="w-52"
          />
          <FilterSelect
            name="month"
            label="期間"
            value={allPeriod ? ALL : month}
            options={monthOptions}
            allLabel="全期間"
            showCount={false}
            width="w-44"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={inPeriod.length}
          shown={rows.length}
          clearHref={clearHref}
          note={periodLabel}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="トスアップ件数"
          value={String(summary.total)}
          unit="件"
          hint={
            isFiltered
              ? `${periodLabel}・いまの絞り込みでの件数`
              : `${periodLabel}にご紹介いただいた件数`
          }
        />
        <StatTile
          label="成約件数"
          value={String(summary.closed)}
          unit="件"
          tone="gold"
          hint={
            isFiltered
              ? "いまの絞り込みのうち、お申し込みまで進んだ件数"
              : "お申し込みまで進んだ件数"
          }
        />
        <StatTile
          label="成約率"
          value={summary.closeRate === null ? "—" : `${Math.round(summary.closeRate * 100)}%`}
          hint={
            summary.closeRate === null
              ? "トスアップがまだないため算出できません"
              : `${summary.closed}件 ÷ ${summary.total}件`
          }
        />
      </div>

      <Card title={`ご紹介いただいたお客様（${periodLabel}）`}>
        {rows.length === 0 ? (
          isFiltered ? (
            <EmptyState
              title="条件に合うトスアップがありません"
              description="状態を「すべて」に戻すか、期間を「全期間」に広げてお試しください。お名前・電話番号は一部でも探せます。"
            />
          ) : allLeads.length === 0 ? (
            <EmptyState
              title="まだトスアップがありません"
              description="専用フォームからお客様をご紹介いただくと、ここに進捗が表示されます。"
            />
          ) : (
            <EmptyState
              title={`${periodLabel}のトスアップはありません`}
              description="期間を「全期間」に切り替えると、これまでにご紹介いただいたお客様を確認できます。"
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  column="tossed"
                  label="トスアップ日"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="customer"
                  label="お客様名"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="phone"
                  label="電話番号"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                {showReferrer ? (
                  <SortableTh
                    column="referrer"
                    label="紹介元"
                    sort={sort}
                    basePath={BASE}
                    params={params}
                  />
                ) : null}
                <SortableTh
                  column="status"
                  label="ステータス"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="closed"
                  label="成約日"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="order"
                  label="受注番号"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.recordId}>
                  <Td numeric>{showDate(jstDate(l.tossedAt), allPeriod)}</Td>
                  <Td>{l.customerName || "—"}</Td>
                  <Td numeric>{l.phone || "—"}</Td>
                  {showReferrer ? (
                    <Td>
                      {l.referrerCode ? (
                        <>
                          <Badge tone="gold">{l.referrerCode}</Badge>
                          <div className="mt-1 text-xs text-ink-400">
                            {nameByCode.get(l.referrerCode) ??
                              (l.referrerCode === self?.code ? "自分" : "代理店一覧に該当なし")}
                          </div>
                        </>
                      ) : (
                        <Badge>紹介元なし</Badge>
                      )}
                    </Td>
                  ) : null}
                  <Td>
                    <StatusBadge status={l.status} />
                  </Td>
                  <Td numeric>{showDate(l.closedAt, allPeriod)}</Td>
                  <Td numeric>
                    {l.orderNo ? (
                      openableOrders.has(l.orderNo) ? (
                        <Link
                          href={`/customers?order=${encodeURIComponent(l.orderNo)}`}
                          className="tabnum text-gold-300 underline underline-offset-2 transition hover:text-gold-100"
                          title="顧客一覧でこの受注を開きます"
                        >
                          {l.orderNo}
                        </Link>
                      ) : (
                        <>
                          <span className="tabnum">{l.orderNo}</span>
                          <div className="mt-1 text-xs text-ink-400">
                            受注は本部の管理です
                          </div>
                        </>
                      )
                    ) : (
                      <span className="text-ink-400">{isClosed(l) ? "確認中" : "—"}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {truncated ? (
        <Notice tone="warn">
          ご紹介いただいた件数が多いため、新しい順に{LEAD_LIMIT}
          件までを表示しています。それより前のご紹介は本部にお問い合わせください。
        </Notice>
      ) : null}

      <Notice tone="info">
        ステータスは本部と担当代理店が商談の進み具合にあわせて更新します。「成約」になるとお申し込みが確定し、
        成約日と受注番号が入ります。受注番号がリンクになっているものは、押すと顧客一覧でその受注の進み具合を
        確認できます。成約なのに受注番号が「確認中」のままの場合は、本部側で受注との突き合わせが
        済んでいません。数日たっても変わらないときは本部にお問い合わせください。
      </Notice>
    </div>
  );
}
