import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { scopeCodes } from "@/lib/orders";
import {
  isOverdue,
  listDemoMachines,
  summarizeDemoMachines,
  todayInJapan,
  type DemoMachine,
} from "@/lib/demo";
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

export const metadata = { title: "デモ機｜VIS 代理店ポータル" };

const BASE = "/demo-machines";

/** 端末状態。保存先の設定と同じ並びにしてある（本部のデモ機管理と同じ）。 */
const STATES = ["在庫", "設置済", "貸出中", "返却済", "故障・修理", "廃棄"];

/** 端末状態のほかに選べる、期限切れだけの絞り込み。 */
const OVERDUE = "overdue";

/** 見出しを押して並び替えられる列。 */
const SORT_COLUMNS = [
  "serial",
  "model",
  "state",
  "holderCode",
  "acquired",
  "lentTo",
  "due",
];

/** 既定は取得日の新しい順（取得したままの並び）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

/** "2026-08-07" を "2026/8/7" にする。年をまたぐ台帳なので年まで出す。 */
function fullDate(v: string): string {
  if (!v) return "—";
  return `${v.slice(0, 4)}/${jpDate(v)}`;
}

/**
 * 返却予定日を何日過ぎているか。過ぎていなければ 0。
 * 本部のデモ機管理と同じ出し方にそろえるため、日数まで出す。
 */
function overdueDaysOf(m: DemoMachine, today: string): number {
  if (!isOverdue(m, today)) return 0;
  const due = Date.parse(`${m.dueOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

export default async function DemoMachinesPage({
  searchParams,
}: {
  searchParams: Promise<{
    state?: string;
    q?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const stateRaw = readParam(params, "state");
  const state = stateRaw === OVERDUE || STATES.includes(stateRaw) ? stateRaw : ALL;
  const keyword = readParam(params, "q");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  const today = todayInJapan();

  let self: Agency | null = null;
  let machines: DemoMachine[] = [];
  let error: string | null = null;

  try {
    self = await findAgencyByCode(viewer.code);
    if (!self) {
      error = `代理店一覧にあなたのコード（${viewer.code}）が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      const descendants = await listDescendants(self.code);
      machines = await listDemoMachines(scopeCodes(self, descendants));
    }
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "デモ機の情報を取得できませんでした。時間をおいて画面を読み込み直してください。";
  }

  const header = (
    <PageHeader
      title="デモ機"
      description="自分と配下が保有しているデモ機の一覧です。製造番号・状態・保有代理店・貸出先を確認できます。表の見出しを押すと並び替わります。"
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          {error}
          <br />
          しばらく待っても直らない場合は、本部にご連絡ください。
        </Notice>
      </div>
    );
  }

  const summary = summarizeDemoMachines(machines, today);

  /* --- 絞り込み --- */
  const inState =
    state === ALL
      ? machines
      : state === OVERDUE
        ? machines.filter((m) => isOverdue(m, today))
        : machines.filter((m) => m.condition === state);

  const found = inState.filter((m) =>
    matchesKeyword(keyword, [
      m.serial,
      m.model,
      m.holderName,
      m.holderCode,
      m.lentTo,
      m.customerName,
    ]),
  );

  /* --- 並び替え --- */
  const accessors: Accessors<DemoMachine> = {
    serial: (m) => m.serial,
    model: (m) => m.model,
    // 状態は五十音順ではなく、台帳と同じ並び（在庫→設置済→…）で並べる
    state: (m) => {
      const i = STATES.indexOf(m.condition);
      return i < 0 ? null : i;
    },
    holderCode: (m) => m.holderCode,
    acquired: (m) => m.acquiredOn,
    lentTo: (m) => m.lentTo,
    due: (m) => m.dueOn,
  };
  const rows = sortRows(found, sort.column, sort.desc, accessors);

  // 端末状態の選択肢に、期限切れだけを見る選択肢を足す。
  // 期限切れは端末状態の値ではないので、buildOptions には渡さない。
  const stateOptions: FilterOption[] = [
    ...buildOptions(
      machines,
      (m) => m.condition,
      STATES,
      state === OVERDUE ? ALL : state,
    ),
    { value: OVERDUE, label: "返却予定日を過ぎている", count: summary.overdue },
  ];

  const isFiltered = Boolean(keyword) || state !== ALL;
  const clearHref = buildListHref(BASE, params, { q: "", state: "" });
  const stateLabel =
    state === ALL
      ? "すべて"
      : state === OVERDUE
        ? "返却予定日を過ぎている"
        : state;

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="保有台数"
          value={String(summary.held)}
          unit="台"
          hint={
            summary.total === summary.held
              ? "登録されているデモ機の合計"
              : `返却済・廃棄の${summary.total - summary.held}台を除く`
          }
        />
        <StatTile
          label="貸出中"
          value={String(summary.onLoan)}
          unit="台"
          hint="お客様や配下にお貸ししている台数"
        />
        <StatTile
          label="故障・修理"
          value={String(summary.inRepair)}
          unit="台"
          tone={summary.inRepair > 0 ? "warn" : "default"}
          hint="修理に出している台数"
        />
      </div>

      {summary.overdue > 0 ? (
        <Notice tone="warn">
          返却予定日を過ぎているデモ機が {summary.overdue} 台あります。貸出先にご確認のうえ、
          回収または返却予定日の変更を本部までご連絡ください。
          <Link
            href={buildListHref(BASE, params, { state: OVERDUE })}
            className="ml-1.5 font-medium text-warn-100 underline underline-offset-2 hover:text-gold-300"
          >
            この {summary.overdue} 台だけを見る
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
            label="キーワード"
            value={keyword}
            placeholder="製造番号・保有代理店・貸出先"
            width="w-64"
          />
          <FilterSelect
            name="state"
            label="端末状態"
            value={state}
            options={stateOptions}
            allLabel={`すべて（${machines.length}）`}
            width="w-56"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={machines.length}
          shown={rows.length}
          unit="台"
          clearHref={clearHref}
          note={`「${stateLabel}」のうち`}
        />
      ) : null}

      <Card title={`デモ機一覧　${rows.length} 台`}>
        {rows.length === 0 ? (
          isFiltered ? (
            <EmptyState
              title="条件に合うデモ機がありません"
              description="キーワードは製造番号・機種・保有代理店・貸出先の一部で探せます。端末状態を「すべて」に戻すと、保有している台すべてから探せます。"
            />
          ) : (
            <EmptyState
              title="デモ機の登録がありません"
              description="デモ機登録フォームから申請すると、ここに表示されます。申請から反映までは本部での登録作業が入ります。"
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  column="serial"
                  label="製造番号"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="model"
                  label="機種"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="state"
                  label="端末状態"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="holderCode"
                  label="保有代理店コード"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <Th>取得区分</Th>
                <SortableTh
                  column="acquired"
                  label="取得日"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="lentTo"
                  label="貸出先"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
                <SortableTh
                  column="due"
                  label="返却予定日"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const late = overdueDaysOf(m, today);
                return (
                  <tr key={m.recordId}>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span className="tabnum font-medium text-ink-50">
                          {m.serial || "—"}
                        </span>
                        {m.reuseFlag === "転用済" ? <Badge tone="gold">転用済</Badge> : null}
                      </div>
                    </Td>
                    <Td>{m.model || "—"}</Td>
                    <Td>
                      <StatusBadge status={m.condition} />
                      {late > 0 ? (
                        <div className="mt-1.5">
                          <Badge tone="warn">返却期限切れ</Badge>
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {m.holderCode ? (
                          <Badge tone={m.holderCode === self?.code ? "gold" : "neutral"}>
                            {m.holderCode}
                          </Badge>
                        ) : (
                          <Badge>コードなし</Badge>
                        )}
                        {m.holderCode && m.holderCode === self?.code ? (
                          <Badge>自分</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-ink-400">
                        {m.holderName || "保有代理店名なし"}
                      </div>
                    </Td>
                    <Td>{m.acquisition || "—"}</Td>
                    <Td numeric>{fullDate(m.acquiredOn)}</Td>
                    <Td>
                      {m.lentTo || "—"}
                      {m.purpose ? (
                        <div className="mt-1 text-xs text-ink-400">{m.purpose}</div>
                      ) : null}
                    </Td>
                    <Td numeric className={late > 0 ? "text-warn-100" : undefined}>
                      {m.returnedOn ? (
                        <span className="text-ink-300">
                          {fullDate(m.returnedOn)} に返却
                        </span>
                      ) : (
                        <>
                          {fullDate(m.dueOn)}
                          {late > 0 ? (
                            <div className="mt-1 text-xs font-medium text-warn-500">
                              返却予定日を {late.toLocaleString("ja-JP")} 日超過
                            </div>
                          ) : null}
                        </>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        「保有代理店コード」は、その台を持っている代理店のコードです（金色はご自身の分）。
        この一覧はデモ機登録フォームから申請された内容をもとにしています。製造番号や貸出先の記載に誤りがある場合、
        ポータルからは直せません。本部までご連絡ください。
      </Notice>
    </div>
  );
}
