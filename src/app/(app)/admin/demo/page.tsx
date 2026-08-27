import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAllAgencies } from "@/lib/agencies";
import { select } from "@/lib/db";
import { todayInJapan } from "@/lib/demo";
import {
  ALL,
  buildListHref,
  buildOptions,
  matchesKeyword,
  parseSort,
  readParam,
  sortRows,
  type Accessors,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Th,
  cn,
} from "@/components/ui";
import {
  FilterActions,
  FilterBar,
  FilterSelect,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";
import { DemoForm, DemoRow, type AgencyOption, type DemoView } from "./DemoForm";

const BASE = "/admin/demo";

export const metadata = { title: "デモ機管理（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 本部のデモ機台帳。
 *
 * kintone の App13「VIS端末・デモ機管理」の代わりになる画面。
 * 本部が知りたいのは「いまどこに何台あるか」と
 * 「返却予定日を過ぎている台はどれか」の2つなので、
 * 状態ごとの台数を上に、期限切れを目立つ色で一覧に出している。
 * ------------------------------------------------------------------ */

/** 表の列数。入力欄を表いっぱいに広げるのに使う。 */
const COLUMN_COUNT = 10;

/** 台数のタイルに並べる状態。保存先の設定と同じ並びにしてある。 */
const STATES = ["在庫", "設置済", "貸出中", "返却済", "故障・修理", "廃棄"];

type Row = Record<string, unknown>;

const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

function toDemo(r: Row): DemoView {
  return {
    id: s_(r, "id"),
    serialNo: s_(r, "serial_no"),
    model: s_(r, "model"),
    acquiredKind: s_(r, "acquired_kind"),
    acquiredOn: s_(r, "acquired_on"),
    state: s_(r, "state"),
    holderCode: s_(r, "holder_code"),
    holderName: s_(r, "holder_name"),
    ownerCompany: s_(r, "owner_company"),
    customerName: s_(r, "customer_name"),
    lendTo: s_(r, "lend_to"),
    lendOn: s_(r, "lend_on"),
    returnDueOn: s_(r, "return_due_on"),
    returnedOn: s_(r, "returned_on"),
    purpose: s_(r, "purpose"),
    converted: s_(r, "converted"),
    note: s_(r, "note"),
  };
}

/**
 * 返却予定日を過ぎているか。
 * すでに返却日が入っているもの、返却済・廃棄になっているものは数えない。
 */
function isOverdue(m: DemoView, today: string): boolean {
  if (!m.returnDueOn || m.returnedOn) return false;
  if (m.state === "返却済" || m.state === "廃棄") return false;
  return m.returnDueOn < today;
}

/**
 * 返却予定日を何日過ぎているか。過ぎていなければ 0。
 * 「あと何日で返ってくるか」ではなく「何日待たせているか」を出したいので、
 * 今日から返却予定日を引いた日数を返す。
 */
function overdueDaysOf(m: DemoView, today: string): number {
  if (!isOverdue(m, today)) return 0;
  // どちらも "YYYY-MM-DD"。時差でずれないよう、日付だけを UTC として読む。
  const due = Date.parse(`${m.returnDueOn.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  const days = Math.round((now - due) / 86_400_000);
  return days > 0 ? days : 0;
}

/** 絞り込みの合図。"all" か 6つの状態、または "overdue"。 */
function toFilter(v: string): string {
  if (v === "overdue") return "overdue";
  return v && STATES.includes(v) ? v : "all";
}

/** 並び替えに使える列。 */
const SORT_COLUMNS = [
  "serial",
  "model",
  "acquired",
  "state",
  "holderCode",
  "ownerCompany",
  "holder",
  "lendTo",
  "returnDue",
];

/** 既定は取得したまま（登録の新しい順）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

/** 状態ごとの台数タイルの色。手当てが要るものだけ色を変える。 */
function tileTone(state: string, count: number): "default" | "gold" | "warn" {
  if (state === "貸出中" && count > 0) return "gold";
  if (state === "故障・修理" && count > 0) return "warn";
  return "default";
}

/** 状態ごとの補足。件数だけでは何をすればよいか分からないため。 */
function tileHint(state: string): string {
  if (state === "在庫") return "貸し出せる台数";
  if (state === "設置済") return "サロンなどに置いている台数";
  if (state === "貸出中") return "いま手元を離れている台数";
  if (state === "返却済") return "返ってきた台数。在庫に戻すと貸し出せます";
  if (state === "故障・修理") return "修理に出している台数";
  return "使わなくなった台数";
}

export default async function AdminDemoPage({
  searchParams,
}: {
  searchParams: Promise<{
    state?: string;
    model?: string;
    keyword?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const filter = toFilter(readParam(params, "state"));
  const model = readParam(params, "model") || ALL;
  const keyword = readParam(params, "keyword");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);
  const today = todayInJapan();

  let machines: DemoView[] = [];
  let agencyOptions: AgencyOption[] = [];
  let loadError: string | null = null;

  try {
    const [rows, agencies] = await Promise.all([
      select<Row>("demo_machines?select=*&order=acquired_on.desc.nullslast,id.desc"),
      listAllAgencies(),
    ]);
    machines = rows.map(toDemo);
    agencyOptions = agencies
      .filter((a) => a.code)
      .map((a) => ({ code: a.code, name: a.name || "（名称未登録）" }));
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "デモ機の台帳を読み込めませんでした。時間をおいて画面を読み込み直してください。";
  }

  const header = (
    <PageHeader
      title="デモ機管理"
      description="デモ機の在庫と貸出の台帳です。貸し出すときと返してもらったときに記録すると、返却予定日を過ぎた台がひと目で分かります。製品番号や保有者でも探せ、表の見出しを押すと並び替わります。"
    />
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          デモ機の台帳を読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、保存先（Supabase）の接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  const countByState = new Map<string, number>();
  for (const m of machines) {
    countByState.set(m.state, (countByState.get(m.state) ?? 0) + 1);
  }
  const overdue = machines.filter((m) => isOverdue(m, today));
  // いちばん長く待たせている台の日数。何日ぶんの遅れかで、連絡の急ぎ具合が変わる。
  const worstOverdue = overdue.reduce((max, m) => Math.max(max, overdueDaysOf(m, today)), 0);

  /* --- 状態のタブで分けたあと、キーワードと機種で絞り込む --- */
  const inChip =
    filter === "all"
      ? machines
      : filter === "overdue"
        ? overdue
        : machines.filter((m) => m.state === filter);

  const found = inChip.filter((m) => {
    if (model !== ALL && m.model !== model) return false;
    return matchesKeyword(keyword, [
      m.serialNo,
      m.model,
      m.holderName,
      m.holderCode,
      m.ownerCompany,
      m.lendTo,
      m.customerName,
    ]);
  });

  /* --- 並び替え --- */
  const accessors: Accessors<DemoView> = {
    serial: (m) => m.serialNo,
    model: (m) => m.model,
    acquired: (m) => m.acquiredKind,
    // 状態は五十音順ではなく、タイルと同じ並び（在庫→設置済→…）で並べる
    state: (m) => {
      const i = STATES.indexOf(m.state);
      return i < 0 ? null : i;
    },
    holderCode: (m) => m.holderCode,
    ownerCompany: (m) => m.ownerCompany,
    holder: (m) => m.holderName || m.holderCode,
    lendTo: (m) => m.lendTo,
    returnDue: (m) => m.returnDueOn,
  };
  const rows = sortRows(found, sort.column, sort.desc, accessors);

  const isFiltered = Boolean(keyword) || model !== ALL;
  const clearHref = buildListHref(BASE, params, { keyword: "", model: "" });
  const modelOptions = buildOptions(inChip, (m) => m.model, [], model);

  const chips: { key: string; label: string; count: number }[] = [
    { key: "all", label: "すべて", count: machines.length },
    ...STATES.map((s) => ({ key: s, label: s, count: countByState.get(s) ?? 0 })),
    { key: "overdue", label: "返却予定日を過ぎている", count: overdue.length },
  ];
  const currentChip = chips.find((c) => c.key === filter)!;

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {STATES.map((s) => {
          const count = countByState.get(s) ?? 0;
          return (
            <StatTile
              key={s}
              label={s}
              value={String(count)}
              unit="台"
              tone={tileTone(s, count)}
              hint={tileHint(s)}
            />
          );
        })}
      </div>

      {overdue.length > 0 ? (
        <Notice tone="warn">
          返却予定日を過ぎているデモ機が {overdue.length} 台あります
          （いちばん長いもので {worstOverdue.toLocaleString("ja-JP")} 日超過）。貸出先にご確認のうえ、
          回収するか、返却予定日を入れ直してください。
          <Link
            href={buildListHref(BASE, params, { state: "overdue" })}
            className="ml-1.5 font-medium text-warn-100 underline underline-offset-2 hover:text-gold-300"
          >
            この {overdue.length} 台だけを見る
          </Link>
        </Notice>
      ) : null}

      <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-ink-800 bg-ink-900/70 p-1">
        {chips.map((c) => {
          const active = c.key === filter;
          return (
            <Link
              key={c.key}
              href={buildListHref(BASE, params, { state: c.key === "all" ? "" : c.key })}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition",
                active
                  ? "bg-gold-500/12 text-gold-300"
                  : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
              )}
            >
              <span>{c.label}</span>
              <span className={cn("tabnum text-xs", active ? "text-gold-400" : "text-ink-400")}>
                {c.count}
              </span>
            </Link>
          );
        })}
      </nav>

      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            state: filter === "all" ? "" : filter,
            sort: sort.column,
            dir: sort.column ? (sort.desc ? "desc" : "asc") : "",
          }}
        >
          <FilterText
            name="keyword"
            label="キーワード"
            value={keyword}
            placeholder="製品番号・保有者・貸出先"
            width="w-64"
          />
          <FilterSelect
            name="model"
            label="機種"
            value={model}
            options={modelOptions}
            allLabel={`すべて（${inChip.length}）`}
            width="w-52"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={inChip.length}
          shown={rows.length}
          unit="台"
          clearHref={clearHref}
          note={`「${currentChip.label}」のうち`}
        />
      ) : null}

      <Card title={`${currentChip.label}　${rows.length} 台`}>
        {rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(filter, isFiltered)}
            description={emptyDescription(filter, isFiltered)}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh column="serial" label="製品番号" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="model" label="機種" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="acquired" label="取得区分" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="state" label="状態" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="holderCode" label="保有代理店コード" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="ownerCompany" label="自社会社名" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="holder" label="保有者（責任者）" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="lendTo" label="貸出先" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="returnDue" label="返却予定日" sort={sort} basePath={BASE} params={params} />
                <Th align="right">手続き</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <DemoRow
                  key={m.id}
                  machine={m}
                  agencies={agencyOptions}
                  today={today}
                  overdueDays={overdueDaysOf(m, today)}
                  columnCount={COLUMN_COUNT}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="デモ機を登録する">
        <DemoForm agencies={agencyOptions} />
      </Card>

      <Notice tone="info">
        「保有代理店コード」は、その台を持っている代理店のコードです。
        「保有者（責任者）」は、その台を預かって管理している方のお名前です（デモ機登録フォームの
        「使用者名」にあたります）。同じ苗字の方がいても、コードを見ればどちらの代理店の台か分かります。
        <br />
        「自社会社名」は、申込のときにご本人が名乗った会社名です。エリア統括代理店や
        個人販売代理店のように自分のコードをお持ちでない場合、保有代理店コードは所属先のものになるため、
        どなたの台かはこの欄で見分けます。
        <br />
        「取得区分」は、登録欄の「取得のしかた」と同じ項目です（個人購入／デモ機購入／無料貸与）。
        無料貸与の台は本部からお預けしているものなので、返却のご連絡が必要になります。
        <br />
        代理店の「デモ機」の画面にも、同じ内容が表示されます。
      </Notice>
    </div>
  );
}

/* ---------- 空のときの文言 ---------- */

function emptyTitle(filter: string, filtered: boolean): string {
  if (filtered) return "条件に合うものがありません";
  if (filter === "overdue") return "返却予定日を過ぎているデモ機はありません";
  if (filter === "all") return "デモ機がまだ登録されていません";
  return `「${filter}」のデモ機はありません`;
}

function emptyDescription(filter: string, filtered: boolean): string {
  if (filtered) {
    return "条件を変えてお試しください。キーワードは製品番号・機種・保有者・貸出先の一部で探せます。上のタブで「すべて」を選ぶと、台帳全体から探せます。";
  }
  if (filter === "overdue") {
    return "貸出中の台はすべて返却予定日の前です。予定日を過ぎるとここに出てきます。";
  }
  if (filter === "all") {
    return "下の「デモ機を登録する」から、製品番号を入れて登録してください。デモ機登録フォームから届いた申請も、ここに表示されます。";
  }
  return "上のタブから別の状態を選ぶか、「すべて」で台帳全体をご確認ください。";
}
