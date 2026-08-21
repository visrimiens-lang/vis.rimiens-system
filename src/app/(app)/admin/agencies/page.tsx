import Link from "next/link";
import { redirect } from "next/navigation";
import { PASSWORD_FIELD, currentViewer } from "@/lib/auth";
import { select, selectAll } from "@/lib/db";
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
import { AGENCY_TYPES, agencyTypeOf, channelLabel, statusTone } from "@/lib/labels";
import { PayUnitCell } from "@/components/PayUnitCell";
import { defaultPayUnit } from "@/lib/pay-defaults";
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
import {
  FilterActions,
  FilterBar,
  FilterSelect,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";
import { IssuePassword } from "./IssuePassword";
import { StopButton } from "./StopButton";
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
  "phone",
  "password",
  "created",
];

const DEFAULT_SORT: SortState = { column: "code", desc: false };

/** ログイン情報の発行状況で絞り込むときの合図。 */
const PASSWORD_FILTERS = ["none", "issued"];

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

/**
 * ポータルのログイン情報（パスワード）を発行済みの代理店コードを集める。
 *
 * ここで自分で問い合わせているのは、失敗を必ず呼び出し側に伝えるため。
 * 「取得できなかった」と「1件も発行されていない」を取り違えると、
 * 稼働中の代理店まで「未発行」と表示してしまい、本部がそれを信じて
 * 再発行すると、いま使われているパスワードが使えなくなる。
 * 失敗したときは例外をそのまま投げ、画面側で「確認できません」と出す。
 */
async function loadCodesWithPassword(): Promise<Set<string>> {
  // 判定に要るのは2項目だけ。ハッシュを含む全項目は引かない。
  // selectAll で最後まで取る（1000件で切られると発行済みが「未発行」に見えるため）。
  const rows = await selectAll<Record<string, unknown>>(
    `agencies?select=code,${PASSWORD_FIELD}&order=code.asc`,
  );
  const out = new Set<string>();
  for (const r of rows) {
    const hash = r[PASSWORD_FIELD];
    const code = r.code;
    if (hash === null || hash === undefined || String(hash) === "") continue;
    if (code === null || code === undefined || String(code) === "") continue;
    out.add(String(code));
  }
  return out;
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
    pw?: string;
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
  // 絞り込みは申込フォームと同じ「代理店種別」で行う（ランクは画面に出さない）
  const rank = readParam(params, "rank") || ALL;
  const channel = readParam(params, "channel") || ALL;
  const area = readParam(params, "area") || ALL;
  const askedPw = readChoice(params, "pw", PASSWORD_FILTERS);
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let all: Agency[] = [];
  // ポータルのログイン情報を発行済みの代理店コード。
  // 一覧の列と絞り込みの両方で使うので、行を組み立てる前に引いておく。
  // null は「取得できなかった」という意味。「1件も発行されていない」と区別する。
  let withPassword: Set<string> | null = null;
  let loadError: string | null = null;
  // 代理店マスタが読めても、発行状況の問い合わせだけが失敗することがある。
  // 片方の失敗でもう片方を巻き添えにしないよう、それぞれの結果を別々に見る。
  const [agencyResult, passwordResult, inboxResult] = await Promise.allSettled([
    listAllAgencies(),
    loadCodesWithPassword(),
    /*
     * 受信箱に取り込めずに残っている件数。
     * 本部が最初に開くのはこの画面なので、ここに出さないと
     * 申込や受注の取りこぼしが誰の目にも触れないまま溜まる。
     * 実際、決済7件が「報酬が1件も計上されませんでした」のまま
     * 3週間気づかれずに残っていた。
     */
    select<Record<string, unknown>>("inbox?select=id&processed=eq.false"),
  ]);
  const stuckInbox =
    inboxResult.status === "fulfilled" ? inboxResult.value.length : 0;
  if (agencyResult.status === "fulfilled") {
    all = agencyResult.value;
  } else {
    loadError =
      agencyResult.reason instanceof Error
        ? agencyResult.reason.message
        : "代理店マスタの読み込みに失敗しました。時間をおいて開き直してください。";
  }
  if (passwordResult.status === "fulfilled") withPassword = passwordResult.value;

  // 発行済みかどうかが分かっているときだけ、パスワードでの絞り込みを受け付ける。
  const passwordKnown = withPassword !== null;
  const pw = passwordKnown ? askedPw : ALL;

  const header = (
    <PageHeader
      title="代理店管理"
      description="代理店マスタに登録されている取引先の一覧です。コード区分ごとにタブが分かれています。見出しを押すと、その列で並び替えられます。"
    />
  );

  /*
   * まだ稼働中になっていない代理店。
   *
   * 承認フローは廃止したので、いま申込フォームから届くものは「稼働中」で入る。
   * ここに出るのは、廃止より前に届いて未稼働のまま残っているものだけ。
   * 放っておくと本人はログインもQRも受け取れないため、まっさきに知らせる。
   */
  const waitingApproval = all.filter(
    (a) => a.status === "未稼働" && a.registeredVia && a.registeredVia !== "手動登録",
  );

  /* 取り込めずに残っている申込・受注があれば、まっさきに知らせる。 */
  const approvalNotice =
    waitingApproval.length > 0 ? (
      <Notice tone="warn">
        申込フォームから届いたまま{" "}
        <strong className="text-ink-100">
          稼働中になっていない代理店が {waitingApproval.length} 件
        </strong>{" "}
        あります（
        {waitingApproval.slice(0, 3).map((a) => a.name || a.code).join("・")}
        {waitingApproval.length > 3 ? " ほか" : ""}）。
        このままではログインのご案内が届きません。代理店コードを押して内容を確かめ、
        「稼働中にする」を押してください。
        <Link
          href={buildListHref(BASE, params, { status: "未稼働", tab: "" })}
          className="ml-2 underline underline-offset-4 hover:text-ink-50"
        >
          未稼働だけを見る
        </Link>
      </Notice>
    ) : null;

  const inboxNotice =
    stuckInbox > 0 ? (
      <Notice tone="warn">
        受信箱に取り込めていないものが <strong className="text-ink-100">{stuckInbox} 件</strong>{" "}
        あります。申込や受注が登録されないまま残っている可能性があります。
        <Link
          href="/admin/inbox"
          className="ml-2 underline underline-offset-4 hover:text-ink-50"
        >
          受信箱を開く
        </Link>
      </Notice>
    ) : null;

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          代理店マスタを読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、データベースの接続設定（接続先URLと認証情報）をご確認ください。
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
  /** 発行済みなら true、未発行なら false、発行状況を確認できなければ null。 */
  const hasPassword = (a: Agency): boolean | null =>
    withPassword ? Boolean(a.code) && withPassword.has(a.code) : null;

  const matches = (a: Agency) => {
    if (!matchesKeyword(keyword, [a.code, a.name, a.representative, a.email, a.phone]))
      return false;
    if (status !== ALL && a.status !== status) return false;
    if (rank !== ALL && agencyTypeOf(a.rank, a.channel, a.codeKind) !== rank)
      return false;
    if (channel !== ALL && a.channel !== channel) return false;
    if (area !== ALL && a.area !== area) return false;
    if (pw === "none" && hasPassword(a)) return false;
    if (pw === "issued" && !hasPassword(a)) return false;
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
    phone: (a) => a.phone,
    // 未発行を先に出す（＝手当てが要るものを上に集める）。
    // 確認できないときは空欄扱いにして、並び順で優劣を付けない。
    password: (a) => {
      const issued = hasPassword(a);
      return issued === null ? null : issued ? 1 : 0;
    },
    created: (a) => a.createdAt,
  };
  const rows = sortRows(filtered[tab], sort.column, sort.desc, accessors);

  const current = TABS.find((t) => t.key === tab)!;
  const tabRows = inTab[tab];
  const isFiltered =
    Boolean(keyword) ||
    status !== ALL ||
    rank !== ALL ||
    channel !== ALL ||
    area !== ALL ||
    pw !== ALL;
  const clearHref = buildListHref(BASE, params, {
    keyword: "",
    status: "",
    rank: "",
    channel: "",
    area: "",
    pw: "",
  });

  /* --- よく使う絞り込み（未稼働・パスワード未発行を1押しで探せるように） --- */
  const quickFilters: { key: string; label: string; href: string; active: boolean }[] = [
    {
      key: "idle",
      label: "未稼働だけ",
      href: buildListHref(BASE, params, {
        status: status === "未稼働" ? "" : "未稼働",
      }),
      active: status === "未稼働",
    },
  ];
  // 発行状況が確認できないときは、絞り込みも件数も出さない（未発行と断定しない）。
  if (passwordKnown) {
    quickFilters.push({
      key: "nopw",
      label: "パスワード未発行だけ",
      href: buildListHref(BASE, params, { pw: pw === "none" ? "" : "none" }),
      active: pw === "none",
    });
  }
  const noPasswordCount = tabRows.filter((a) => hasPassword(a) === false).length;

  // 選択肢は、いま開いているタブに実際にある値から作る（他のタブの値は出さない）
  // 絞り込みに渡す値はデータベースのままにして、画面に出す文言だけ呼び方を差し替える。
  const statusOptions = buildOptions(tabRows, (a) => a.status, STATUSES, status);
  const rankOptions = buildOptions(
    tabRows,
    (a) => agencyTypeOf(a.rank, a.channel, a.codeKind),
    AGENCY_TYPES.map((t) => t.value),
    rank,
  ).filter((o) => o.count > 0 || o.value === rank);
  const channelOptions = buildOptions(tabRows, (a) => a.channel, CHANNELS, channel).map(
    (o) => ({ ...o, label: channelLabel(o.value) }),
  );
  const areaOptions = buildOptions(tabRows, (a) => a.area, [], area);

  // ログイン情報を発行できる相手（解約済みは除く）
  // 発行状況が確認できないときは「発行済み」と印を付けられない。
  // 代わりに、発行の欄そのものに注意書きを出す。
  const loginTargets = all
    .filter((a) => a.status !== "停止・解約" && a.code)
    .map((a) => ({
      code: a.code,
      name: a.name || "（名称未登録）",
      hasPassword: withPassword ? withPassword.has(a.code) : false,
    }));

  return (
    <div className="space-y-6">
      {header}
      {approvalNotice}
      {inboxNotice}

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
          代理店の詳細画面でコード区分（00＝代理店 / 01＝取次 / 02＝スタッフ）を入れてください。
        </Notice>
      ) : null}

      {passwordKnown ? null : (
        <Notice tone="warn">
          ログイン情報の発行状況を取得できませんでした。
          発行済みか未発行かが分からないため、「パスワード」の列は「—（確認できません）」と表示し、
          パスワードでの絞り込みと未発行の件数は出していません
          {askedPw === ALL ? "" : "（お使いだった絞り込みも一時的に外しています）"}。
          この状態でパスワードを発行すると、すでに使われているパスワードがある場合は使えなくなります。
          時間をおいて画面を開き直し、発行状況が出てからお進みください。
        </Notice>
      )}

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
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-5 py-3.5">
          <span className="text-xs font-medium tracking-wide text-ink-300">
            よく使う絞り込み
          </span>
          {quickFilters.map((q) => (
            <Link
              key={q.key}
              href={q.href}
              aria-pressed={q.active}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm transition",
                q.active
                  ? "border-gold-500/50 bg-gold-500/12 text-gold-300"
                  : "border-ink-700 text-ink-200 hover:border-ink-600 hover:text-ink-50",
              )}
            >
              {q.label}
              {q.active ? <span className="ml-1.5 text-xs">（解除）</span> : null}
            </Link>
          ))}
          {passwordKnown ? (
            <span className="text-xs text-ink-400">
              このタブで、パスワード未発行は {noPasswordCount} 件です。
            </span>
          ) : (
            <span className="text-xs text-ink-400">
              パスワードの発行状況は確認できませんでした。
            </span>
          )}
        </div>

        <FilterBar
          action={BASE}
          hidden={{
            tab: tab === "agency" ? "" : tab,
            pw: pw === ALL ? "" : pw,
            sort: sort.column,
            dir: sort.desc ? "desc" : "asc",
          }}
        >
          <FilterText
            name="keyword"
            label="キーワード"
            value={keyword}
            placeholder="コード・名前・代表者・メール・電話"
            width="w-60"
          />
          <FilterSelect
            name="status"
            label="稼働状況"
            value={status}
            options={statusOptions}
            allLabel={`すべて（${tabRows.length}）`}
          />
          {/*
            スタッフは全員が「スタッフ」・販路種別もエリアも持たない。
            選んでも結果が変わらない欄は、このタブでは出さない。
          */}
          {tab === "staff" ? null : (
            <FilterSelect
              name="rank"
              label="代理店種別"
              value={rank}
              options={rankOptions}
            />
          )}
          {tab === "staff" ? null : (
            <FilterSelect
              name="channel"
              label="販路種別"
              value={channel}
              options={channelOptions}
              width="w-56"
            />
          )}
          {tab === "agency" ? (
            <FilterSelect name="area" label="エリア" value={area} options={areaOptions} />
          ) : null}
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={tabRows.length}
          shown={rows.length}
          unit={current.unit}
          clearHref={clearHref}
          note={`${current.label}のタブ${
            pw === "none"
              ? "・パスワード未発行だけ"
              : pw === "issued"
                ? "・パスワード発行済だけ"
                : ""
          }`}
        />
      ) : null}

      <Card title={`${current.label}　${rows.length} ${current.unit}`}>
        {rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(tab, isFiltered)}
            description={emptyDescription(tab, isFiltered)}
          />
        ) : tab === "agency" ? (
          <AgencyTable
            rows={rows}
            usedByParent={usedByParent}
            hasPassword={hasPassword}
            sort={sort}
            params={params}
          />
        ) : (
          <PeopleTable
            tab={tab}
            rows={rows}
            hasPassword={hasPassword}
            sort={sort}
            params={params}
          />
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
        {passwordKnown ? null : (
          <div className="px-5 pt-5">
            <Notice tone="warn">
              いま、どの代理店にパスワードが発行済みかを確認できていません。
              一覧の「（発行済み）」の印も出せていないため、すでに発行されている相手に
              気づかず再発行してしまうおそれがあります。再発行すると、いま使われている
              パスワードは使えなくなります。発行状況が表示されるまでお待ちください。
            </Notice>
          </div>
        )}
        <IssuePassword agencies={loginTargets} />
      </Card>
    </div>
  );
}

/* ---------- 表（代理店タブ） ---------- */

function AgencyTable({
  rows,
  usedByParent,
  hasPassword,
  sort,
  params,
}: {
  rows: Agency[];
  usedByParent: Map<string, number>;
  /** ポータルのログイン情報を発行済みか（確認できないときは null） */
  hasPassword: (a: Agency) => boolean | null;
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
          <Th align="right">支払額（1台・税抜）</Th>
          {th("status", "稼働ステータス")}
          {th("email", "メールアドレス")}
          {th("phone", "電話番号")}
          {th("password", "パスワード")}
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
              {/* 申込フォームと同じ呼び方で出す（「2次代理店」「取次店」ではなく） */}
              <Td className="whitespace-nowrap">{agencyTypeOf(a.rank, a.channel, a.codeKind)}</Td>
              <Td>{channelLabel(a.channel)}</Td>
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
              {/*
                この代理店に払う1台あたりの額。本部は誰の額でも変えられる
                （権限の判定は actions/pay-unit-actions.ts が行う）。
                空欄なら既定（推奨の税抜単価）が使われる。
              */}
              <Td numeric align="right">
                <PayUnitCell
                  code={a.code}
                  name={a.name || a.code}
                  value={a.payUnit}
                  fallback={defaultPayUnit(a)}
                  note={a.payUnitNote}
                  editable
                />
              </Td>
              <Td>
                <Status status={a.status} />
              </Td>
              <Td>
                <Mail email={a.email} />
              </Td>
              <Td numeric className="whitespace-nowrap">
                <Tel phone={a.phone} />
              </Td>
              <Td className="whitespace-nowrap">
                <PasswordMark issued={hasPassword(a)} />
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
  tab,
  rows,
  hasPassword,
  sort,
  params,
}: {
  tab: Tab;
  rows: Agency[];
  /** ポータルのログイン情報を発行済みか（確認できないときは null） */
  hasPassword: (a: Agency) => boolean | null;
  sort: SortState;
  params: SearchParams;
}) {
  const isStaff = tab === "staff";
  /*
   * スタッフ・取次パートナーのコードは「所属会社の英字4文字＋4桁」。
   * 1列にまとめると SASA0001 が会社のコードに見えてしまうため、
   * 本人のコードと、所属している会社のコードを別の列にする。
   */
  const codeLabel = isStaff ? "スタッフコード" : "パートナーコード";
  /*
   * 全員が同じ値になる列は出さない。
   * スタッフは全員が「スタッフ」で、支払先にもならない（お支払いは会社ごと）。
   * ただし、誰かに個別の支払額が入っているときは、隠すと気づけなくなるので出す。
   */
  const showKind = new Set(rows.map((a) => agencyTypeOf(a.rank, a.channel, a.codeKind))).size > 1;
  const showPay = !isStaff || rows.some((a) => a.payUnit !== null && a.payUnit !== undefined);
  const th = (column: string, label: string) => (
    <SortableTh column={column} label={label} sort={sort} basePath={BASE} params={params} />
  );

  return (
    <Table>
      <thead>
        <tr>
          {th("code", codeLabel)}
          {th("parent", "代理店コード")}
          {th("name", "氏名")}
          {showKind ? th("rank", "区分") : null}
          <Th>所属代理店</Th>
          {isStaff ? null : th("channel", "販路種別")}
          {showPay ? <Th align="right">支払額（1台・税抜）</Th> : null}
          {th("status", "稼働ステータス")}
          {isStaff ? <Th>QR</Th> : null}
          {isStaff ? <Th>QRを止める</Th> : null}
          {th("email", "メールアドレス")}
          {th("phone", "電話番号")}
          {th("password", "パスワード")}
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
            <Td numeric className="whitespace-nowrap text-ink-300">
              {a.parentCode || "—"}
            </Td>
            <Td>
              <div className="truncate text-ink-100">{a.name || "（名称未登録）"}</div>
            </Td>
            {/* 申込フォームと同じ呼び方で出す（「2次代理店」「取次店」ではなく） */}
            {showKind ? (
              <Td className="whitespace-nowrap">
                {agencyTypeOf(a.rank, a.channel, a.codeKind)}
              </Td>
            ) : null}
            <Td>
              <div className="truncate text-ink-200">
                {a.parentName || a.parentCode || "—"}
              </div>
            </Td>
            {isStaff ? null : <Td>{channelLabel(a.channel)}</Td>}
            {showPay ? (
              <Td numeric align="right">
                <PayUnitCell
                  code={a.code}
                  name={a.name || a.code}
                  value={a.payUnit}
                  fallback={defaultPayUnit(a)}
                  note={a.payUnitNote}
                  editable
                />
              </Td>
            ) : null}
            <Td>
              <Status status={a.status} />
            </Td>
            {isStaff ? (
              <Td className="whitespace-nowrap">
                <QrMark agency={a} />
              </Td>
            ) : null}
            {isStaff ? (
              <Td>
                {a.qr1Url || a.qr2Url || qrFrozen(a) ? (
                  <StopButton
                    code={a.code}
                    name={a.name || a.code}
                    frozen={qrFrozen(a)}
                  />
                ) : (
                  <span className="whitespace-nowrap text-xs text-ink-500">
                    QRが未発行です
                  </span>
                )}
              </Td>
            ) : null}
            <Td>
              <Mail email={a.email} />
            </Td>
            <Td numeric className="whitespace-nowrap">
              <Tel phone={a.phone} />
            </Td>
            <Td className="whitespace-nowrap">
              <PasswordMark issued={hasPassword(a)} />
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

/* ---------- 表の中の小さな部品 ---------- */

/**
 * QRの停止は「QR2の発行申請を差戻しにして、理由の頭に目印を付ける」形で持っている。
 * ★ actions/qr-actions.ts と admin/agencies/[code]/QrPanel.tsx にも同じ文字列がある。
 *   片方だけ変えると停止中を見分けられなくなるので、必ずそろえること。
 */
const FREEZE_MARK = "【QR停止】";

function qrFrozen(a: Agency): boolean {
  return a.qr2Status === "差戻し" && a.qr2RejectedNote.startsWith(FREEZE_MARK);
}

/** QRを渡しているか、いま止めているか。止めた理由もその場で読めるようにする。 */
function QrMark({ agency }: { agency: Agency }) {
  if (qrFrozen(agency)) {
    const reason = agency.qr2RejectedNote.slice(FREEZE_MARK.length).trim();
    return (
      <div>
        <Badge tone="bad">停止中</Badge>
        {reason ? (
          <div className="mt-1 max-w-40 truncate text-xs text-ink-400" title={reason}>
            {reason}
          </div>
        ) : null}
      </div>
    );
  }
  const has = [agency.qr1Url ? "体験" : "", agency.qr2Url ? "ご契約" : ""].filter(Boolean);
  if (has.length === 0) return <span className="text-xs text-ink-500">未発行</span>;
  return <span className="text-xs text-ink-300">{has.join("・")}</span>;
}

/** 稼働ステータス。色は labels.ts の statusTone に合わせる。 */
function Status({ status }: { status: string }) {
  if (!status) return <span className="text-ink-400">—</span>;
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

/** 本部から連絡するときのために、そのまま押せる形にしておく。 */
function Mail({ email }: { email: string }) {
  if (!email) return <span className="text-ink-400">—</span>;
  return (
    <a
      href={`mailto:${email}`}
      className="text-ink-200 underline underline-offset-2 hover:text-gold-300"
    >
      {email}
    </a>
  );
}

function Tel({ phone }: { phone: string }) {
  if (!phone) return <span className="text-ink-400">—</span>;
  return (
    <a
      href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
      className="text-ink-200 underline underline-offset-2 hover:text-gold-300"
    >
      {phone}
    </a>
  );
}

/**
 * ポータルにログインできる状態かどうか。未発行はこのあと発行する相手。
 * 発行状況そのものを取得できなかったときは、未発行と決めつけずに「確認できません」と出す。
 */
function PasswordMark({ issued }: { issued: boolean | null }) {
  if (issued === null) {
    return <span className="text-ink-400">—（確認できません）</span>;
  }
  return issued ? <Badge tone="good">発行済</Badge> : <Badge tone="warn">未発行</Badge>;
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
    return "条件を変えてお試しください。キーワードは法人名・代理店コード・代表者名・メールアドレス・電話番号の一部で探せます。「よく使う絞り込み」を押している場合は、もう一度押すと解除できます。別のタブに入っている可能性もあるので、タブの数字もご確認ください。";
  }
  if (tab === "agency") {
    return "申込フォームから届いてコード区分 00 で登録されると、ここに自動で表示されます。";
  }
  if (tab === "partner") {
    return "取次パートナー（コード区分 01）は、代理店が発行した紹介用QRから申し込まれると、ここに自動で表示されます。枠は消費しません。";
  }
  return "スタッフ（コード区分 02）は、代理店が自社の担当者を登録すると、ここに自動で表示されます。枠は消費しません。";
}
