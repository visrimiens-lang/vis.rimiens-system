import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { select } from "@/lib/db";
import {
  currentMonth,
  listOrders,
  recentMonths,
  scopeCodes,
  type OrderWithReward,
} from "@/lib/orders";
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
  yen,
} from "@/components/ui";
import {
  PROGRESS_STEPS,
  Progress,
  progressOf,
  yamatoTrackingUrl,
  type ProgressStep,
} from "@/components/Progress";
import {
  ALL,
  buildListHref,
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
import { agencyTypeOf, companyNameOf } from "@/lib/labels";
import { AutoRefresh } from "@/components/AutoRefresh";

export const metadata = { title: "顧客一覧｜VIS 代理店ポータル" };

const BASE = "/customers";

/**
 * 自動更新の間隔（秒）。
 * 催事の会場で審査の結果をその場で見たい、という要望に合わせて設計書どおり10秒。
 * 画面を新しくしても URL は変わらないので、期間・担当コード・お名前での絞り込みと、
 * 見出しを押して決めた並び順はそのまま残る。
 */
const REFRESH_SECONDS = 10;

/** 見出しを押して並び替えられる列。URL を手で書き換えられても、ここに無い列は効かない。 */
const SORT_COLUMNS = [
  "date",
  "customer",
  "product",
  "qty",
  "amount",
  "owner",
  "staff",
  "progress",
  "review",
  "ship",
];

/** 既定は受注日の新しい順（データベースから取ったままの並び）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

/** データベースから届いた1行。必要な項目だけ text() で取り出す。 */
type Row = Record<string, unknown>;

/**
 * 段階の並びと割合の説明。棒の読み方を示す。
 *
 * 出す段階は、この一覧に実際に出ているものだけにそろえる。
 * 「配達完了」は本部が顧客台帳へ配達の完了日を入れたときだけ付く段階だが、
 * いまのところ本部側にその入力の場所が用意されていない。
 * 出ようのない段階を並べたままにすると「いつまでも完了しない」と受け取られるため、
 * 完了日が入った受注が一件も無いときは出荷済までを示す。
 */
function StageLegend({ steps }: { steps: readonly ProgressStep[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-ink-400">
      {steps.map((step, i) => (
        <span key={step.key} className="flex items-center gap-2">
          <span className="whitespace-nowrap">
            {step.label}
            <span className="tabnum ml-1 text-ink-500">{step.percent}%</span>
          </span>
          {i < steps.length - 1 ? (
            <span aria-hidden className="text-ink-600">
              ›
            </span>
          ) : null}
        </span>
      ))}
      <span className="text-ink-500">
        ／ キャンセル・審査が通らなかったものは「中止」と表示します。
      </span>
    </div>
  );
}

const text = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/** "YYYY-MM" か "all" だけを受け付ける。それ以外は今月に落とす。 */
function normalizeMonth(raw: string, fallback: string): string {
  if (raw === ALL) return ALL;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return fallback;
}

/** 全期間表示のときだけ年を添える。 */
function orderDate(v: string, withYear: boolean): string {
  if (!v) return "—";
  return withYear ? `${v.slice(0, 4)}/${jpDate(v)}` : jpDate(v);
}

/**
 * 受注1件に、一覧で出したいものを足したもの。
 *
 * 誰が売ったか（担当スタッフ）は受注の「売ったスタッフ」に入る。
 * 入っていない受注もあるため、その場合は担当コードの持ち主が
 * スタッフ・取次パートナーのときだけ、その人を担当として扱う。
 */
type OrderView = OrderWithReward & {
  reviewResult: string;
  deliveredOn: string;
  /** 担当スタッフのコード。分からないときは空。 */
  staffCode: string;
  /** 担当スタッフの名前。分からないときは空。 */
  staffName: string;
  /** 担当スタッフの所属（「会社名・種別」）。分からないときは、その理由。 */
  staffNote: string;
  /** キャンセル・審査否決で止まっているか。 */
  stopped: boolean;
  /** 進み具合の割合。止まっているものは 0。 */
  percent: number;
};

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    code?: string;
    q?: string;
    order?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);

  // トスアップの「受注を見る」から来たときは、その受注1件だけを開く。
  // どの月の受注か分からないので、期間は全期間にしておく。
  const pinnedOrder = readParam(params, "order").replace(/[^0-9]/g, "");
  const month = pinnedOrder ? ALL : normalizeMonth(readParam(params, "month"), thisMonth);
  const selectedCode = readParam(params, "code") || ALL;
  const keyword = readParam(params, "q");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  const allPeriod = month === ALL;
  const periodLabel = allPeriod ? "全期間" : jpMonthLabel(month);

  let self: Agency | null = null;
  let members: Agency[] = [];
  let periodOrders: OrderView[] = [];
  let error: string | null = null;

  try {
    self = await findAgencyByCode(viewer.code);
    if (!self) {
      error = `代理店一覧にあなたのコード（${viewer.code}）が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      const descendants = await listDescendants(self.code);
      members = [self, ...descendants];
      const { orders, raw } = await listOrders(
        scopeCodes(self, descendants),
        allPeriod ? {} : { month },
      );

      // 受注1件ごとの「審査結果」「売ったスタッフ」「お客様」。
      // 進み具合と担当スタッフの判定に使う。
      const reviewByOrder = new Map<string, string>();
      const staffByOrder = new Map<string, string>();
      const customerByOrder = new Map<string, string>();
      for (const r of raw) {
        const id = text(r, "id");
        if (!id) continue;
        reviewByOrder.set(id, text(r, "review_result"));
        staffByOrder.set(id, text(r, "staff_code"));
        const customerId = text(r, "customer_id");
        if (customerId) customerByOrder.set(id, customerId);
      }

      /*
       * 配達が終わった日。
       * 2026-08-26 から受注（orders.delivered_on）が本体で、
       * 顧客台帳（customers.delivered_on）はそれ以前の分の受け皿。
       * 受注側に入っていればそちらを使う。
       */
      const deliveredByCustomer = new Map<string, string>();
      const customerIds = [...new Set(customerByOrder.values())].filter((id) =>
        /^\d+$/.test(id),
      );
      if (customerIds.length > 0) {
        try {
          const rows = await select<Row>(
            `customers?select=id,delivered_on&id=in.(${customerIds.join(",")})`,
          );
          for (const c of rows) {
            const day = text(c, "delivered_on");
            if (day) deliveredByCustomer.set(text(c, "id"), day);
          }
        } catch {
          // 配達完了日が読めなくても、出荷までの進み具合は表示できるので続ける
        }
      }

      const memberByCode = new Map(members.map((m) => [m.code, m]));

      /*
       * 担当スタッフの下に出す「どこの会社の、どの立場の人か」。
       * 会社名と種別は「スタッフ一覧」で設定したものをそのまま出す。
       * コードは隣の「担当コード」の欄に出ているので、ここでは繰り返さない。
       */
      const affiliationOf = (p: Agency) =>
        [companyNameOf(p), agencyTypeOf(p.rank, p.channel, p.codeKind, p.staffType)]
          .filter(Boolean)
          .join("・");

      /** 誰が売ったか。受注のスタッフ欄が空のときは担当コードから補う。 */
      const staffOf = (o: OrderWithReward) => {
        const code = staffByOrder.get(o.recordId) ?? "";
        if (code) {
          const person = memberByCode.get(code);
          return {
            staffCode: code,
            staffName: person?.name ?? "",
            staffNote: person ? affiliationOf(person) : "代理店一覧に該当なし",
          };
        }
        // 取次紹介コードが入っている受注は、その取次パートナー本人が売った扱い。
        const owner = memberByCode.get(o.ownerCode);
        if (owner && (owner.codeKind === "01" || owner.codeKind === "02")) {
          return {
            staffCode: owner.code,
            staffName: owner.name,
            staffNote: affiliationOf(owner),
          };
        }
        return {
          staffCode: "",
          staffName: "",
          staffNote: "担当スタッフの記録なし",
        };
      };

      periodOrders = orders.map((o) => {
        const reviewResult = reviewByOrder.get(o.recordId) ?? "";
        const deliveredOn =
          o.deliveredAt ||
          deliveredByCustomer.get(customerByOrder.get(o.recordId) ?? "") ||
          "";
        const state = progressOf({
          reviewResult,
          shipStatus: o.shippingStatus,
          deliveredOn,
        });
        return {
          ...o,
          ...staffOf(o),
          reviewResult,
          deliveredOn,
          stopped: state.stopped,
          percent: state.stopped ? 0 : state.percent,
        };
      });
    }
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "受注データを取得できませんでした。時間をおいて画面を読み込み直してください。";
  }

  const header = (
    <PageHeader
      title="顧客一覧"
      description="自分とスタッフが獲得した受注です。申込から商品のお届けまで、いまどこまで進んでいるかを一覧で確認できます。お客様のお名前・電話番号で探せます。"
      actions={<AutoRefresh seconds={REFRESH_SECONDS} label="顧客一覧" />}
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

  const nameByCode = new Map(members.map((m) => [m.code, m.name]));

  // トスアップから1件だけを開いているときは、その受注に絞る。
  const scoped = pinnedOrder
    ? periodOrders.filter((o) => o.recordId === pinnedOrder)
    : periodOrders;

  /*
   * 担当コード → その人が属している会社のコード。
   * 会社を選んで絞ったときに、その会社のスタッフぶんも拾えるようにする。
   * さかのぼるのは1段だけ（会社 → その下）。
   */
  const companyOfCode = new Map<string, string>();
  for (const m of members) {
    if (m.parentCode) companyOfCode.set(m.code, m.parentCode);
  }

  // 担当コードごとの件数（期間で絞ったあと・担当で絞る前）
  const countByCode = new Map<string, number>();
  for (const o of scoped) {
    const key = o.ownerCode || "";
    countByCode.set(key, (countByCode.get(key) ?? 0) + 1);
    // 会社を選んだときの件数にも、その会社の人ぶんを足しておく
    const company = companyOfCode.get(key);
    if (company && company !== key) {
      countByCode.set(company, (countByCode.get(company) ?? 0) + 1);
    }
  }

  // 選択肢は「スタッフの全コード」＋「受注に出てきたコード」。0件の人も選べるようにする。
  const optionCodes = new Set<string>(members.map((m) => m.code).filter(Boolean));
  for (const code of countByCode.keys()) if (code) optionCodes.add(code);

  const ownerOptions: FilterOption[] = [...optionCodes]
    .map((code) => ({
      code,
      name: nameByCode.get(code) ?? "",
      count: countByCode.get(code) ?? 0,
      isSelf: code === self?.code,
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.code.localeCompare(b.code);
    })
    .map((o) => ({
      value: o.code,
      label: `${o.code}${o.name ? `　${o.name}` : ""}${o.isSelf ? "（自分）" : ""}`,
      count: o.count,
    }));

  const monthOptions: FilterOption[] = months.map((m) => ({
    value: m,
    label: `${jpMonthLabel(m)}${m === thisMonth ? "（今月）" : ""}`,
    count: 0,
  }));

  /* --- 絞り込み --- */
  const found = scoped.filter((o) => {
    /*
      担当で絞る。会社（旧方式で自分のコードを持つ ITSU など）を選んだときは、
      その会社に所属する人ぶんも含める。
      2026-08-22 に担当をスタッフ本人にしたため、会社コードだけで絞ると
      その会社の売上が1件も出てこなくなる。
    */
    if (selectedCode !== ALL) {
      const own = o.ownerCode === selectedCode;
      const sameCompany = companyOfCode.get(o.ownerCode) === selectedCode;
      if (!own && !sameCompany) return false;
    }
    // 2026-07-09 の回答書どおり、お客様の氏名と電話番号で探せるようにする。
    return matchesKeyword(keyword, [o.customerName, o.phone]);
  });

  /* --- 並び替え --- */
  const accessors: Accessors<OrderView> = {
    date: (o) => o.date,
    customer: (o) => o.customerName,
    product: (o) => o.productName,
    qty: (o) => o.quantity || 1,
    amount: (o) => o.amount,
    owner: (o) => o.ownerCode,
    staff: (o) => o.staffName || o.staffCode,
    progress: (o) => o.percent,
    review: (o) => o.reviewResult,
    ship: (o) => o.shippingStatus,
  };
  const rows = sortRows(found, sort.column, sort.desc, accessors);

  // キャンセルと審査否決は、売上にも台数にも数えない。
  // ただし表からは消さず、件数を別に出して気づけるようにする。
  const live = rows.filter((o) => !o.stopped);
  const stoppedCount = rows.length - live.length;
  const unitTotal = live.reduce((s, o) => s + (o.quantity || 1), 0);
  const salesTotal = live.reduce((s, o) => s + o.amount, 0);
  const shippedCount = live.filter((o) => o.percent >= 80).length;
  const deliveredCount = live.filter((o) => o.percent >= 100).length;

  const legendSteps =
    deliveredCount > 0
      ? PROGRESS_STEPS
      : PROGRESS_STEPS.filter((s) => s.key !== "delivered");

  const selectedName = nameByCode.get(selectedCode) ?? "";
  const isFiltered = Boolean(keyword) || selectedCode !== ALL;
  const clearHref = buildListHref(BASE, params, { q: "", code: "" });
  const allHref = buildListHref(BASE, params, {
    q: "",
    code: "",
    order: "",
    month: "",
  });

  return (
    <div className="space-y-6">
      {header}

      {pinnedOrder ? (
        <Notice tone="info">
          トスアップから受注番号 {pinnedOrder} を開いています。
          <Link
            href={allHref}
            className="ml-1.5 underline underline-offset-2 hover:text-gold-300"
          >
            すべての受注に戻る
          </Link>
        </Notice>
      ) : null}

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
            width="w-64"
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
          <FilterSelect
            name="code"
            label="担当コード"
            value={selectedCode}
            options={ownerOptions}
            allLabel={`すべての担当（${scoped.length}）`}
            width="w-72"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={scoped.length}
          shown={rows.length}
          clearHref={clearHref}
          note={periodLabel}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="受注件数"
          value={String(live.length)}
          unit="件"
          hint={
            stoppedCount > 0
              ? `${periodLabel}（中止 ${stoppedCount}件を除く）`
              : periodLabel
          }
        />
        <StatTile label="台数" value={String(unitTotal)} unit="台" hint="数量の合計" />
        <StatTile
          label="販売金額"
          value={yen(salesTotal)}
          tone="gold"
          hint="お客様のお支払額の合計（中止分を除く）"
        />
        <StatTile
          label="配達完了の受注"
          value={String(deliveredCount)}
          unit="件"
          tone={stoppedCount > 0 ? "warn" : "default"}
          hint={
            stoppedCount > 0
              ? `中止になった受注が ${stoppedCount} 件あります`
              : shippedCount > deliveredCount
                ? `配達完了の合計（ほかに発送済が ${shippedCount - deliveredCount} 件）`
                : "配達完了の合計"
          }
        />
      </div>

      {stoppedCount > 0 ? (
        <Notice tone="warn">
          キャンセル・審査否決になった受注が {stoppedCount} 件あります。
          台数・販売金額には数えていませんが、下の表には「中止」として残しています。
        </Notice>
      ) : null}

      {/*
        売上・報酬と件数が合わない、という問い合わせが実際にあった。
        この画面は受注日、売上・報酬は配達完了日で月を切っているため、
        受注した月とお届けした月が違う受注は、必ずどちらか片方にしか出ない。
      */}
      <Notice tone="info">
        この画面は「受注日」で月を切っています。売上・報酬は「配達完了日」で切るため、
        同じ月でも件数は一致しません（受注した月と、お届けした月が違うため）。
      </Notice>

      <Card
        title={`受注明細（${periodLabel}${
          selectedCode === ALL ? "" : `・${selectedCode}`
        }）`}
        action={
          <span className="text-xs text-ink-400">
            担当={selectedCode === ALL ? "すべて" : selectedCode}
          </span>
        }
      >
        {rows.length === 0 ? (
          isFiltered ? (
            <EmptyState
              title="条件に合う受注がありません"
              description={`お名前・電話番号は一部でも探せます。担当コードを「すべての担当」に、期間を「全期間」に広げると見つかることがあります。${
                selectedCode === ALL
                  ? ""
                  : `いまは ${selectedCode}${
                      selectedName ? `（${selectedName}）` : ""
                    } の分だけを表示する条件です。`
              }`}
            />
          ) : pinnedOrder ? (
            <EmptyState
              title="この受注は見つかりませんでした"
              description="成約したトスアップに紐づく受注が、まだ登録されていないか、ご自身の担当から外れています。本部にお問い合わせください。"
            />
          ) : (
            <EmptyState
              title={
                allPeriod ? "まだ受注がありません" : `${periodLabel}の受注はありません`
              }
              description={
                allPeriod
                  ? "QR2の決済が完了すると、この一覧に自動で表示されます。反映は数分以内です。"
                  : "期間を「全期間」に切り替えると、これまでの受注を確認できます。"
              }
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  column="date"
                  label="受注日"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="customer"
                  label="顧客名"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <Th>電話番号</Th>
                <SortableTh
                  column="product"
                  label="商品名"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="qty"
                  label="台数"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                  align="right"
                />
                <SortableTh
                  column="amount"
                  label="金額"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                  align="right"
                />
                <SortableTh
                  column="owner"
                  label="担当コード"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="staff"
                  label="担当スタッフ"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="progress"
                  label="進み具合"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="review"
                  label="審査結果"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="ship"
                  label="出荷状況・送り状番号"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <Th>照合ステータス</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const name = nameByCode.get(o.ownerCode);
                return (
                  <tr key={o.recordId}>
                    <Td numeric>{orderDate(o.date, allPeriod)}</Td>
                    <Td>{o.customerName || "—"}</Td>
                    <Td numeric>{o.phone || "—"}</Td>
                    <Td className="min-w-[13rem] max-w-[22rem]">
                      <span className="line-clamp-2 leading-snug" title={o.productName || undefined}>
                        {o.productName || "—"}
                      </span>
                    </Td>
                    <Td numeric align="right">
                      {o.quantity || 1}
                    </Td>
                    <Td numeric align="right">
                      {yen(o.amount)}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {o.ownerCode ? (
                          <Badge tone="gold">{o.ownerCode}</Badge>
                        ) : (
                          <Badge>担当コードなし</Badge>
                        )}
                        {o.ownerCode && o.ownerCode === self?.code ? (
                          <Badge>自分</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-ink-400">
                        {name ?? (o.ownerCode ? "代理店一覧に該当なし" : "本部へ確認が必要です")}
                      </div>
                    </Td>
                    <Td>
                      {o.staffCode || o.staffName ? (
                        <>
                          <div className="text-ink-100">
                            {o.staffName || "（名称未登録）"}
                          </div>
                          <div className="mt-1 text-xs text-ink-400">
                            {o.staffNote || "所属が未設定です"}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-ink-500">—</span>
                          <div className="mt-1 text-xs text-ink-400">{o.staffNote}</div>
                        </>
                      )}
                    </Td>
                    <Td>
                      <Progress
                        compact
                        reviewResult={o.reviewResult}
                        shipStatus={o.shippingStatus}
                        deliveredOn={o.deliveredOn}
                      />
                    </Td>
                    <Td>
                      <StatusBadge status={o.reviewResult} />
                    </Td>
                    <Td>
                      <StatusBadge status={o.shippingStatus} />
                      <div className="mt-1.5 text-xs">
                        {o.trackingNo ? (
                          <a
                            href={yamatoTrackingUrl(o.trackingNo)}
                            target="_blank"
                            rel="noreferrer"
                            className="tabnum text-gold-300 underline underline-offset-2 transition hover:text-gold-100"
                          >
                            {o.trackingNo}
                          </a>
                        ) : (
                          <span className="text-ink-500">送り状番号はまだありません</span>
                        )}
                      </div>
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
                <Td className="font-semibold text-ink-50">合計</Td>
                <Td className="font-semibold text-ink-50">{live.length}件</Td>
                <Td> </Td>
                <Td> </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-300">
                  {yen(salesTotal)}
                </Td>
                <Td> </Td>
                <Td> </Td>
                <Td className="text-xs text-ink-400">
                  配達完了 {deliveredCount}件
                </Td>
                <Td className="text-xs text-ink-400">
                  {stoppedCount > 0 ? `中止 ${stoppedCount}件は合計に含めていません` : " "}
                </Td>
                <Td> </Td>
                <Td> </Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {rows.length > 0 ? (
        <Card title="進み具合の見方">
          <div className="space-y-3 px-5 py-4">
            <StageLegend steps={legendSteps} />
            <p className="text-xs leading-relaxed text-ink-400">
              送り状番号をクリックすると、ヤマト運輸の荷物追跡ページが別の画面で開きます。
              お客様へお伝えするときは、この番号をそのままお知らせください。
              {deliveredCount > 0
                ? "配達完了は、本部が配達の完了を確認した時点で反映されます。"
                : "この一覧でお知らせできるのは出荷済までです。お手元に届いたかどうかは、送り状番号から荷物追跡ページでご確認ください。"}
            </p>
          </div>
        </Card>
      ) : null}

      <Notice tone="info">
        担当コードは、取次紹介コードが入っている受注ではそのコード、入っていない受注では受注に記録された代理店コードです。
        「担当スタッフ」は受注に記録された、実際に売った方です。記録が無い受注は、担当コードの持ち主が
        取次パートナー・スタッフのときだけその方を出し、会社としての受注は「—」と表示します。
        コードの下の名前は代理店一覧から引いています。名前が出ない場合は、代理店一覧にそのコードが登録されていないか、
        スタッフから外れています。
      </Notice>
    </div>
  );
}
