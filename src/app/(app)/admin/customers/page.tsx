import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAllAgencies } from "@/lib/agencies";
import { select } from "@/lib/db";
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
import type { Agency } from "@/lib/types";
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
import { CustomerRow, type CustomerView } from "./CustomerForm";

const BASE = "/admin/customers";

export const metadata = { title: "顧客管理（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 本部の顧客管理。
 *
 * kintone の顧客台帳（App11）の代わりになる画面。
 * 本部がやりたいことは大きく2つで、
 *   ・お名前や電話番号でその方を探す
 *   ・住所の書き間違いを直す（出荷前に気づくことが多い）
 * 取次店から紹介された方と、一般のお申し込みを分けて見られるようにしてある
 * （2026-07-09 の回答書でお約束したもの）。
 * ------------------------------------------------------------------ */

/** 一度に読み込む上限。これを超えたら、検索して絞り込んでもらう。 */
const LIMIT = 1000;

/** 表の列数。修正欄を表いっぱいに広げるのに使う。 */
const COLUMN_COUNT = 9;

type Kind = "all" | "introduced" | "general";

const TABS: { key: Kind; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "introduced", label: "取次店の紹介" },
  { key: "general", label: "一般" },
];

function toKind(v: string): Kind {
  return v === "introduced" || v === "general" ? v : "all";
}

/** 並び替えに使える列。 */
const SORT_COLUMNS = [
  "name",
  "phone",
  "agency",
  "referrer",
  "review",
  "payment",
  "ship",
  "contracted",
];

/** 既定はデータベースから受け取ったまま（登録の新しい順）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

type Row = Record<string, unknown>;

const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

function toCustomer(r: Row): CustomerView {
  return {
    id: s_(r, "id"),
    name: s_(r, "name"),
    nameKana: s_(r, "name_kana"),
    email: s_(r, "email"),
    phone: s_(r, "phone"),
    zip: s_(r, "zip"),
    address: s_(r, "address"),
    building: s_(r, "building"),
    receiptName: s_(r, "receipt_name"),
    note: s_(r, "note"),
    referrerCode: s_(r, "referrer_code"),
    agencyCode: s_(r, "agency_code"),
    staffCode: s_(r, "staff_code"),
    reviewStatus: s_(r, "review_status"),
    paymentStatus: s_(r, "payment_status"),
    paymentMethod: s_(r, "payment_method"),
    contractedOn: s_(r, "contracted_on"),
    shipStatus: s_(r, "ship_status"),
    trackingNo: s_(r, "tracking_no"),
    serialNo: s_(r, "serial_no"),
  };
}

/**
 * 取次店から紹介された方かどうか。
 * 紹介元コードが入っていれば紹介、空か「（直接）」なら一般のお申し込み。
 */
function isIntroduced(c: CustomerView): boolean {
  const v = c.referrerCode.trim();
  return Boolean(v) && v !== "（直接）";
}

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    keyword?: string;
    review?: string;
    payment?: string;
    ship?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const kind = toKind(readParam(params, "kind"));
  const keyword = readParam(params, "keyword");
  const review = readParam(params, "review") || ALL;
  const payment = readParam(params, "payment") || ALL;
  const ship = readParam(params, "ship") || ALL;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let customers: CustomerView[] = [];
  let agencies: Agency[] = [];
  let loadError: string | null = null;

  try {
    const [rows, all] = await Promise.all([
      select<Row>(`customers?select=*&order=created_at.desc,id.desc&limit=${LIMIT}`),
      listAllAgencies(),
    ]);
    customers = rows.map(toCustomer);
    agencies = all;
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "お客様の一覧を読み込めませんでした。時間をおいて画面を読み込み直してください。";
  }

  const header = (
    <PageHeader
      title="顧客管理"
      description="ご契約いただいたお客様の一覧です。お名前と電話番号で探せ、審査・お支払い・出荷の状態でも絞り込めます。表の見出しを押すと並び替わります。住所や連絡先の書き間違いは、この画面から直せます。"
    />
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          お客様の一覧を読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、保存先（Supabase）の接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  const nameByCode = new Map(agencies.map((a) => [a.code, a.name]));

  // 検索は、お名前・フリガナ・電話番号のどれかに含まれていれば当たりにする
  const matches = (c: CustomerView) => {
    if (!matchesKeyword(keyword, [c.name, c.nameKana, c.phone])) return false;
    if (review !== ALL && c.reviewStatus !== review) return false;
    if (payment !== ALL && c.paymentStatus !== payment) return false;
    if (ship !== ALL && c.shipStatus !== ship) return false;
    return true;
  };

  const found = customers.filter(matches);
  const introduced = found.filter(isIntroduced);
  const general = found.filter((c) => !isIntroduced(c));
  const counts: Record<Kind, number> = {
    all: found.length,
    introduced: introduced.length,
    general: general.length,
  };

  // 絞り込む前の件数。「◯名中◯名」の左側に使う。
  const tabTotal =
    kind === "introduced"
      ? customers.filter(isIntroduced).length
      : kind === "general"
        ? customers.filter((c) => !isIntroduced(c)).length
        : customers.length;

  /* --- 並び替え --- */
  const accessors: Accessors<CustomerView> = {
    name: (c) => c.nameKana || c.name,
    phone: (c) => c.phone,
    agency: (c) => c.agencyCode,
    referrer: (c) => c.referrerCode,
    review: (c) => c.reviewStatus,
    payment: (c) => c.paymentStatus,
    ship: (c) => c.shipStatus,
    contracted: (c) => c.contractedOn,
  };
  const rows = sortRows(
    kind === "introduced" ? introduced : kind === "general" ? general : found,
    sort.column,
    sort.desc,
    accessors,
  );

  const isFiltered = Boolean(keyword) || review !== ALL || payment !== ALL || ship !== ALL;
  const clearHref = buildListHref(BASE, params, {
    keyword: "",
    review: "",
    payment: "",
    ship: "",
  });
  const reviewOptions = buildOptions(customers, (c) => c.reviewStatus, [], review);
  const paymentOptions = buildOptions(customers, (c) => c.paymentStatus, [], payment);
  const shipOptions = buildOptions(customers, (c) => c.shipStatus, [], ship);

  const beforeShipping = found.filter((c) => c.shipStatus !== "出荷済").length;
  const truncated = customers.length >= LIMIT;
  const current = TABS.find((t) => t.key === kind)!;

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="お客様"
          value={String(counts.all)}
          unit="名"
          hint={keyword ? `「${keyword}」に一致する方` : "登録されている全員"}
        />
        <StatTile
          label="取次店の紹介"
          value={String(counts.introduced)}
          unit="名"
          tone="gold"
          hint="紹介元の取次店コードが入っている方"
        />
        <StatTile
          label="一般"
          value={String(counts.general)}
          unit="名"
          hint="紹介元が入っていないお申し込み"
        />
        <StatTile
          label="お届け前"
          value={String(beforeShipping)}
          unit="名"
          tone={beforeShipping > 0 ? "warn" : "default"}
          hint={
            beforeShipping > 0
              ? "まだ出荷済になっていない方。住所の直しはお早めに"
              : "出荷が済んでいない方はいません"
          }
        />
      </div>

      {truncated ? (
        <Notice tone="warn">
          お客様が多いため、新しい順に {LIMIT} 名までを表示しています。
          この画面に出ていない方を探すときは、お名前か電話番号で検索してください。
        </Notice>
      ) : null}

      <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-ink-800 bg-ink-900/70 p-1">
        {TABS.map((t) => {
          const active = t.key === kind;
          return (
            <Link
              key={t.key}
              href={buildListHref(BASE, params, { kind: t.key === "all" ? "" : t.key })}
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
                {counts[t.key]}
              </span>
            </Link>
          );
        })}
      </nav>

      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            kind: kind === "all" ? "" : kind,
            sort: sort.column,
            dir: sort.column ? (sort.desc ? "desc" : "asc") : "",
          }}
        >
          <FilterText
            name="keyword"
            label="お名前・電話番号で探す"
            value={keyword}
            placeholder="お名前・フリガナ・電話番号"
            width="w-64"
          />
          <FilterSelect
            name="review"
            label="審査"
            value={review}
            options={reviewOptions}
            allLabel={`すべて（${customers.length}）`}
          />
          <FilterSelect name="payment" label="お支払い" value={payment} options={paymentOptions} />
          <FilterSelect name="ship" label="出荷" value={ship} options={shipOptions} />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={tabTotal}
          shown={rows.length}
          unit="名"
          clearHref={clearHref}
          note={`${current.label}のタブ`}
        />
      ) : null}

      <Card title={`${current.label}　${rows.length} 名`}>
        {rows.length === 0 ? (
          <EmptyState title={emptyTitle(kind, isFiltered)} description={emptyDescription(kind, isFiltered)} />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh column="name" label="お名前" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="phone" label="電話番号" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="agency" label="担当代理店" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="referrer" label="紹介元" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="review" label="審査" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="payment" label="お支払い" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="ship" label="出荷" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="contracted" label="ご契約日" sort={sort} basePath={BASE} params={params} />
                <Th align="right">修正</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <CustomerRow
                  key={c.id}
                  customer={c}
                  agencyName={nameByCode.get(c.agencyCode) ?? ""}
                  referrerName={nameByCode.get(c.referrerCode) ?? ""}
                  introduced={isIntroduced(c)}
                  columnCount={COLUMN_COUNT}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        「取次店の紹介」は、紹介元の取次店コードが入っているお客様です。トスアップと電話番号が一致したときに
        自動で入ります。コードが入っていないお客様は「一般」に分かれます。
        <br />
        この画面ではお客様の登録を消せません。お申し込みの取り消しは、お支払いと出荷の状態で管理してください。
      </Notice>
    </div>
  );
}

/* ---------- 空のときの文言 ---------- */

function emptyTitle(kind: Kind, filtered: boolean): string {
  if (filtered) return "条件に合うものがありません";
  if (kind === "introduced") return "取次店から紹介されたお客様はまだいません";
  if (kind === "general") return "一般のお申し込みはまだありません";
  return "お客様がまだ登録されていません";
}

function emptyDescription(kind: Kind, filtered: boolean): string {
  if (filtered) {
    return "条件を変えてお試しください。お名前は一部でも探せます。電話番号はハイフンの有無を問いません。別の区分に入っている可能性があるので、上のタブの件数もご確認ください。";
  }
  if (kind === "introduced") {
    return "トスアップされたお客様のご契約が決まり、紹介元の取次店コードが入ると、ここに表示されます。";
  }
  if (kind === "general") {
    return "紹介元の取次店コードが入っていないお申し込みは、ここに表示されます。";
  }
  return "お申し込みフォームからのお申し込みが取り込まれると、ここに自動で表示されます。";
}
