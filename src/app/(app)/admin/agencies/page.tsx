import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer, listCodesWithPassword } from "@/lib/auth";
import { DEFAULT_SLOT_LIMIT, countsTowardSlot, listAllAgencies } from "@/lib/agencies";
import {
  ALL,
  buildListHref,
  buildOptions,
  matchesKeyword,
  parseSort,
  readChoice,
  readParam,
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
  StatusBadge,
  Table,
  Td,
  cn,
  jpDate,
} from "@/components/ui";
import {
  FilterActions,
  FilterBar,
  FilterSelect,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";
import { IssuePassword } from "./IssuePassword";
import { ResetRequests } from "./ResetRequests";

const BASE = "/admin/agencies";

type Tab = "agency" | "partner" | "staff";

const TABS: { key: Tab; label: string; unit: string }[] = [
  { key: "agency", label: "代理店", unit: "社" },
  { key: "partner", label: "取次パートナー", unit: "件" },
  { key: "staff", label: "スタッフ", unit: "名" },
];

/** 絞り込みの選択肢。データに無くても選べるように、決まっているものは並べておく。 */
const STATUSES = ["未稼働", "稼働中", "停止・解約"];
const RANKS = ["総販売代理店", "2次代理店", "取次店"];
const CHANNELS = [
  "販売代理店",
  "サロン代理店",
  "個人販売パートナー",
  "サロン提携パートナー（取次）",
];

/** 並び替えに使える列。URL を手で書き換えられても、知らない列では並び替えない。 */
const SORT_COLUMNS = [
  "code",
  "name",
  "rank",
  "channel",
  "area",
  "parent",
  "slot",
  "status",
  "email",
  "created",
];

const DEFAULT_SORT: SortState = { column: "code", desc: false };

/** ランクは五十音順ではなく、上下関係の順に並べたい。 */
function rankOrder(v: string): number | null {
  const i = RANKS.indexOf(v);
  return i < 0 ? null : i;
}

/** 稼働状況も、手当てが要る順（稼働中→未稼働→停止）に並べる。 */
function statusOrder(v: string): number | null {
  const i = STATUSES.indexOf(v);
  return i < 0 ? null : i;
}

function toTab(v: string): Tab {
  return v === "partner" || v === "staff" ? v : "agency";
}

export default async function AdminAgenciesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    keyword?: string;
    status?: string;
    rank?: string;
    channel?: string;
    area?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const tab = toTab(readParam(params, "tab"));
  const keyword = readParam(params, "keyword");
  const status = readChoice(params, "status", STATUSES);
  const rank = readChoice(params, "rank", RANKS);
  const channel = readParam(params, "channel") || ALL;
  const area = readParam(params, "area") || ALL;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let all: Agency[] = [];
  let loadError: string | null = null;
  try {
    all = await listAllAgencies();
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "代理店マスタの読み込みに失敗しました。時間をおいて開き直してください。";
  }

  const header = (
    <PageHeader
      title="代理店管理"
      description="代理店マスタに登録されている取引先の一覧です。コード区分ごとにタブが分かれています。見出しを押すと、その列で並び替えられます。"
    />
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          代理店マスタを読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、kintone の接続設定（接続先URLと認証情報）をご確認ください。
        </Notice>
      </div>
    );
  }

  /* --- 枠の使用数は「直下にいる、枠を消費する代理店」を数えて出す --- */
  const usedByParent = new Map<string, number>();
  for (const a of all) {
    if (!a.parentCode || !countsTowardSlot(a)) continue;
    usedByParent.set(a.parentCode, (usedByParent.get(a.parentCode) ?? 0) + 1);
  }

  const byKind = (kind: string) => all.filter((a) => a.codeKind === kind);
  const agencies = byKind("00");
  const partners = byKind("01");
  const staff = byKind("02");
  const unclassified = all.filter((a) => !["00", "01", "02"].includes(a.codeKind));
  const pending = all.filter((a) => a.slotRequestStatus === "申請中");

  /* --- 絞り込み --- */
  const matches = (a: Agency) => {
    if (!matchesKeyword(keyword, [a.code, a.name, a.representative])) return false;
    if (status !== ALL && a.status !== status) return false;
    if (rank !== ALL && a.rank !== rank) return false;
    if (channel !== ALL && a.channel !== channel) return false;
    if (area !== ALL && a.area !== area) return false;
    return true;
  };

  const inTab: Record<Tab, Agency[]> = {
    agency: agencies,
    partner: partners,
    staff: staff,
  };
  const filtered: Record<Tab, Agency[]> = {
    agency: agencies.filter(matches),
    partner: partners.filter(matches),
    staff: staff.filter(matches),
  };

  /* --- 並び替え --- */
  const accessors: Accessors<Agency> = {
    code: (a) => a.code,
    name: (a) => a.name,
    rank: (a) => rankOrder(a.rank),
    channel: (a) => a.channel,
    area: (a) => a.area,
    parent: (a) => a.parentName || a.parentCode,
    slot: (a) => usedByParent.get(a.code) ?? 0,
    status: (a) => statusOrder(a.status),
    email: (a) => a.email,
    created: (a) => a.createdAt,
  };
  const rows = sortRows(filtered[tab], sort.column, sort.desc, accessors);

  const current = TABS.find((t) => t.key === tab)!;
  const tabRows = inTab[tab];
  const isFiltered =
    Boolean(keyword) || status !== ALL || rank !== ALL || channel !== ALL || area !== ALL;
  const clearHref = buildListHref(BASE, params, {
    keyword: "",
    status: "",
    rank: "",
    channel: "",
    area: "",
  });

  // 選択肢は、いま開いているタブに実際にある値から作る（他のタブの値は出さない）
  const statusOptions = buildOptions(tabRows, (a) => a.status, STATUSES, status);
  const rankOptions = buildOptions(tabRows, (a) => a.rank, RANKS, rank);
  const channelOptions = buildOptions(tabRows, (a) => a.channel, CHANNELS, channel);
  const areaOptions = buildOptions(tabRows, (a) => a.area, [], area);

  // ログイン情報を発行できる相手（解約済みは除く）
  const withPassword = await listCodesWithPassword();
  const loginTargets = all
    .filter((a) => a.status !== "停止・解約" && a.code)
    .map((a) => ({
      code: a.code,
      name: a.name || "（名称未登録）",
      hasPassword: withPassword.has(a.code),
    }));

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="代理店"
          value={String(agencies.length)}
          unit="社"
          hint="コード区分 00 ・上位の枠を消費する"
        />
        <StatTile
          label="取次パートナー"
          value={String(partners.length)}
          unit="件"
          hint="コード区分 01 ・枠は消費しない"
        />
        <StatTile
          label="スタッフ"
          value={String(staff.length)}
          unit="名"
          hint="コード区分 02 ・枠は消費しない"
        />
        <StatTile
          label="増枠申請"
          value={String(pending.length)}
          unit="件"
          tone={pending.length > 0 ? "warn" : "default"}
          hint={pending.length > 0 ? "本部の承認待ちです" : "承認待ちはありません"}
        />
      </div>

      {pending.length > 0 ? (
        <Notice tone="warn">
          増枠の申請が {pending.length} 件届いています。
          <Link
            href="/admin/requests"
            className="ml-1.5 font-medium text-warn-100 underline underline-offset-2 hover:text-gold-300"
          >
            増枠申請の画面で確認する
          </Link>
        </Notice>
      ) : null}

      {unclassified.length > 0 ? (
        <Notice tone="warn">
          コード区分が入っていない登録が {unclassified.length} 件あります。どのタブにも出てこないため、
          kintone の代理店マスタでコード区分（00＝代理店 / 01＝取次 / 02＝スタッフ）を入れてください。
        </Notice>
      ) : null}

      <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-ink-800 bg-ink-900/70 p-1">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={buildListHref(BASE, params, {
                tab: t.key === "agency" ? "" : t.key,
              })}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition",
                active
                  ? "bg-gold-500/12 text-gold-300"
                  : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
              )}
            >
              <span>{t.label}</span>
              <span className={cn("tabnum text-xs", active ? "text-gold-400" : "text-ink-400")}>
                {filtered[t.key].length}
              </span>
            </Link>
          );
        })}
      </nav>

      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            tab: tab === "agency" ? "" : tab,
            sort: sort.column,
            dir: sort.desc ? "desc" : "asc",
          }}
        >
          <FilterText
            name="keyword"
            label="キーワード"
            value={keyword}
            placeholder="コード・名前・代表者"
            width="w-60"
          />
          <FilterSelect
            name="status"
            label="稼働状況"
            value={status}
            options={statusOptions}
            allLabel={`すべて（${tabRows.length}）`}
          />
          <FilterSelect name="rank" label="ランク" value={rank} options={rankOptions} />
          <FilterSelect
            name="channel"
            label="販路種別"
            value={channel}
            options={channelOptions}
            width="w-56"
          />
          <FilterSelect name="area" label="エリア" value={area} options={areaOptions} />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={tabRows.length}
          shown={rows.length}
          unit={current.unit}
          clearHref={clearHref}
          note={`${current.label}のタブ`}
        />
      ) : null}

      <Card title={`${current.label}　${rows.length} ${current.unit}`}>
        {rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(tab, isFiltered)}
            description={emptyDescription(tab, isFiltered)}
          />
        ) : tab === "agency" ? (
          <AgencyTable rows={rows} usedByParent={usedByParent} sort={sort} params={params} />
        ) : (
          <PeopleTable rows={rows} sort={sort} params={params} />
        )}
      </Card>

      {tab === "agency" && rows.length > 0 ? (
        <p className="text-xs leading-relaxed text-ink-400">
          枠は「直下にいる代理店（コード区分 00・解約分を除く）」の数を数えています。
          取次パートナーとスタッフは何社増えても枠を消費しません。
        </p>
      ) : null}

      <ResetRequests />

      <Card title="ポータルのログイン情報を発行">
        <IssuePassword agencies={loginTargets} />
      </Card>
    </div>
  );
}

/* ---------- 表（代理店タブ） ---------- */

function AgencyTable({
  rows,
  usedByParent,
  sort,
  params,
}: {
  rows: Agency[];
  usedByParent: Map<string, number>;
  sort: SortState;
  params: SearchParams;
}) {
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
    <Table>
      <thead>
        <tr>
          {th("code", "代理店コード")}
          {th("name", "法人名")}
          {th("rank", "ランク")}
          {th("channel", "販路種別")}
          {th("area", "エリア")}
          {th("parent", "上位代理店")}
          {th("slot", "枠", "right")}
          {th("status", "稼働ステータス")}
          {th("created", "登録日")}
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const limit = a.slotLimit || DEFAULT_SLOT_LIMIT;
          const used = usedByParent.get(a.code) ?? 0;
          const full = used >= limit;
          return (
            <tr key={a.recordId || a.code}>
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
                  <div className="truncate text-ink-100">{a.name || "（名称未登録）"}</div>
                  {a.representative ? (
                    <div className="truncate text-xs text-ink-400">{a.representative}</div>
                  ) : null}
                </div>
              </Td>
              <Td>{a.rank || "—"}</Td>
              <Td>{a.channel || "—"}</Td>
              <Td>{a.area || "—"}</Td>
              <Td>
                <Parent agency={a} />
              </Td>
              <Td
                numeric
                align="right"
                className={cn("whitespace-nowrap", full && "text-warn-500 font-medium")}
              >
                {used} / {limit}
                {full ? <span className="ml-1.5 text-xs">上限</span> : null}
                {a.specialSlot ? (
                  <span className="ml-1.5 align-middle">
                    <Badge tone="gold">特別枠</Badge>
                  </span>
                ) : null}
              </Td>
              <Td>
                <StatusBadge status={a.status} />
              </Td>
              <Td numeric className="whitespace-nowrap">
                {jpDate(a.createdAt)}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/* ---------- 表（取次・スタッフタブ） ---------- */

function PeopleTable({
  rows,
  sort,
  params,
}: {
  rows: Agency[];
  sort: SortState;
  params: SearchParams;
}) {
  const th = (column: string, label: string) => (
    <SortableTh column={column} label={label} sort={sort} basePath={BASE} params={params} />
  );

  return (
    <Table>
      <thead>
        <tr>
          {th("code", "コード")}
          {th("name", "氏名")}
          {th("channel", "販路種別")}
          {th("parent", "上位代理店")}
          {th("email", "メールアドレス")}
          {th("status", "稼働ステータス")}
          {th("created", "登録日")}
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.recordId || a.code}>
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
              <div className="truncate text-ink-100">{a.name || "（名称未登録）"}</div>
            </Td>
            <Td>{a.channel || "—"}</Td>
            <Td>
              <Parent agency={a} />
            </Td>
            <Td>
              {a.email ? (
                <a
                  href={`mailto:${a.email}`}
                  className="text-ink-200 underline underline-offset-2 hover:text-gold-300"
                >
                  {a.email}
                </a>
              ) : (
                <span className="text-ink-400">—</span>
              )}
            </Td>
            <Td>
              <StatusBadge status={a.status} />
            </Td>
            <Td numeric className="whitespace-nowrap">
              {jpDate(a.createdAt)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Parent({ agency }: { agency: Agency }) {
  if (!agency.parentName && !agency.parentCode) {
    return <span className="text-ink-400">—</span>;
  }
  return (
    <div className="min-w-0">
      <div className="truncate text-ink-200">{agency.parentName || agency.parentCode}</div>
      {agency.parentName && agency.parentCode ? (
        <div className="tabnum truncate text-xs text-ink-400">{agency.parentCode}</div>
      ) : null}
    </div>
  );
}

/* ---------- 空のときの文言 ---------- */

function emptyTitle(tab: Tab, filtered: boolean): string {
  if (filtered) return "条件に合うものがありません";
  if (tab === "agency") return "代理店がまだ登録されていません";
  if (tab === "partner") return "取次パートナーがまだ登録されていません";
  return "スタッフがまだ登録されていません";
}

function emptyDescription(tab: Tab, filtered: boolean): string {
  if (filtered) {
    return "条件を変えてお試しください。キーワードは法人名・代理店コード・代表者名の一部で探せます。別のタブに入っている可能性もあるので、タブの数字もご確認ください。";
  }
  if (tab === "agency") {
    return "代理店の申込が承認され、代理店マスタにコード区分 00 で登録されると、ここに自動で表示されます。";
  }
  if (tab === "partner") {
    return "取次パートナー（コード区分 01）は、代理店が発行した紹介用QRから申し込まれると、ここに自動で表示されます。枠は消費しません。";
  }
  return "スタッフ（コード区分 02）は、代理店が自社の担当者を登録すると、ここに自動で表示されます。枠は消費しません。";
}
