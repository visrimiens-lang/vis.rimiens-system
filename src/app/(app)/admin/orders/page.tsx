import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAllAgencies } from "@/lib/agencies";
import { select } from "@/lib/db";
import { agencyTypeOf, companyNameOf, rankLabel } from "@/lib/labels";
import { PRODUCT_COLUMNS, buildProductMatcher } from "@/lib/product-match";
import { currentMonth, recentMonths, unitRewardFor } from "@/lib/orders";
import {
  ALL,
  buildListHref,
  buildOptions,
  digitsOf,
  matchesKeyword,
  parseSort,
  readParam,
  sortRows,
  type Accessors,
  type FilterOption,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import type { Agency, Order } from "@/lib/types";
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
  cn,
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import {
  FilterActions,
  FilterBar,
  FilterSelect,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";
import { AutoRefresh } from "@/components/AutoRefresh";

const BASE = "/admin/orders";

/**
 * 自動更新の間隔（秒）。
 * 本部の受注一覧は設計書どおり30秒。催事の最中に新しい受注が入ってくるので、
 * 開いたままでも件数が増えていくようにする。
 * 画面を新しくしても URL は変わらないため、期間・代理店・出荷状況などの絞り込みと、
 * 見出しを押して決めた並び順、毎朝の確認（未出荷など）の指定はそのまま残る。
 */
const REFRESH_SECONDS = 30;

export const metadata = { title: "受注一覧（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 本部は全代理店の受注を見る必要がある。
 * src/lib/orders.ts の listOrders は「渡したコードに一致するものだけ」を返すため、
 * 代理店マスタに載っていないコードの受注（＝紹介元が特定できていない受注）が
 * 落ちてしまう。本部にとってはそれこそ真っ先に見つけたい受注なので、
 * この画面だけは絞り込みなしで取得する。lib 側は変更しない。
 * ------------------------------------------------------------------ */

/**
 * 一度に読み込む上限。
 *
 * 保存先（Supabase）は、こちらが件数を指定しないと既定の 1,000 行で勝手に打ち切る。
 * 打ち切られたことは黙って起きるので、上限をこちらから明示して、
 * 取れた件数が上限に達していたら「全部は出ていない」と分かるようにしておく。
 * これを怠ると、売上合計・支払対象額・代理店ごとの集計が
 * 何の断りもなく少なく出てしまう。
 *
 * 保存先の既定と同じ 1,000 にそろえてある（顧客管理の画面と同じ考え方）。
 * ここだけ大きくしても保存先側で切られ、上限に達したことに気づけなくなる。
 */
const LIMIT = 1000;

/**
 * 出荷状況の選択肢。受注が1件も無い状態でも絞り込めるように持っておく。
 *
 * 「配達完了」だけは受注の ship_status には無い（配達完了日が入っているかで決まる）。
 * 画面ではひとつながりの段階として見せたいので、ここに並べて shipViewOf() で判定する。
 * 並びは進み具合の順。
 */
const SHIPPING_STATUSES = ["出荷待ち", "出荷手配中", "出荷済", "配達完了", "キャンセル"];

/**
 * この受注を、画面ではどの段階として見せるか。
 *
 * 届いていれば「配達完了」。
 * 「出荷済」は発送したがまだ届いていないもの、という意味になる。
 * こうしないと、絞り込みの「出荷済」に届いた分まで入り、
 * 上のタイル（配達完了 N件・発送済でまだ未着 N件）と数が合わない。
 */
function shipViewOf(o: { shippingStatus: string; deliveredAt: string }): string {
  if (o.shippingStatus === "キャンセル") return "キャンセル";
  if (o.deliveredAt) return "配達完了";
  return o.shippingStatus;
}

/**
 * 決済方法と照合ステータスも、受注が無い状態で選べるように並べておく。
 *
 * ここに書く文字は、必ずデータベースに保存されている値と同じにすること。
 * 受注テーブルの決済方法は 九州信販／アプラス／ライフカード／Stripe／スクエア／代引き の
 * 6つだけ、照合ステータスは 照合済／要確認／直販 の3つだけを受け付けるようになっている
 * （supabase/part2.sql の orders）。ここに無い言葉（「クレジット」など）を並べると、
 * 選んでも必ず0件になる選択肢が出てしまう。
 *
 * 照合ステータスの「直販」は、新しい受注に何も入っていないときの初期値なので、
 * 実際にはいちばん件数が多くなる。これが選べないと本部が直販ぶんを絞り込めない。
 */
const PAYMENT_METHODS = [
  "九州信販",
  "アプラス",
  "ライフカード",
  "Stripe",
  "スクエア",
  "代引き",
  "振込",
];
const MATCH_STATUSES = ["照合済", "要確認", "直販"];

/** 並び替えに使える列。過去に配った URL が効かなくならないよう、名前は変えない。 */
const SORT_COLUMNS = [
  "date",
  "customer",
  "product",
  "quantity",
  "amount",
  "payment",
  "payee",
  "staff",
  "owner",
  "ship",
  "tracking",
  "match",
];

const DEFAULT_SORT: SortState = { column: "date", desc: true };

/* ------------------------------------------------------------------
 * 毎朝の作業をひと押しで出すための絞り込み。
 *
 * 出荷の手配と送り状番号の記入は本部が毎朝まとめて行うので、
 * 「未出荷」「送り状番号がまだ」は選び直しの操作なしで開けるようにする。
 * どちらも過去の月に取り残された受注こそ見落としたくないため、
 * 期間を「全期間」に切り替えたうえで絞り込む。
 * ------------------------------------------------------------------ */
const TODO_UNSHIPPED = "unshipped";
const TODO_NO_TRACKING = "notracking";
const TODO_VOIDED = "voided";
const TODO_VALUES = [TODO_UNSHIPPED, TODO_NO_TRACKING, TODO_VOIDED];
const TODO_LABELS: Record<string, string> = {
  [TODO_UNSHIPPED]: "未出荷のものだけ",
  [TODO_NO_TRACKING]: "送り状番号がまだのものだけ",
  [TODO_VOIDED]: "キャンセル・審査否決だけ",
};

/** ヤマト運輸の追跡ページ。番号は数字だけにして渡す。 */
function trackingUrl(trackingNo: string): string {
  const digits = digitsOf(trackingNo) || trackingNo;
  return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=${encodeURIComponent(digits)}`;
}

type AdminOrder = Order & {
  /** ゼロ次代理店コード（集計用） */
  zeroCode: string;
  /** 売ったスタッフのコード（代理店マスタのコード区分 02） */
  staffCode: string;
  /** 信販の審査結果（承認／否決／電話確認待ち） */
  reviewResult: string;
  /** キャンセル・審査否決。売上にも報酬にも数えない受注。 */
  voided: boolean;
  /** エリア統括代理店（データベース上の2次代理店）に支払う1台あたりの金額。受注に入っていなければ null。 */
  secondaryUnit: number | null;
  /** 上記 × 台数。算出できなければ null。 */
  secondaryTotal: number | null;
};

type Row = Record<string, unknown>;
const str = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const num = (r: Row, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

function toAdminOrder(r: Row): AdminOrder {
  const referrer = str(r, "referrer_code");
  const agencyCode = str(r, "agency_code");
  const quantity = num(r, "quantity") || 1;
  // 空欄と 0 円は意味が違う。空欄なら「まだ決まっていない」ので金額を出さない。
  // 単価の引き先はデータベースの値（"2次代理店"）で選ぶ。画面の呼び方では引かない。
  const unit = unitRewardFor(r, "2次代理店");
  const shippingStatus = str(r, "ship_status");
  const reviewResult = str(r, "review_result");
  return {
    recordId: str(r, "id"),
    date: str(r, "ordered_on"),
    customerName: str(r, "customer_name"),
    productName: str(r, "product_name"),
    amount: num(r, "amount"),
    quantity,
    phone: str(r, "phone"),
    deliveredAt: str(r, "delivered_on"),
    shippingStatus,
    shippedAt: str(r, "shipped_on"),
    paymentMethod: str(r, "payment_method"),
    matchStatus: str(r, "match_status"),
    agencyCode,
    secondaryCode: str(r, "niji_code"),
    referrerCode: referrer,
    trackingNo: str(r, "tracking_no"),
    // 担当の決め方は lib/orders.ts の ownerCode とそろえる。
    // 画面によって同じ受注の担当が違う値になると、突き合わせができない。
    ownerCode: referrer || str(r, "staff_code") || agencyCode,
    zeroCode: str(r, "zeroth_code"),
    staffCode: str(r, "staff_code"),
    reviewResult,
    voided: shippingStatus === "キャンセル" || reviewResult === "否決",
    secondaryUnit: unit,
    secondaryTotal: unit === null ? null : unit * quantity,
  };
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

/** 全代理店ぶんの受注を取得する。month が null なら全期間。 */
async function fetchAllOrders(
  month: string | null,
): Promise<{ rows: AdminOrder[]; truncated: boolean }> {
  const filters = ["order=ordered_on.desc,id.desc"];
  if (month) {
    const { from, to } = monthRange(month);
    filters.push(`ordered_on=gte.${from}`, `ordered_on=lte.${to}`);
  }
  filters.push(`limit=${LIMIT}`);
  const [rows, products] = await Promise.all([
    select<Row>(`orders?select=*&${filters.join("&")}`),
    select<Row>(`products?select=${PRODUCT_COLUMNS}`),
  ]);
  /*
   * 引き当ては @/lib/product-match に集約してある。
   * 報酬の計上（@/lib/rewards）と同じ関数を通さないと、
   * 実際に計上された額と、この一覧に出る額がずれる。
   */
  const matchProduct = buildProductMatcher(products);

  const enriched = rows.map((r) => {
    const p = matchProduct(
      str(r, "product_name"),
      num(r, "amount"),
      num(r, "quantity") || 1,
    )?.row;
    const off = !p || str(p, "reward_target") === "対象外";
    return {
      ...r,
      _unit_so: off ? null : p!["amount_so"] ?? null,
      _unit_niji: off ? null : p!["amount_niji"] ?? null,
      _unit_hanbai: off ? null : p!["amount_hanbai"] ?? null,
      _unit_toritsugi: off ? null : p!["amount_toritsugi"] ?? null,
    } as Row;
  });
  // 上限ぴったりまで取れたときは、その先にまだ受注が残っている可能性がある。
  return { rows: enriched.map(toAdminOrder), truncated: rows.length >= LIMIT };
}

/** 受注に記録されている代理店コードすべて（重複を除く）。 */
function codesOf(o: AdminOrder): string[] {
  return [
    ...new Set([o.agencyCode, o.secondaryCode, o.referrerCode, o.zeroCode, o.staffCode]),
  ].filter(Boolean);
}

/**
 * 集計・振込確認のまとめ先。
 * 受注には集計用の「2次代理店コード」（画面では エリア統括代理店）が入るので、まずそれを使う。
 * 入っていない受注は、受注に記録された代理店コードでまとめる。
 */
function payeeCodeOf(o: AdminOrder): string {
  return o.secondaryCode || o.agencyCode || "";
}

type AgencyTotals = {
  code: string;
  name: string;
  orderCount: number;
  units: number;
  sales: number;
  payable: number | null;
  /** キャンセル・審査否決の件数と金額。上の集計には入れず、ここだけに出す。 */
  voidedCount: number;
  voidedSales: number;
};

function sumPayable(rows: AdminOrder[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (r.secondaryTotal === null) return null;
    total += r.secondaryTotal;
  }
  return total;
}

/**
 * 代理店ごとにまとめる。
 *
 * キャンセルと審査否決の受注は、売上・台数・支払対象額のどれにも足さない。
 * ただし行そのものは消さずに「取消」の列で件数と金額を見せる。
 * 消してしまうと、取り消しばかりの代理店が表から丸ごと消えて気づけなくなるため。
 */
function groupByPayee(rows: AdminOrder[], names: Map<string, string>): AgencyTotals[] {
  const buckets = new Map<string, AdminOrder[]>();
  for (const r of rows) {
    const key = payeeCodeOf(r);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([code, list]) => {
      const live = list.filter((r) => !r.voided);
      const voided = list.filter((r) => r.voided);
      return {
        code,
        name: names.get(code) ?? "",
        orderCount: live.length,
        units: live.reduce((s, r) => s + (r.quantity || 1), 0),
        sales: live.reduce((s, r) => s + r.amount, 0),
        payable: sumPayable(live),
        voidedCount: voided.length,
        voidedSales: voided.reduce((s, r) => s + r.amount, 0),
      };
    })
    .sort((a, b) => b.units - a.units || b.sales - a.sales || a.code.localeCompare(b.code));
}

/** "YYYY-MM" か "all" だけを受け付ける。それ以外は今月に落とす。 */
function normalizeMonth(raw: string | undefined, fallback: string): string {
  if (raw === "all") return "all";
  if (raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return fallback;
}

/** 全期間表示のときだけ年を添える。 */
function orderDate(v: string, withYear: boolean): string {
  if (!v) return "—";
  return withYear ? `${v.slice(0, 4)}/${jpDate(v)}` : jpDate(v);
}

/** 毎朝の作業をひと押しで開くためのリンク。押されている間は色を変える。 */
function QuickFilter({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-gold-500/60 bg-gold-500/15 text-gold-300"
          : "border-ink-700 bg-ink-850 text-ink-200 hover:border-ink-600 hover:text-ink-50",
      )}
    >
      {children}
      {active ? "（解除する）" : null}
    </Link>
  );
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    code?: string;
    ship?: string;
    pay?: string;
    match?: string;
    todo?: string;
    keyword?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);
  const month = normalizeMonth(readParam(params, "month"), thisMonth);
  const monthChoices = month === "all" || months.includes(month) ? months : [month, ...months];
  const selectedCode = readParam(params, "code") || ALL;
  const selectedShip = readParam(params, "ship") || ALL;
  const selectedPay = readParam(params, "pay") || ALL;
  const selectedMatch = readParam(params, "match") || ALL;
  const rawTodo = readParam(params, "todo");
  const todo = TODO_VALUES.includes(rawTodo) ? rawTodo : "";
  const keyword = readParam(params, "keyword");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);
  const allPeriod = month === "all";
  const periodLabel = allPeriod ? "全期間" : jpMonthLabel(month);

  let periodOrders: AdminOrder[] = [];
  let agencies: Agency[] = [];
  let truncated = false;
  let error: string | null = null;

  try {
    const [orderResult, agencyList] = await Promise.all([
      fetchAllOrders(allPeriod ? null : month),
      listAllAgencies(),
    ]);
    periodOrders = orderResult.rows;
    truncated = orderResult.truncated;
    agencies = agencyList;
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "受注を読み込めませんでした。時間をおいて画面を開き直してください。";
  }

  const header = (
    <PageHeader
      title="受注一覧（全代理店）"
      description="全代理店の受注をまとめて確認できます。期間・代理店・出荷状況・決済方法・照合状態で絞り込め、注文者名や送り状番号でも探せます。表の見出しを押すと並び替わります。キャンセルと審査否決の受注は、売上・支払対象額には数えていません。"
      actions={<AutoRefresh seconds={REFRESH_SECONDS} label="受注一覧" />}
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          受注を読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  const nameByCode = new Map(agencies.map((a) => [a.code, a.name]));
  const agencyByCode = new Map(agencies.map((a) => [a.code, a]));

  /**
   * 担当スタッフの下に出す「どこの会社の、どの立場の人か」。
   * 会社名と種別は代理店側の「スタッフ一覧」で設定したものをそのまま出す。
   * コードは隣の「担当コード」の欄に出ているので、ここでは繰り返さない。
   */
  const affiliationOf = (code: string): string => {
    const person = agencyByCode.get(code);
    if (!person) return "代理店マスタに該当なし";
    return (
      [
        companyNameOf(person),
        agencyTypeOf(person.rank, person.channel, person.codeKind, person.staffType),
      ]
        .filter(Boolean)
        .join("・") || "所属が未設定です"
    );
  };

  /* --- 絞り込みの選択肢は、期間で絞ったあとの受注から作る --- */
  const codeCounts = new Map<string, number>();
  for (const o of periodOrders) {
    for (const c of codesOf(o)) codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
  }

  // 受注が0件でも代理店を選べるように、代理店マスタの正規代理店（コード区分00）も並べる。
  const codeSet = new Set<string>(codeCounts.keys());
  for (const a of agencies) if (a.codeKind === "00" && a.code) codeSet.add(a.code);
  if (selectedCode !== ALL) codeSet.add(selectedCode);

  const codeOptions: FilterOption[] = [...codeSet]
    .map((code) => ({
      value: code,
      label: `${code}${nameByCode.get(code) ? `　${nameByCode.get(code)}` : ""}`,
      count: codeCounts.get(code) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const monthOptions: FilterOption[] = monthChoices.map((m) => ({
    value: m,
    label: `${jpMonthLabel(m)}${m === thisMonth ? "（今月）" : ""}`,
    count: 0,
  }));
  const shipOptions = buildOptions(
    periodOrders,
    shipViewOf,
    SHIPPING_STATUSES,
    selectedShip,
  );
  const payOptions = buildOptions(
    periodOrders,
    (o) => o.paymentMethod,
    PAYMENT_METHODS,
    selectedPay,
  );
  const matchOptions = buildOptions(
    periodOrders,
    (o) => o.matchStatus,
    MATCH_STATUSES,
    selectedMatch,
  );

  /* --- 絞り込み --- */
  const filteredRows = periodOrders.filter((o) => {
    if (selectedCode !== ALL && !codesOf(o).includes(selectedCode)) return false;
    if (selectedShip !== ALL && shipViewOf(o) !== selectedShip) return false;
    if (selectedPay !== ALL && o.paymentMethod !== selectedPay) return false;
    if (selectedMatch !== ALL && o.matchStatus !== selectedMatch) return false;
    // 未出荷・送り状番号なしは「これから手を動かすもの」なので、
    // 取り消された受注は最初から外す。
    if (todo === TODO_UNSHIPPED && (o.voided || ["出荷済", "配達完了"].includes(shipViewOf(o))))
      return false;
    if (todo === TODO_NO_TRACKING && (o.voided || o.trackingNo)) return false;
    if (todo === TODO_VOIDED && !o.voided) return false;
    if (!matchesKeyword(keyword, [o.customerName, o.trackingNo])) return false;
    return true;
  });

  /* --- 並び替え --- */
  const accessors: Accessors<AdminOrder> = {
    date: (o) => o.date,
    customer: (o) => o.customerName,
    product: (o) => o.productName,
    quantity: (o) => o.quantity || 1,
    amount: (o) => o.amount,
    payment: (o) => o.paymentMethod,
    payee: (o) => payeeCodeOf(o),
    staff: (o) => nameByCode.get(o.staffCode) || o.staffCode,
    owner: (o) => o.ownerCode,
    ship: (o) => shipViewOf(o),
    tracking: (o) => o.trackingNo,
    match: (o) => o.matchStatus,
  };
  const rows = sortRows(filteredRows, sort.column, sort.desc, accessors);

  const isFiltered =
    selectedCode !== ALL ||
    selectedShip !== ALL ||
    selectedPay !== ALL ||
    selectedMatch !== ALL ||
    Boolean(todo) ||
    Boolean(keyword);
  const clearHref = buildListHref(BASE, params, {
    code: "",
    ship: "",
    pay: "",
    match: "",
    todo: "",
    keyword: "",
  });

  /** ひと押しの絞り込み。期間は「全期間」にする（先月の取り残しを見落とさないため）。 */
  const todoHref = (value: string): string =>
    todo === value
      ? buildListHref(BASE, params, { todo: "" })
      : buildListHref(BASE, params, { todo: value, month: "all" });

  /* --- 集計はキャンセル・審査否決を除いて行う --- */
  const liveRows = rows.filter((o) => !o.voided);
  const voidedRows = rows.filter((o) => o.voided);
  const displayCount = rows.length;
  const orderCount = liveRows.length;
  const unitTotal = liveRows.reduce((s, o) => s + (o.quantity || 1), 0);
  const salesTotal = liveRows.reduce((s, o) => s + o.amount, 0);
  /*
   * 進み具合ごとの件数。判定は絞り込みと同じ shipViewOf() を通すので、
   * ここの数字と「出荷状況」で絞ったときの件数が必ず一致する。
   * 代理店側の画面（顧客一覧・売上・報酬）も配達完了を軸にしている（2026-08-26）。
   */
  const deliveredCount = liveRows.filter((o) => shipViewOf(o) === "配達完了").length;
  const shippedNotDelivered = liveRows.filter((o) => shipViewOf(o) === "出荷済").length;
  const notShipped = orderCount - deliveredCount - shippedNotDelivered;
  const payableTotal = sumPayable(liveRows);
  const voidedCount = voidedRows.length;
  const voidedSales = voidedRows.reduce((s, o) => s + o.amount, 0);
  const cancelledCount = voidedRows.filter((o) => o.shippingStatus === "キャンセル").length;
  const rejectedCount = voidedRows.filter(
    (o) => o.reviewResult === "否決" && o.shippingStatus !== "キャンセル",
  ).length;
  const needsCheck = liveRows.filter((o) => o.matchStatus === "要確認");
  const noTracking = liveRows.filter((o) => !o.trackingNo).length;
  const groups = groupByPayee(rows, nameByCode);
  const missingPayable = groups.some((g) => g.payable === null);
  const selectedName = selectedCode === ALL ? "" : (nameByCode.get(selectedCode) ?? "");

  const filterLabel = [
    periodLabel,
    selectedCode === ALL ? null : selectedCode,
    selectedShip === ALL ? null : selectedShip,
    selectedPay === ALL ? null : selectedPay,
    selectedMatch === ALL ? null : selectedMatch,
    todo ? TODO_LABELS[todo] : null,
    keyword ? `「${keyword}」` : null,
  ]
    .filter(Boolean)
    .join("・");

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            sort: sort.column,
            dir: sort.desc ? "desc" : "asc",
            todo: todo || undefined,
          }}
        >
          <FilterSelect
            name="month"
            label="期間"
            value={month}
            options={monthOptions}
            allLabel="全期間"
            showCount={false}
          />
          <FilterSelect
            name="code"
            label="代理店コード"
            value={selectedCode}
            options={codeOptions}
            allLabel={`すべての代理店（${periodOrders.length}）`}
            width="w-72"
          />
          <FilterSelect
            name="ship"
            label="出荷状況"
            value={selectedShip}
            options={shipOptions}
            allLabel={`すべて（${periodOrders.length}）`}
            width="w-48"
          />
          <FilterSelect
            name="pay"
            label="決済方法"
            value={selectedPay}
            options={payOptions}
            width="w-48"
          />
          <FilterSelect
            name="match"
            label="照合状態"
            value={selectedMatch}
            options={matchOptions}
            width="w-44"
          />
          <FilterText
            name="keyword"
            label="キーワード"
            value={keyword}
            placeholder="注文者名・送り状番号"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>

        <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-5 py-3.5">
          <span className="text-xs text-ink-400">毎朝の確認：</span>
          <QuickFilter href={todoHref(TODO_UNSHIPPED)} active={todo === TODO_UNSHIPPED}>
            未出荷のものだけ
          </QuickFilter>
          <QuickFilter href={todoHref(TODO_NO_TRACKING)} active={todo === TODO_NO_TRACKING}>
            送り状番号がまだのものだけ
          </QuickFilter>
          <QuickFilter href={todoHref(TODO_VOIDED)} active={todo === TODO_VOIDED}>
            キャンセル・審査否決だけ
          </QuickFilter>
          <span className="text-xs text-ink-500">
            押すと期間が「全期間」に変わり、先月までの取り残しも一緒に出ます。
          </span>
        </div>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={periodOrders.length}
          shown={displayCount}
          clearHref={clearHref}
          note={`${periodLabel}の受注のうち`}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="受注件数"
          value={orderCount.toLocaleString("ja-JP")}
          unit="件"
          hint={
            voidedCount > 0
              ? `${filterLabel}（キャンセル・否決 ${voidedCount} 件を除く）`
              : filterLabel
          }
        />
        <StatTile
          label="台数"
          value={unitTotal.toLocaleString("ja-JP")}
          unit="台"
          hint="キャンセル・否決を除いた数量の合計"
        />
        <StatTile
          label="受注売上合計（税込）"
          value={yen(salesTotal)}
          tone="gold"
          hint="お客様のお支払額の合計（キャンセル・否決を除く）"
        />
        <StatTile
          label="配達完了"
          value={deliveredCount.toLocaleString("ja-JP")}
          unit="件"
          hint={
            orderCount > 0
              ? `発送済でまだ未着 ${shippedNotDelivered.toLocaleString("ja-JP")} 件・` +
                `未出荷 ${Math.max(0, notShipped).toLocaleString("ja-JP")} 件`
              : "お客様のお手元に届いた受注の数"
          }
        />
        <StatTile
          label="キャンセル・審査否決"
          value={voidedCount.toLocaleString("ja-JP")}
          unit="件"
          tone={voidedCount > 0 ? "warn" : "default"}
          hint={
            voidedCount > 0
              ? `${yen(voidedSales)} 分を売上・支払対象額から外しています`
              : "取り消された受注はありません"
          }
        />
      </div>

      {voidedCount > 0 ? (
        <Notice tone="warn">
          {filterLabel}の受注のうち {voidedCount} 件（{yen(voidedSales)}）は、
          {cancelledCount > 0 ? `キャンセル ${cancelledCount} 件` : ""}
          {cancelledCount > 0 && rejectedCount > 0 ? "・" : ""}
          {rejectedCount > 0 ? `審査否決 ${rejectedCount} 件` : ""}
          のため、売上合計・支払対象額・代理店ごとの集計には数えていません。
          下の表には残していますが、行の色を変えて取り消し済みと分かるようにしています。
          <br />
          <Link
            href={todoHref(TODO_VOIDED)}
            className="underline underline-offset-4 hover:text-warn-100"
          >
            取り消された受注だけを表示する
          </Link>
        </Notice>
      ) : null}

      {truncated ? (
        <Notice tone="warn">
          件数が多いため、受注日の新しい順に {LIMIT.toLocaleString("ja-JP")} 件までを読み込んでいます。
          上の受注件数・台数・売上合計と、代理店ごとの集計・支払対象額も、この
          {LIMIT.toLocaleString("ja-JP")} 件分だけを数えた金額です。
          振込の金額を確かめるときは、期間を月で絞り込んでからご覧ください。
        </Notice>
      ) : null}

      {needsCheck.length > 0 ? (
        <Notice tone="warn">
          紹介元が特定できていない受注が {needsCheck.length} 件あります（照合ステータスが「要確認」）。
          このぶんは報酬の支払先が決まっていないため、下の表では色を付けています。
          受注の紹介元をご確認のうえ、照合ステータスを更新してください。
        </Notice>
      ) : null}

      <Card
        title={`代理店ごとの集計（${filterLabel}）`}
        action={
          <span className="text-xs text-ink-400">
            台数の多い順・{groups.length.toLocaleString("ja-JP")} 社
          </span>
        }
      >
        {groups.length === 0 ? (
          <EmptyState
            title="集計できる受注がありません"
            description="受注が入ると、代理店ごとの台数・売上・支払対象額をここでまとめて確認できます。月次の振込確認はこの表をお使いください。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>代理店コード</Th>
                <Th>法人名</Th>
                <Th align="right">件数</Th>
                <Th align="right">台数</Th>
                <Th align="right">売上（税込）</Th>
                <Th align="right">支払対象額（税抜）</Th>
                <Th align="right">取消（集計外）</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.code || "(未設定)"}>
                  <Td numeric className="whitespace-nowrap font-medium text-ink-100">
                    {g.code || <Badge tone="warn">コードなし</Badge>}
                  </Td>
                  <Td>
                    {g.name || (
                      <span className="text-ink-400">
                        {g.code ? "代理店マスタに該当なし" : "支払先が未確定です"}
                      </span>
                    )}
                  </Td>
                  <Td numeric align="right">
                    {g.orderCount.toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right" className="font-medium text-ink-50">
                    {g.units.toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right">
                    {yen(g.sales)}
                  </Td>
                  <Td numeric align="right" className="text-gold-300">
                    {yen(g.payable)}
                  </Td>
                  <Td numeric align="right" className="whitespace-nowrap text-bad-100">
                    {g.voidedCount > 0 ? (
                      <>
                        {g.voidedCount.toLocaleString("ja-JP")} 件
                        <span className="ml-1 text-xs text-ink-400">
                          （{yen(g.voidedSales)}）
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-500">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">全体</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {orderCount.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {yen(salesTotal)}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-400">
                  {yen(payableTotal)}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap font-semibold text-bad-100">
                  {voidedCount > 0 ? (
                    <>
                      {voidedCount.toLocaleString("ja-JP")} 件
                      <span className="ml-1 text-xs text-ink-400">（{yen(voidedSales)}）</span>
                    </>
                  ) : (
                    <span className="text-ink-500">—</span>
                  )}
                </Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {missingPayable ? (
        <Notice tone="warn">
          {rankLabel("2次代理店")}分の1台あたりの金額が入っていない受注があるため、支払対象額を出せない代理店があります。
          商品マスタの単価が受注に反映されているかご確認ください。金額が確かめられないところは「—」と表示しています。
        </Notice>
      ) : null}

      <Card
        title={`受注明細（${filterLabel}）`}
        action={
          <span className="text-xs text-ink-400">
            {displayCount.toLocaleString("ja-JP")} 件
            {voidedCount > 0 ? `（うち取り消し ${voidedCount} 件）` : ""}
            ・見出しを押すと並び替えられます
          </span>
        }
      >
        {displayCount === 0 ? (
          <EmptyState
            title={
              isFiltered ? "条件に合うものがありません" : "この期間の受注はまだありません"
            }
            description={
              isFiltered
                ? `${periodLabel}には、${[
                    selectedCode === ALL
                      ? null
                      : `代理店 ${selectedCode}${selectedName ? `（${selectedName}）` : ""}`,
                    selectedShip === ALL ? null : `出荷状況「${selectedShip}」`,
                    selectedPay === ALL ? null : `決済方法「${selectedPay}」`,
                    selectedMatch === ALL ? null : `照合状態「${selectedMatch}」`,
                    todo ? TODO_LABELS[todo] : null,
                    keyword ? `キーワード「${keyword}」` : null,
                  ]
                    .filter(Boolean)
                    .join("・")}に当てはまる受注がありません。条件を変えてお試しください。期間を「全期間」にすると、過去の分からも探せます。`
                : "お客様の決済が完了すると、受注がここに自動で表示されます。反映は数分以内です。期間を「全期間」に切り替えると、過去の分も確認できます。"
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh column="date" label="受注日" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="customer" label="注文者" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="product" label="商品" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="quantity" label="台数" sort={sort} basePath={BASE} params={params} align="right" />
                <SortableTh column="amount" label="金額（税込）" sort={sort} basePath={BASE} params={params} align="right" />
                <SortableTh column="payment" label="決済方法" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="payee" label="代理店" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="staff" label="担当スタッフ" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="owner" label="担当コード" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="ship" label="出荷状況" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="tracking" label="送り状番号" sort={sort} basePath={BASE} params={params} />
                <SortableTh column="match" label="照合状態" sort={sort} basePath={BASE} params={params} />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const payee = payeeCodeOf(o);
                const attention = !o.voided && o.matchStatus === "要確認";
                return (
                  <tr
                    key={o.recordId}
                    className={cn(
                      o.voided && "bg-bad-500/10",
                      attention && "bg-warn-500/10",
                    )}
                  >
                    <Td numeric className="whitespace-nowrap">
                      {orderDate(o.date, allPeriod)}
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/orders/${encodeURIComponent(o.recordId)}`}
                        className="underline underline-offset-4 hover:text-gold-300"
                      >
                        {o.customerName || "（お名前なし）"}
                      </Link>
                    </Td>
                    {/*
                      商品名は「本体 ／ 事務手数料 ／ OP②延長保証 ／ OP①ジェルパッド1年分」のように
                      買ったものを並べた長い1本の文字列で届く。そのまま流すと列が縦に潰れて
                      1件で画面の半分を占め、一覧として読めなくなる。
                      幅を決めて2行までに収め、全文はマウスを乗せると出るようにする。
                    */}
                    <Td className="min-w-[13rem] max-w-[22rem]">
                      <span
                        className="line-clamp-2 leading-snug"
                        title={o.productName || undefined}
                      >
                        {o.productName || "—"}
                      </span>
                    </Td>
                    <Td numeric align="right">
                      {(o.quantity || 1).toLocaleString("ja-JP")}
                    </Td>
                    <Td
                      numeric
                      align="right"
                      className={cn("whitespace-nowrap", o.voided && "text-ink-500 line-through")}
                    >
                      {yen(o.amount)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {o.paymentMethod || <span className="text-ink-400">—</span>}
                    </Td>
                    <Td>
                      {payee ? (
                        <div className="min-w-0">
                          <div className="tabnum truncate font-medium text-ink-100">{payee}</div>
                          <div className="truncate text-xs text-ink-400">
                            {nameByCode.get(payee) ?? "代理店マスタに該当なし"}
                          </div>
                        </div>
                      ) : (
                        <Badge tone="warn">コードなし</Badge>
                      )}
                    </Td>
                    <Td>
                      {o.staffCode ? (
                        <div className="min-w-0">
                          <div className="truncate text-ink-100">
                            {nameByCode.get(o.staffCode) || "（名称未登録）"}
                          </div>
                          <div className="truncate text-xs text-ink-400">
                            {affiliationOf(o.staffCode)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {o.ownerCode || <span className="text-ink-400">—</span>}
                    </Td>
                    <Td>
                      {/* 届いていれば「配達完了」。代理店側の画面と同じ呼び方にそろえる */}
                      <StatusBadge status={shipViewOf(o)} />
                      {o.deliveredAt ? (
                        <div className="tabnum mt-1 text-xs text-ink-400">
                          {jpDate(o.deliveredAt)} 着
                        </div>
                      ) : null}
                      {o.reviewResult === "否決" ? (
                        <div className="mt-1">
                          <Badge tone="bad">審査否決</Badge>
                        </div>
                      ) : null}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {o.trackingNo ? (
                        <a
                          href={trackingUrl(o.trackingNo)}
                          target="_blank"
                          rel="noreferrer"
                          title="ヤマト運輸の追跡ページを開きます"
                          className="underline underline-offset-4 hover:text-gold-300"
                        >
                          {o.trackingNo}
                        </a>
                      ) : (
                        <span className="text-ink-400">未入力</span>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={o.matchStatus} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td className="whitespace-nowrap font-semibold text-ink-100">
                  {orderCount.toLocaleString("ja-JP")}件
                </Td>
                <Td className="text-xs text-ink-400">
                  {voidedCount > 0 ? "キャンセル・否決を除く" : null}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-300">
                  {yen(salesTotal)}
                </Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td className="whitespace-nowrap text-xs text-ink-400">
                  {noTracking > 0 ? `未入力 ${noTracking.toLocaleString("ja-JP")} 件` : null}
                </Td>
                <Td>{null}</Td>
              </tr>
              {voidedCount > 0 ? (
                <tr>
                  <Td className="text-bad-100">うち取り消し</Td>
                  <Td className="whitespace-nowrap text-bad-100">
                    {voidedCount.toLocaleString("ja-JP")}件
                  </Td>
                  <Td className="text-xs text-ink-400">キャンセル・審査否決</Td>
                  <Td>{null}</Td>
                  <Td numeric align="right" className="whitespace-nowrap text-bad-100 line-through">
                    {yen(voidedSales)}
                  </Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                  <Td>{null}</Td>
                </tr>
              ) : null}
            </tfoot>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        代理店は、受注に記録された集計用の{rankLabel("2次代理店")}コードです。入っていない受注は、受注に記録された代理店コードでまとめています。
        担当コードは、取次の紹介コードがある受注ではそのコード、無い受注では代理店コードです。
        支払対象額は「{rankLabel("2次代理店")}分の1台あたりの金額 × 台数」で計算しています。
        キャンセルと審査否決の受注は、売上・台数・支払対象額のどれにも数えていません（表では行の色を変えて残しています）。
        送り状番号を押すと、ヤマト運輸の追跡ページが別のタブで開きます。
      </Notice>
    </div>
  );
}
