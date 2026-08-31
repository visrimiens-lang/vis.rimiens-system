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
  ProgressLegend,
  progressOf,
  type ProgressSource,
} from "@/components/Progress";
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
import { codeKindLabel, companyNameOf } from "@/lib/labels";
import { paymentMethodLabel } from "@/lib/payment-status";
import { CustomerRow, STAFF_CODE_LIST_ID, type CustomerView } from "./CustomerForm";

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
  "staff",
  "referrer",
  "progress",
  "method",
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
    deliveredOn: s_(r, "delivered_on"),
    serialNo: s_(r, "serial_no"),
    padSubscriptionId: s_(r, "pad_subscription_id"),
    padChargeFrom: s_(r, "pad_charge_from"),
  };
}

/**
 * 顧客台帳の状態を、進み具合の部品（src/components/Progress.tsx）が読める形に言い換える。
 *
 * 同じ「審査に通った」でも、受注は「承認」、顧客台帳は「審査完了」と言葉が違う。
 * 部品側を顧客台帳の言葉に広げると、代理店の画面と本部の画面で段階の判定が
 * ずれるおそれがあるので、言い換えはこの画面で引き受ける。
 * データベースの値そのものは変えない。
 */
function progressSourceOf(c: CustomerView): ProgressSource {
  const review =
    c.reviewStatus === "審査完了"
      ? "承認"
      : c.reviewStatus === "審査NG"
        ? "否決"
        : "";

  // お支払いが「否決・キャンセル」なら、審査が通っていてもお申し込みは止まっている。
  // 出荷の状態だけを見ていると、止まった案件が「審査完了 40%」のまま並んでしまう。
  const ship = c.paymentStatus === "否決・キャンセル" ? "キャンセル" : c.shipStatus;

  return {
    reviewResult: review,
    shipStatus: ship,
    deliveredOn: c.deliveredOn,
    // 決済完了（着金）の段階を進み具合に効かせる（2026-08-27）
    paymentMethod: c.paymentMethod,
    paymentStatus: c.paymentStatus,
  };
}

/**
 * 並び替えに使う進み具合の数値。
 * 止まったもの（キャンセル・審査NG）は -1 にして、進んでいる案件と混ざらないようにする。
 */
function progressValue(c: CustomerView): number {
  const state = progressOf(progressSourceOf(c));
  return state.stopped ? -1 : state.percent;
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
    agency?: string;
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
  const agency = readParam(params, "agency") || ALL;
  const payment = readParam(params, "payment") || ALL;
  const ship = readParam(params, "ship") || ALL;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  let customers: CustomerView[] = [];
  /** お客様の番号 → その方の受注（キャンセルの欄で使う）。 */
  const ordersByCustomer = new Map<string, { id: string; shipStatus: string }[]>();
  let agencies: Agency[] = [];
  let loadError: string | null = null;

  try {
    const [rows, all, orderRows] = await Promise.all([
      select<Row>(`customers?select=*&order=created_at.desc,id.desc&limit=${LIMIT}`),
      listAllAgencies(),
      /*
       * 決済方法を補うために、受注も読む。
       *
       * 決済方法は 2026-08-27 に受注へ足した項目で、そのあと顧客台帳にも写している。
       * それより前に入ったお客様は台帳が空のままで、画面に何も出ない
       * （銀行振込なのかアプラスなのか分からない）。
       * 台帳が空のときは、そのお客様のいちばん新しい受注から借りて出す。
       * データベースは書き換えない。表示だけを補う。
       */
      select<Row>(
        `orders?select=id,customer_id,payment_method,ship_status&customer_id=not.is.null&order=id.desc`,
      ).catch(() => [] as Row[]),
    ]);

    const methodByCustomer = new Map<string, string>();
    for (const o of orderRows) {
      const key = s_(o, "customer_id");
      const method = s_(o, "payment_method");
      if (!key || !method || methodByCustomer.has(key)) continue;
      methodByCustomer.set(key, method);
    }

    /*
     * お客様1名ぶんの受注。キャンセルの欄に使う。
     *
     * キャンセルは報酬の取り消しにつながるので、対象の受注が1件に決まるときだけ
     * この画面から操作できるようにする。2件以上あるときは、どれを止めるのかを
     * ここでは決められないため、受注一覧へ回す。
     */
    for (const o of orderRows) {
      const key = s_(o, "customer_id");
      if (!key) continue;
      const list = ordersByCustomer.get(key) ?? [];
      list.push({ id: s_(o, "id"), shipStatus: s_(o, "ship_status") });
      ordersByCustomer.set(key, list);
    }

    customers = rows.map((r) => {
      const c = toCustomer(r);
      if (!c.paymentMethod) {
        c.paymentMethod = methodByCustomer.get(c.id) ?? "";
      }
      return c;
    });
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
      description="ご契約いただいたお客様の一覧です。お名前と電話番号で探せ、担当代理店・お支払い・出荷の状態でも絞り込めます。申込からお届けまでの進み具合と、担当スタッフもこの表で確認できます。表の見出しを押すと並び替わります。住所や連絡先の書き間違いは、この画面から直せます。"
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
  /*
   * 担当スタッフの所属会社。紹介元の欄に添える。
   * スタッフ（区分02）は company_name、無ければ上位の代理店名を使う（companyNameOf）。
   */
  const companyByCode = new Map(agencies.map((a) => [a.code, companyNameOf(a)]));

  // 検索は、お名前・フリガナ・電話番号のどれかに含まれていれば当たりにする
  const matches = (c: CustomerView) => {
    if (!matchesKeyword(keyword, [c.name, c.nameKana, c.phone])) return false;
    if (agency !== ALL && c.agencyCode !== agency) return false;
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
    staff: (c) => c.staffCode,
    referrer: (c) => c.referrerCode,
    progress: (c) => progressValue(c),
    method: (c) => paymentMethodLabel(c.paymentMethod),
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

  const isFiltered = Boolean(keyword) || agency !== ALL || payment !== ALL || ship !== ALL;
  const clearHref = buildListHref(BASE, params, {
    keyword: "",
    agency: "",
    payment: "",
    ship: "",
  });
  /*
   * 担当代理店で絞る。
   * 審査で絞る欄が入っていたが、審査の列は 2026-08-31 に外してあり、
   * 見えない項目で絞っても結果を読み取れない。
   * 本部が見たいのは「どの代理店のお客様か」なので、そちらに差し替える。
   *
   * 選択肢はコードだけだと分からないので会社名を添える。
   * 値はコードのまま（絞り込みの照合に使う）。
   */
  const agencyOptions = buildOptions(customers, (c) => c.agencyCode, [], agency).map(
    (o) => {
      const name = nameByCode.get(o.value);
      return name ? { ...o, label: `${o.value}　${name}` } : o;
    },
  );
  const paymentOptions = buildOptions(customers, (c) => c.paymentStatus, [], payment);
  const shipOptions = buildOptions(customers, (c) => c.shipStatus, [], ship);

  /*
   * 「お届け前」は本部が住所直しなどで手を打つ相手の数。
   * 判定は配達完了日で行う。出荷状況だけを見ていたころは、発送しただけで
   * 「お届け済み」として数から外れていた（代理店側の画面は配達完了を軸に
   * しているので、同じお客様が本部と代理店で違って見えていた・2026-08-26）。
   * 表の「進み具合」で『中止』と出ている方（キャンセル・審査NG）は
   * もう手を打つ相手ではないので数えない。progressValue() は中止を -1 で返す。
   */
  const beforeShipping = found.filter((c) => !c.deliveredOn && progressValue(c) >= 0).length;
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
              ? "まだお手元に届いていない方。住所の直しはお早めに"
              : "お届けが済んでいない方はいません"
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
            name="agency"
            label="担当代理店"
            value={agency}
            options={agencyOptions}
            allLabel={`すべて（${customers.length}）`}
            width="w-64"
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
          <>
            <Table>
              <thead>
                <tr>
                  <SortableTh column="name" label="お名前" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="phone" label="電話番号" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="agency" label="担当代理店" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="staff" label="担当スタッフ" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="referrer" label="紹介元" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="progress" label="進み具合" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="method" label="決済方法" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="payment" label="お支払い" sort={sort} basePath={BASE} params={params} />
                  <SortableTh column="ship" label="出荷" sort={sort} basePath={BASE} params={params} />
                  <Th>キャンセル</Th>
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
                    staffName={nameByCode.get(c.staffCode) ?? ""}
                    staffCompany={companyByCode.get(c.staffCode) ?? ""}
                    orders={ordersByCustomer.get(c.id) ?? []}
                    progress={progressSourceOf(c)}
                    introduced={isIntroduced(c)}
                  />
                ))}
              </tbody>
            </Table>
            <div className="border-t border-ink-800 px-5 py-3.5">
              <ProgressLegend />
            </div>

            {/* 修正欄の「担当スタッフのコード」で使う入力候補。
                修正欄はお客様の人数ぶん作られるので、候補は画面に1つだけ置いて、
                どの行の入力欄からも同じものを参照する。 */}
            <datalist id={STAFF_CODE_LIST_ID}>
              {agencies.map((a) => (
                <option key={a.code} value={a.code}>
                  {`${a.name || "（名称未登録）"}／${codeKindLabel(a.codeKind)}`}
                </option>
              ))}
            </datalist>
          </>
        )}
      </Card>

      <Notice tone="info">
        「取次店の紹介」は、紹介元の取次店コードが入っているお客様です。トスアップと電話番号が一致したときに
        自動で入ります。コードが入っていないお客様は「一般」に分かれます。
        <br />
        「担当スタッフ」は、そのお申し込みを取った方のコードです。空欄のお客様は誰が売ったかが残っていないので、
        分かる場合は、その行の「登録内容を直す」を押して埋めてください。入力欄では登録済みのコードから選べます。
        <br />
        「出荷」の下に送り状番号が出ているお客様は、番号を押すとヤマト運輸のお届け状況が別のタブで開きます。
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
