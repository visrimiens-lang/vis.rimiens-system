import { redirect } from "next/navigation";
import Link from "next/link";
import { FileText } from "lucide-react";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { effectivePayUnit } from "@/lib/pay-defaults";
import {
  attachRewards,
  canComputeReward,
  currentMonth,
  effectiveRank,
  listOrders,
  recentMonths,
  scopeCodes,
  type OrderWithReward,
} from "@/lib/orders";
import type { Agency } from "@/lib/types";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  jpDate,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import {
  ALL,
  buildListHref,
  parseSort,
  readParam,
  sortRows,
  type Accessors,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import { SortableTh , FilterBar, FilterSelect, FilterActions} from "@/components/SortableTh";
import { rankLabel, companyKey} from "@/lib/labels";
import { MonthSelect } from "./MonthSelect";
import { PrintButton } from "./PrintButton";

const BASE = "/rewards";

/**
 * 見出しを押して並び替えられる列。
 * 単価と報酬額はスタッフには出さないので、スタッフのときは並び替えにも使わせない。
 */
const SORT_COLUMNS = ["shipped", "customer", "product", "qty", "amount", "owner"];
const REWARD_SORT_COLUMNS = [...SORT_COLUMNS, "unit", "reward"];

/** 既定は出荷完了日の新しい順。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

type Row = Record<string, unknown>;

const text = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/**
 * 売上にも報酬にも数えない受注か。
 *
 * キャンセルされた受注と、信販の審査が通らなかった受注は入金にならない。
 * 支払通知のもとになる画面なので、金額にも台数にも入れない。
 * 何件外したかは画面に出して、消えたことに気づけるようにする。
 */
function isStopped(r: Row): boolean {
  return text(r, "ship_status") === "キャンセル" || text(r, "review_result") === "否決";
}

/** 報酬の合計。1件でも算出できないものがあれば null（0円と書かないため）。 */
function sumReward(rows: OrderWithReward[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (r.reward === null) return null;
    total += r.reward;
  }
  return total;
}

function sumUnits(rows: OrderWithReward[]): number {
  return rows.reduce((s, r) => s + (r.quantity || 1), 0);
}

type OwnerGroup = {
  code: string;
  name: string;
  /** 所属している会社の名前。会社ごとの小計をまとめるために使う。 */
  company: string;
  units: number;
  reward: number | null;
  /**
   * この担当（配下）に払う1台あたりの額。
   * 個別に決めた額（組織図で設定）があればそれ、無ければランクの既定。
   * 自分の売上の行と、配下として登録されていないコードは null（払う相手ではない）。
   */
  payUnit: number | null;
  /** payUnit × 台数。支払通知にそのまま使える額。 */
  payout: number | null;
  /** 個別に決めた額か（既定との見分け用） */
  payCustom: boolean;
};

function groupByOwner(
  rows: OrderWithReward[],
  names: Map<string, string>,
  companies: Map<string, string>,
  payTo: Map<string, { unit: number | null; custom: boolean }>,
  /** 担当コード → 支払額を引く相手のコード（スタッフなら所属会社にさかのぼる） */
  payeeOf: Map<string, string>,
  selfCode: string,
): OwnerGroup[] {
  const buckets = new Map<string, OrderWithReward[]>();
  for (const r of rows) {
    const key = r.ownerCode || "（担当コードなし）";
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([code, list]) => {
      const units = sumUnits(list);
      /*
       * 自分の売上には払わない。配下として登録されているコードにだけ支払額を出す。
       *
       * 担当がスタッフのときは、本人に個別の額が入っていればそれを使い、
       * 入っていなければ所属している会社の額を使う（payeeOf がその相手を返す）。
       * 2026-08-22 に担当をスタッフ本人にしたため、ここで会社まで
       * さかのぼらないと、旧方式で登録された会社ぶんの支払額が
       * まるごと「—」になり、支払通知から金額が消える。
       */
      const payeeCode = code !== selfCode ? (payeeOf.get(code) ?? code) : "";
      const pay = payeeCode ? payTo.get(payeeCode) : undefined;
      const payUnit = pay?.unit ?? null;
      return {
        code,
        name: names.get(code) ?? "—",
        company: companies.get(code) ?? "",
        units,
        reward: sumReward(list),
        payUnit,
        payout: payUnit === null ? null : payUnit * units,
        payCustom: pay?.custom ?? false,
      };
    })
    .sort((a, b) => b.units - a.units || a.code.localeCompare(b.code));
}

/** 担当ひとりぶんの行。会社ごとの小計の下にぶら下がる。 */
function MemberRow({ g, showReward }: { g: OwnerGroup; showReward: boolean }) {
  return (
    <tr>
      <Td numeric className="pl-8 text-ink-300">
        {g.code}
      </Td>
      <Td>{g.name}</Td>
      <Td numeric align="right">
        {g.units.toLocaleString("ja-JP")}
      </Td>
      {showReward ? (
        <Td numeric align="right" className="text-ink-50">
          {yen(g.reward)}
        </Td>
      ) : null}
      {showReward ? (
        <Td numeric align="right">
          {g.payUnit === null ? (
            <span className="text-ink-500">—</span>
          ) : (
            <>
              {yen(g.payUnit)}
              {g.payCustom ? <span className="ml-1 text-xs text-gold-500">個別</span> : null}
            </>
          )}
        </Td>
      ) : null}
      {showReward ? (
        <Td numeric align="right" className="text-ink-50">
          {g.payout === null ? <span className="text-ink-500">—</span> : yen(g.payout)}
        </Td>
      ) : null}
    </tr>
  );
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; sort?: string; dir?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const monthParam = readParam(params, "month");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : currentMonth();
  /*
   * 会社・担当での絞り込み（2026-08-26 追加）。
   * 絞ると台数・売上・報酬・お支払額の合計もその範囲で計算し直す。
   * 支払通知を「この会社の分だけ」で作れるようにするため。
   */
  const companyParam = readParam(params, "company") || ALL;
  const ownerParam = readParam(params, "owner") || ALL;
  const months = recentMonths(12);
  const monthOptions = months.includes(month) ? months : [month, ...months];

  let rows: OrderWithReward[] = [];
  let names = new Map<string, string>();
  /** 担当コード → 所属会社名。会社ごとにまとめて見るために使う（2026-08-22〜）。 */
  let companies = new Map<string, string>();
  let payTo = new Map<string, { unit: number | null; custom: boolean }>();
  /** 担当コード → 支払額を引く相手のコード（下の payeeOf の説明を参照）。 */
  let payeeOf = new Map<string, string>();
  /** 報酬の単価を引くときのランク（データベースの値）。表示には rankLabel() を通す。 */
  let rewardRank = "";
  let rewardAvailable = true;
  let rankMissing = false;
  let errorMessage: string | null = null;
  // スタッフ（コード区分 02）には報酬の金額を出さない。
  // 2026-04-23 の打ち合わせで「金額が見えるのは親アカウントだけ」と決まっている。
  let isStaff = false;
  /** 自分の会社名。印刷したときの見出しに出す。 */
  let selfName = "";
  /** キャンセル・審査否決のため集計から外した件数。 */
  let stoppedCount = 0;

  try {
    const self = await findAgencyByCode(viewer.code);
    if (!self) {
      errorMessage = `代理店コード ${viewer.code} の登録が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      selfName = self.name || self.code;
      const descendants = await listDescendants(self.code);
      names = new Map([self, ...descendants].map((a) => [a.code, a.name]));
      /*
       * スタッフは「どこの会社の人か」を持っている（company_name）。
       * 会社そのものの行や、所属が未設定のスタッフは自分の名前でまとめる。
       */
      companies = new Map(
        [self, ...descendants].map((a) => [
          a.code,
          (a.codeKind === "02" ? a.companyName || a.parentName : a.name) || a.name,
        ]),
      );
      // 配下ごとの「1台あたりに払う額」。個別設定（組織図で変更）が最優先。
      payTo = new Map(
        descendants.map((d) => [
          d.code,
          { unit: effectivePayUnit(d), custom: d.payUnit !== null },
        ]),
      );
      /*
       * 「この担当ぶんの支払額を、誰の単価で計算するか」。
       *
       * 2026-08-22 に受注の担当をスタッフ本人にしたため、そのままだと
       * 旧方式（会社が自分のコードを持つ）で登録された会社ぶんの支払額が
       * まるごと「—」になる。ITSU0001 が売った3台は、SASA から見れば
       * 「株式会社樹（ITSU）に払う」ぶんなので、会社までさかのぼって単価を引く。
       *
       *   本人に個別の額が入っている        … 本人
       *   入っていない                     … 自分の直下にあたる祖先までさかのぼる
       *
       * 新方式（スタッフが直下）なら本人がそのまま直下なので、さかのぼらない。
       */
      const parentOf = new Map(descendants.map((d) => [d.code, d.parentCode]));
      payeeOf = new Map(
        descendants.map((d) => {
          if (d.payUnit !== null) return [d.code, d.code];
          let cur = d.code;
          const seen = new Set<string>();
          while (!seen.has(cur)) {
            seen.add(cur);
            const up = parentOf.get(cur);
            if (!up || up === self.code) break;
            cur = up;
          }
          return [d.code, cur];
        }),
      );
      rewardRank = effectiveRank(self);
      rewardAvailable = canComputeReward(self);
      rankMissing = rewardRank === "";
      isStaff = self.codeKind === "02";

      const { raw } = await listOrders(scopeCodes(self, descendants), {
        month,
        basis: "shipped",
      });
      // キャンセルと審査否決は支払の対象にならないので、明細にも合計にも入れない。
      const live = raw.filter((r) => !isStopped(r));
      stoppedCount = raw.length - live.length;
      rows = attachRewards(live, rewardRank).sort((a, b) =>
        (b.shippedAt || "").localeCompare(a.shippedAt || ""),
      );
    }
  } catch (e) {
    errorMessage =
      e instanceof Error
        ? e.message
        : "kintone からの読み込みに失敗しました。時間をおいて開き直してください。";
  }

  // 金額を出してよいのは親アカウントだけ。スタッフには件数と売上だけ見せる。
  const showReward = !isStaff;

  // 並び替え。単価と報酬額の列はスタッフには出さないので、選べる列も分ける。
  const sort = parseSort(
    params,
    DEFAULT_SORT,
    showReward ? REWARD_SORT_COLUMNS : SORT_COLUMNS,
  );
  const accessors: Accessors<OrderWithReward> = {
    shipped: (r) => r.shippedAt,
    customer: (r) => r.customerName,
    product: (r) => r.productName,
    qty: (r) => r.quantity || 1,
    amount: (r) => r.amount,
    owner: (r) => r.ownerCode,
    unit: (r) => r.unitReward,
    reward: (r) => r.reward,
  };
  /*
   * 絞り込みの選択肢は「絞る前の全行」から作る。
   * 絞ったあとの行から作ると、一度選んだ相手しか選択肢に残らなくなる。
   */
  const companyOptionValues = [
    ...new Set(rows.map((r) => companies.get(r.ownerCode) || "").filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "ja"));
  const ownerOptionValues = [
    ...new Set(rows.map((r) => r.ownerCode).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  /** 絞り込んだあとの行。ここから下の集計はすべてこの行を使う。 */
  const shown = rows.filter((r) => {
    if (companyParam !== ALL && (companies.get(r.ownerCode) || "") !== companyParam) {
      return false;
    }
    if (ownerParam !== ALL && r.ownerCode !== ownerParam) return false;
    return true;
  });
  const isFiltered = companyParam !== ALL || ownerParam !== ALL;

  const detail = sortRows(shown, sort.column, sort.desc, accessors);

  const units = sumUnits(shown);
  const salesTotal = shown.reduce((s, r) => s + r.amount, 0);
  const rewardTotal = showReward && rewardAvailable ? sumReward(shown) : null;
  const hasMissingUnit =
    showReward && (!rewardAvailable || shown.some((r) => r.unitReward === null));
  const groups = groupByOwner(shown, names, companies, payTo, payeeOf, viewer.code);

  /*
   * 会社ごとの小計を挟んだ並びを作る（2026-08-22〜）。
   * エリア統括の下が全員スタッフになったので、
   * 「株式会社樹の分」でまとめて見られないと支払通知が作れない。
   * 単価は人ごとに違うため、小計には台数・報酬額・お支払額だけを出す。
   */
  const companyRows: (
    | { kind: "company"; company: string; count: number; units: number; reward: number | null; payout: number | null }
    | { kind: "member"; g: OwnerGroup }
  )[] = [];
  {
    /*
      まとめるキーは表記のゆれを吸収したもの（companyKey）。
      「株式会社樹」と「(株)樹」が2行に割れると、支払通知が二重になる。
      画面に出す名前は、その会社で最初に出てきた書き方をそのまま使う。
    */
    const byCompany = new Map<string, { label: string; list: OwnerGroup[] }>();
    for (const g of groups) {
      const label = g.company || g.name || g.code;
      const key = companyKey(label) || g.code;
      const hit = byCompany.get(key);
      if (hit) hit.list.push(g);
      else byCompany.set(key, { label, list: [g] });
    }
    for (const [, { label: company, list }] of byCompany) {
      const units = list.reduce((s, g) => s + g.units, 0);
      // 会社に1人しかいないときは、小計を挟まずその人の行だけ出す
      if (list.length === 1) {
        companyRows.push({ kind: "member", g: list[0] });
        continue;
      }
      /*
       * 1人でも算出できない人がいれば、小計は出さずに「—」にする。
       * 出せるぶんだけ足すと、欠けた額があるのに「それらしい数字」が出て、
       * そのまま支払通知を作ると払い漏れる。
       * 明細1件ぶんでも単価が引けなければ null にする sumReward と同じ決まり。
       */
      companyRows.push({
        kind: "company",
        company,
        count: list.length,
        units,
        reward: list.some((g) => g.reward === null)
          ? null
          : list.reduce((s, g) => s + (g.reward ?? 0), 0),
        payout: list.some((g) => g.payout === null)
          ? null
          : list.reduce((s, g) => s + (g.payout ?? 0), 0),
      });
      for (const g of list) companyRows.push({ kind: "member", g });
    }
  }
  /*
   * お支払額の合計。
   * 払う相手のうち1人でも単価が引けないときは合計を出さない。
   * 以前は null を 0 として足していたため、スタッフぶんが抜けた額が
   * 「合計」として出て、警告も出ないまま支払通知が作られる状態だった。
   */
  const payable = groups.filter((g) => g.code !== viewer.code);
  const missingPayUnit = payable.filter((g) => g.payout === null);
  const payoutTotal = payable.reduce((t, g) => t + (g.payout ?? 0), 0);
  const hasPayout = payable.length > 0 && missingPayUnit.length === 0;
  const rewardRankText = rankLabel(rewardRank);

  // 「150台 × 62,700円」の形で見せられるのは、単価が1種類に揃っているときだけ。
  const distinctUnits = [...new Set(rows.map((r) => r.unitReward))];
  const singleUnitPrice =
    rows.length > 0 && distinctUnits.length === 1 && distinctUnits[0] !== null
      ? distinctUnits[0]
      : null;

  if (errorMessage) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="売上・報酬"
          description="出荷が完了した受注だけを集計しています。"
        />
        <Notice tone="bad">売上・報酬を読み込めませんでした。{errorMessage}</Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={showReward ? "売上・報酬" : "売上"}
        description={
          showReward
            ? `出荷が完了した受注だけを集計しています。${jpMonthLabel(month)}に出荷が完了した分が対象です。`
            : `ご自身が売った件数と売上金額です。${jpMonthLabel(month)}に出荷が完了した分が対象です。`
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {/*
              支払通知書は「誰に払うか」が決まらないと作れないので、
              会社または担当で絞り込んでいるときだけ出す。
            */}
            {isFiltered ? (
              <Link
                href={`/rewards/notice?month=${month}${
                  companyParam !== ALL ? `&company=${encodeURIComponent(companyParam)}` : ""
                }${ownerParam !== ALL ? `&owner=${encodeURIComponent(ownerParam)}` : ""}`}
                className="inline-flex items-center gap-2 rounded-lg border border-gold-500/50 px-3 py-1.5 text-xs font-medium text-gold-300 transition hover:bg-gold-500/10"
              >
                <FileText className="h-3.5 w-3.5" />
                支払通知書を作る
              </Link>
            ) : null}
            <PrintButton />
            <MonthSelect months={monthOptions} value={month} />
          </div>
        }
      />

      <Notice tone="info">
        出荷が完了した受注だけを集計しています。出荷完了日が{jpMonthLabel(month)}
        の受注が対象で、まだ出荷していない受注はここには出ません。
        お客様のお手元に届く「配達完了」より前の段階で対象になるため、
        顧客一覧の進み具合とは表示がずれることがあります。
        {showReward && rewardRank
          ? `報酬額は「${rewardRankText}」としての単価で計算しています。`
          : null}
      </Notice>

      {showReward ? null : (
        <Notice tone="info">
          報酬の金額は所属先の代理店にお問い合わせください。
          この画面では、ご自身が売った件数と売上金額のみ表示しています。
        </Notice>
      )}

      {/*
        3次（販売代理店）と取次店へのお支払いは、本部ではなく上位のエリア統括代理店から。
        この画面の報酬額は商品マスタの税込単価で出した目安なので、
        実際に受け取る額（上位が決める・税抜）とは基準が違う。
        黙っていると「画面より5,000円少ない」という行き違いが起きるため、先に断っておく。
      */}
      {showReward && (rewardRank === "販売代理店" || rewardRank === "取次店") ? (
        <Notice tone="info">
          この画面の報酬額は、商品マスタの税込単価で計算した目安です。
          実際のお支払いは上位の代理店からとなり、1台あたりの金額は
          上位の代理店が決めます（税抜。ご不明な場合は上位の代理店にご確認ください）。
        </Notice>
      ) : null}

      {stoppedCount > 0 ? (
        <Notice tone="warn">
          {jpMonthLabel(month)}に出荷が完了したもののうち {stoppedCount} 件は、キャンセル
          または信販の審査が通らなかったため、この画面の台数・売上
          {showReward ? "・報酬" : ""}には数えていません。内容は顧客一覧でご確認ください。
        </Notice>
      ) : null}

      {/*
        紙・PDFにしたときだけ出る見出し。
        画面には出さない（画面には同じ内容がページ上部にあるため）。
        これが無いと、印刷した紙が「誰の・いつの・どの範囲の集計か」分からない。
      */}
      <div className="print-only" style={{ marginBottom: "8mm" }}>
        <div style={{ fontSize: "14pt", fontWeight: 700 }}>
          売上・報酬のご案内（{jpMonthLabel(month)}）
        </div>
        <div style={{ fontSize: "10pt", marginTop: "2mm" }}>
          {selfName}（{viewer.code}）　／　出荷完了日が{jpMonthLabel(month)}の分
          {companyParam !== ALL ? `　／　会社：${companyParam}` : ""}
          {ownerParam !== ALL ? `　／　担当：${ownerParam}` : ""}
        </div>
        <div style={{ fontSize: "9pt", marginTop: "1mm", color: "#555" }}>
          出力日：{new Date().toLocaleDateString("ja-JP")}
        </div>
      </div>

      {/*
        会社・担当での絞り込み。絞ると下の合計もその範囲で計算し直す。
        「この会社の分だけ」で支払通知を作れるようにするため。
      */}
      {companyOptionValues.length > 0 || ownerOptionValues.length > 0 ? (
        <Card>
          <FilterBar action={BASE} hidden={{ month, sort: sort.column, dir: sort.desc ? "desc" : "asc" }}>
            {companyOptionValues.length > 0 ? (
              <FilterSelect
                name="company"
                label="会社で絞る"
                value={companyParam}
                options={companyOptionValues.map((v) => ({
                  value: v,
                  label: v,
                  count: rows.filter((r) => (companies.get(r.ownerCode) || "") === v).length,
                }))}
                allLabel={`すべての会社（${rows.length}）`}
                width="w-64"
              />
            ) : null}
            <FilterSelect
              name="owner"
              label="担当で絞る"
              value={ownerParam}
              options={ownerOptionValues.map((v) => ({
                value: v,
                label: `${v}${names.get(v) ? `　${names.get(v)}` : ""}`,
                count: rows.filter((r) => r.ownerCode === v).length,
              }))}
              allLabel={`すべての担当（${rows.length}）`}
              width="w-64"
            />
            <FilterActions
              clearHref={buildListHref(BASE, params, { company: "", owner: "" })}
              filtered={isFiltered}
            />
          </FilterBar>
        </Card>
      ) : null}

      {isFiltered ? (
        <Notice tone="info">
          絞り込み中です（{companyParam !== ALL ? `会社：${companyParam}` : ""}
          {companyParam !== ALL && ownerParam !== ALL ? " ／ " : ""}
          {ownerParam !== ALL ? `担当：${ownerParam}` : ""}）。
          下の台数・売上{showReward ? "・報酬・お支払額" : ""}は、この範囲だけの合計です。
          全{rows.length}件のうち {shown.length} 件を表示しています。
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="出荷完了台数"
          value={units.toLocaleString("ja-JP")}
          unit="台"
          hint={`受注 ${shown.length.toLocaleString("ja-JP")} 件分`}
        />
        <StatTile label="売上合計" value={yen(salesTotal)} hint="出荷完了分の販売金額" />
        {showReward ? (
          <StatTile
            label="報酬合計"
            value={yen(rewardTotal)}
            tone="gold"
            hint={
              singleUnitPrice !== null
                ? `${units.toLocaleString("ja-JP")}台 × ${yen(singleUnitPrice)}`
                : rewardTotal === null
                  ? "一部の単価が未設定のため算出できません"
                  : "この金額が振込対象です"
            }
          />
        ) : (
          <StatTile
            label="受注件数"
            value={rows.length.toLocaleString("ja-JP")}
            unit="件"
            hint="出荷が完了した受注の件数"
          />
        )}
      </div>

      {hasMissingUnit ? (
        <Notice tone="warn">
          {rankMissing
            ? "代理店ランクが登録されていないため、報酬額を計算できません。本部にご確認ください。"
            : "販売代理店分の1台あたり単価が商品マスタに未設定のため、金額を表示できません。本部にお問い合わせください。"}
        </Notice>
      ) : null}

      {/*
        支払額が出せない相手がいるときは、必ず知らせる。
        黙って0として足すと、欠けた額に気づかないまま支払通知が作られる。
      */}
      {showReward && missingPayUnit.length > 0 ? (
        <Notice tone="warn">
          支払額を出せない担当が {missingPayUnit.length} 名います（
          {missingPayUnit.map((g) => g.name || g.code).join("、")}）。
          「組織と枠」でその方の支払額（1台あたり・税抜）を入れると、お支払額と合計が出ます。
          入るまで、お支払額の合計は出しません。
        </Notice>
      ) : null}

      <Card title={`出荷完了の明細（${jpMonthLabel(month)}）`}>
        {rows.length === 0 ? (
          <EmptyState
            title="この月はまだ出荷が完了した受注がありません"
            description="報酬は商品の出荷が完了した時点で確定します。出荷前の受注は顧客一覧でご確認いただけます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh
                  column="shipped"
                  label="出荷完了日"
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
                  label="販売金額"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                  align="right"
                />
                {showReward ? (
                  <SortableTh
                    column="unit"
                    label="単価"
                    sort={sort}
                    basePath={BASE}
                    params={params}
                    align="right"
                  />
                ) : null}
                {showReward ? (
                  <SortableTh
                    column="reward"
                    label="報酬額"
                    sort={sort}
                    basePath={BASE}
                    params={params}
                    align="right"
                  />
                ) : null}
                <SortableTh
                  column="owner"
                  label="担当コード"
                  sort={sort}
                  basePath={BASE}
                  params={params}
                />
              </tr>
            </thead>
            <tbody>
              {detail.map((r) => (
                <tr key={r.recordId}>
                  <Td numeric>{jpDate(r.shippedAt)}</Td>
                  <Td>{r.customerName || "—"}</Td>
                  <Td className="min-w-[13rem] max-w-[22rem]">
                      <span className="line-clamp-2 leading-snug" title={r.productName || undefined}>
                        {r.productName || "—"}
                      </span>
                    </Td>
                  <Td numeric align="right">
                    {(r.quantity || 1).toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right">
                    {yen(r.amount)}
                  </Td>
                  {showReward ? (
                    <Td numeric align="right">
                      {yen(r.unitReward)}
                    </Td>
                  ) : null}
                  {showReward ? (
                    <Td numeric align="right" className="text-ink-50">
                      {yen(r.reward)}
                    </Td>
                  ) : null}
                  <Td numeric>{r.ownerCode || "—"}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {units.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {yen(salesTotal)}
                </Td>
                {showReward ? <Td>{null}</Td> : null}
                {showReward ? (
                  <Td numeric align="right" className="font-semibold text-gold-400">
                    {yen(rewardTotal)}
                  </Td>
                ) : null}
                <Td>{null}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {rows.length > 0 ? (
        <Card
          title={
            showReward ? "担当ごとの内訳（支払通知の作成用）" : "担当ごとの内訳（台数）"
          }
        >
          <Table>
            <thead>
              <tr>
                <Th>会社・担当コード</Th>
                <Th>名前</Th>
                <Th align="right">台数</Th>
                {showReward ? <Th align="right">報酬額</Th> : null}
                {/* 配下にいくら払うか。単価は組織図で変更できる（個別 or ランクの既定） */}
                {showReward ? <Th align="right">支払単価（税抜）</Th> : null}
                {showReward ? <Th align="right">お支払額（税抜）</Th> : null}
              </tr>
            </thead>
            <tbody>
              {companyRows.map((row) =>
                row.kind === "company" ? (
                  /*
                    会社ごとの小計。2026-08-22 から、エリア統括の下は全員スタッフになり、
                    「株式会社樹の分をまとめて」という見方が要る（庄司さんの依頼）。
                    単価とお支払額は人ごとに違うので、小計には出さない。
                  */
                  <tr key={`c:${row.company}`} className="bg-ink-900/60">
                    <Td className="font-semibold text-ink-100" >
                      {row.company || "（所属未設定）"}
                    </Td>
                    <Td>
                      <span className="text-xs text-ink-400">{row.count} 名分</span>
                    </Td>
                    <Td numeric align="right" className="font-semibold text-ink-100">
                      {row.units.toLocaleString("ja-JP")}
                    </Td>
                    {showReward ? (
                      <Td numeric align="right" className="font-semibold text-gold-400">
                        {yen(row.reward)}
                      </Td>
                    ) : null}
                    {showReward ? <Td>{null}</Td> : null}
                    {showReward ? (
                      <Td numeric align="right" className="font-semibold text-ink-100">
                        {row.payout === null ? (
                          <span className="text-ink-500">—</span>
                        ) : (
                          yen(row.payout)
                        )}
                      </Td>
                    ) : null}
                  </tr>
                ) : (
                  <MemberRow key={row.g.code} g={row.g} showReward={showReward} />
                ),
              )}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {units.toLocaleString("ja-JP")}
                </Td>
                {showReward ? (
                  <Td numeric align="right" className="font-semibold text-gold-400">
                    {yen(rewardTotal)}
                  </Td>
                ) : null}
                {/* 支払単価は人ごとに違うので、合計は出さない */}
                {showReward ? <Td>{null}</Td> : null}
                {showReward ? (
                  <Td numeric align="right" className="font-semibold text-gold-400">
                    {hasPayout ? yen(payoutTotal) : "—"}
                  </Td>
                ) : null}
              </tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
