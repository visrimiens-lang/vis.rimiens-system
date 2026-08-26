import { bankReady, missingBankFields } from "@/lib/bank";
import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select, selectAll } from "@/lib/db";
import { rankLabel, rankShort } from "@/lib/labels";
import { currentMonth, recentMonths } from "@/lib/orders";
import {
  ALL,
  buildListHref,
  matchesKeyword,
  parseSort,
  readChoice,
  readParam,
  sortRows,
  type Accessors,
  type FilterOption,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
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
import { payMonthAction, payOneAction, undoPayAction } from "@/actions/reward-actions";

/* ------------------------------------------------------------------
 * 報酬の支払管理（本部）。
 *
 * 月末の締めで本部がここだけを見て振込を終えられるようにする画面。
 *   ・その月の報酬を代理店ごとにまとめ、いくら振り込むのかを出す
 *   ・振込先が登録されていない代理店を、真っ先に見つけられるようにする
 *   ・振り込んだら「支払済」にして、いつ払ったかを残す
 *
 * 状態はすべて URL に持たせているので、この画面はサーバーコンポーネントのまま。
 * 支払いの確認（「よろしいですか？」）も、部品の状態ではなく URL で行き来する。
 * 押し間違いで振込の記録が入らないよう、確認を挟まずに支払える経路は作らない。
 *
 * ■ 取消の相殺（マイナスの行）について
 *
 * いまの仕組みでは、相殺のマイナスを「消し込む」手段がどこにもない。
 * 振込額から差し引いても、その行は「確定」のまま同じ月に残り続ける。
 * そのため、下書きが毎回まるごと差し引くと、同じ月に2回以上振り込んだときに
 * 同じ相殺を二度引いてしまい、そのぶん支払いが足りなくなる。
 * ここでは
 *   ・すでにその月に振り込んだ日があるかどうかで、下書きの調整行の既定を決める
 *   ・調整行を入れる／入れないを本部が選べるようにする
 *   ・どの受注の相殺なのか・いつ立ったのか・その月にいつ振り込んだのかを出す
 * ことで、二度引きに気づけるようにしている（根本の消し込みは未実装）。
 * ------------------------------------------------------------------ */

const BASE = "/admin/rewards";

export const metadata = { title: "報酬の支払管理（本部）｜VIS 代理店ポータル" };

/**
 * 一度に読み込む上限。
 *
 * 保存先（Supabase）は1回の問い合わせで 1,000 行までしか返さない。
 * ここは振込額を出す画面なので、足りない状態で合計を出すと
 * 少ない額のまま振り込んでしまう。そのため selectAll で
 * 続きを取りきり、常に全件を合計する。
 *
 * この値は「さすがに多すぎる」を止めるための保険で、
 * ふだんの取得件数の上限ではない。ここに達したときだけ
 * 「全部は出ていない」と画面に書く。
 * 報酬は受注1件から本部が払うぶん（総販・2次の最大2行＋紹介）立つので、受注一覧より多めにとる。
 */
const LIMIT = 20000;

/** rewards.status に入る値。データベースの check 制約と同じ4つ。 */
const REWARD_STATUSES = ["未確定", "確定", "支払済", "取消"];

/**
 * 支払通知の下書きで、取消の相殺を差し引くかどうか。
 * 指定がなければ（ALL のとき）、その月にすでに振り込んだかどうかで自動で決める。
 */
const ADJ_CHOICES = ["on", "off"];

/** 並び替えに使える列。過去に配った URL が効かなくならないよう、名前は変えない。 */
const SORT_COLUMNS = [
  "code",
  "name",
  "rank",
  "count",
  "pending",
  "confirmed",
  "paid",
  "await",
  "bank",
];

/** 既定は「支払い待ちの多い順」。月末にまず見るのがこの順番のため。 */
const DEFAULT_SORT: SortState = { column: "await", desc: true };

/** 表の列数（明細を開いた行が、表の幅いっぱいに広がるようにするため）。 */
const COLUMN_COUNT = 11;

const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong";
const rowBtn =
  "whitespace-nowrap rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs font-medium text-ink-100 transition hover:border-ink-600 hover:text-ink-50";
const quietLink =
  "whitespace-nowrap text-xs text-ink-300 underline underline-offset-4 transition hover:text-gold-300";

type Row = Record<string, unknown>;

const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const n_ = (r: Row, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

/* ══════════════════════════ データの形 ══════════════════════════ */

/** 報酬の1行（明細）。 */
type RewardLine = {
  id: string;
  orderId: string;
  agencyCode: string;
  agencyRank: string;
  amount: number;
  kind: string;
  status: string;
  confirmedOn: string;
  paidOn: string;
  cancelReason: string;
  note: string;
};

function toLine(r: Row): RewardLine {
  return {
    id: s_(r, "id"),
    orderId: s_(r, "order_id"),
    agencyCode: s_(r, "agency_code"),
    agencyRank: s_(r, "agency_rank"),
    amount: n_(r, "amount"),
    kind: s_(r, "kind"),
    status: s_(r, "status"),
    confirmedOn: s_(r, "confirmed_on"),
    paidOn: s_(r, "paid_on"),
    cancelReason: s_(r, "cancel_reason"),
    note: s_(r, "note"),
  };
}

/** 代理店マスタのうち、この画面で使うぶんだけ。 */
type AgencyInfo = {
  code: string;
  name: string;
  rank: string;
  channel: string;
  codeKind: string;
  status: string;
  bankName: string;
  bankBranch: string;
  accountType: string;
  accountNo: string;
  accountHolder: string;
};

function toAgencyInfo(r: Row): AgencyInfo {
  return {
    code: s_(r, "code"),
    name: s_(r, "name"),
    rank: s_(r, "rank"),
    channel: s_(r, "channel"),
    codeKind: s_(r, "code_kind"),
    status: s_(r, "status"),
    bankName: s_(r, "bank_name"),
    bankBranch: s_(r, "bank_branch"),
    accountType: s_(r, "account_type"),
    accountNo: s_(r, "account_no"),
    accountHolder: s_(r, "account_holder"),
  };
}

/*
 * 振込先の判定は src/lib/bank.ts に1つだけ置いてある
 * （サーバー側 reward-actions.ts と条件を揃えるため。
 *   口座番号の形まで見る理由もそちらに書いてある）。
 */

/** 支払通知や確認画面に出す振込先の1行。 */
function bankOneLine(a: AgencyInfo | null): string {
  if (!a) return "未登録";
  const parts = [
    a.bankName,
    a.bankBranch,
    a.accountType,
    a.accountNo,
    a.accountHolder,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "未登録";
}

/* ══════════════════════════ 集計 ══════════════════════════ */

type Totals = {
  /** 明細の件数 */
  count: number;
  /** 未確定の額（配送完了前。まだ支払えない） */
  pending: number;
  /** 確定した額。支払済のぶんも含む */
  confirmed: number;
  /** 支払済の額 */
  paid: number;
  /** 支払い待ち（確定 − 支払済）。マイナスの相殺も含む */
  awaiting: number;
  /** いま支払済にできる額（確定 かつ プラス） */
  payable: number;
  payableCount: number;
  /** 取消の相殺として立っているマイナス（確定のまま残す） */
  offset: number;
  offsetCount: number;
  /** 取り消された元の報酬。合計には数えない */
  cancelled: number;
  cancelledCount: number;
};

const EMPTY_TOTALS: Totals = {
  count: 0,
  pending: 0,
  confirmed: 0,
  paid: 0,
  awaiting: 0,
  payable: 0,
  payableCount: 0,
  offset: 0,
  offsetCount: 0,
  cancelled: 0,
  cancelledCount: 0,
};

/**
 * 報酬の明細を数える。
 *
 * ・「確定」は支払済のぶんも足した「確定した報酬の総額」にする。
 *   支払い待ち（＝これから振り込む額）を 確定 − 支払済 で出せるようにするため。
 * ・キャンセルの相殺として立っているマイナスは、確定と支払い待ちに含める。
 *   翌月の振込額から差し引くためのものなので、支払い待ちから引けていないと
 *   多く振り込んでしまう。
 * ・「取消」になった元の報酬は、どの合計にも入れない（相殺のマイナスと
 *   二重に引いてしまうため）。件数と金額だけ別に持って、画面に残す。
 */
function totalsOf(lines: RewardLine[]): Totals {
  const t: Totals = { ...EMPTY_TOTALS, count: lines.length };
  for (const l of lines) {
    if (l.status === "未確定") {
      t.pending += l.amount;
    } else if (l.status === "確定") {
      t.awaiting += l.amount;
      if (l.amount > 0) {
        t.payable += l.amount;
        t.payableCount += 1;
      } else {
        t.offset += l.amount;
        t.offsetCount += 1;
      }
    } else if (l.status === "支払済") {
      t.paid += l.amount;
    } else if (l.status === "取消") {
      t.cancelled += l.amount;
      t.cancelledCount += 1;
    }
  }
  t.confirmed = t.awaiting + t.paid;
  return t;
}

function sumTotals(list: Totals[]): Totals {
  const out: Totals = { ...EMPTY_TOTALS };
  for (const t of list) {
    out.count += t.count;
    out.pending += t.pending;
    out.confirmed += t.confirmed;
    out.paid += t.paid;
    out.awaiting += t.awaiting;
    out.payable += t.payable;
    out.payableCount += t.payableCount;
    out.offset += t.offset;
    out.offsetCount += t.offsetCount;
    out.cancelled += t.cancelled;
    out.cancelledCount += t.cancelledCount;
  }
  return out;
}

/** 代理店1社ぶんのまとまり。 */
type Group = {
  code: string;
  agency: AgencyInfo | null;
  name: string;
  rank: string;
  /** 絞り込んだあとの明細から出した数字（表に出すもの） */
  shown: Totals;
  /** 絞り込む前の、その月ぜんぶの数字（支払いの判断に使うもの） */
  all: Totals;
  lines: RewardLine[];
  bankOk: boolean;
};

/**
 * 取消の相殺として立っている、確定のままのマイナス行。
 * この行は支払済にならないので、いくら振り込んでも同じ月に残り続ける。
 */
function offsetLinesOf(lines: RewardLine[]): RewardLine[] {
  return lines.filter((l) => l.status === "確定" && l.amount < 0);
}

/** その月に、すでに振込を記録した日（古い順・重複なし）。 */
function paidDatesOf(lines: RewardLine[]): string[] {
  const dates = new Set<string>();
  for (const l of lines) {
    if (l.status === "支払済" && l.paidOn) dates.add(l.paidOn);
  }
  return [...dates].sort();
}

function sumAmount(lines: RewardLine[]): number {
  return lines.reduce((total, l) => total + l.amount, 0);
}

/** 相殺の1行を「どの受注のものか」が分かる一文にする。 */
function offsetLabel(line: RewardLine, order: Row | null): string {
  if (!order) return `受注番号 ${line.orderId || "不明"}`;
  const parts = [
    jpDate(s_(order, "ordered_on")),
    s_(order, "customer_name") ? `${s_(order, "customer_name")} 様` : "",
    s_(order, "product_name"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("　") : `受注番号 ${line.orderId || "不明"}`;
}

function groupLines(lines: RewardLine[]): Map<string, RewardLine[]> {
  const map = new Map<string, RewardLine[]>();
  for (const l of lines) {
    const list = map.get(l.agencyCode) ?? [];
    list.push(l);
    map.set(l.agencyCode, list);
  }
  return map;
}

/* ══════════════════════════ 月まわり ══════════════════════════ */

function normalizeMonth(raw: string, fallback: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : fallback;
}

/** 前後の月。 */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** その月の末日を「2026年9月30日」の形で返す。 */
function lastDayLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}年${m}月${last}日`;
}

/* ══════════════════════ 操作の結果の文言 ══════════════════════ */

/**
 * 支払いの操作から戻ってきたときに出す案内。
 *
 * 操作そのものは src/actions/reward-actions.ts が行い、結果は URL の合図
 * （done）だけで返ってくる。金額と件数以外の情報は URL に載せていないので、
 * 代理店の名前はここで代理店マスタから引き直す。
 */
function resultNotice(
  done: string,
  count: number | null,
  amount: number | null,
  targetName: string,
  month: string,
): { tone: "info" | "warn" | "bad"; body: string } | null {
  const who = targetName ? `${targetName}の` : "";
  const period = jpMonthLabel(month);

  switch (done) {
    case "paid":
      return {
        tone: "info",
        body:
          `${who}${period}分の報酬 ${(count ?? 0).toLocaleString("ja-JP")}件（${yen(amount ?? 0)}）を支払済にしました。` +
          "支払日は今日の日付で記録しています。振込の控えと金額が合っているか、最後にもう一度お確かめください。",
      };
    case "paid1":
      return {
        tone: "info",
        body: `${who}報酬 1件（${yen(amount ?? 0)}）を支払済にしました。支払日は今日の日付で記録しています。`,
      };
    case "undone":
      return {
        tone: "info",
        body:
          `${who}報酬 1件（${yen(amount ?? 0)}）の支払済を取り消しました。` +
          "この報酬は「確定」に戻り、支払い待ちとしてもう一度この画面に出ます。",
      };
    case "none":
      return {
        tone: "warn",
        body:
          `${who}${period}分に、支払済にできる報酬はありませんでした。` +
          "すでに支払済になっているか、まだ配送が完了していない（未確定の）報酬だけが残っています。",
      };
    case "e_perm":
      return { tone: "bad", body: "この操作を行う権限がありません。本部のアカウントでログインし直してください。" };
    case "e_month":
      return { tone: "bad", body: "対象月を読み取れませんでした。月を選び直してから、もう一度お試しください。" };
    case "e_code":
    case "e_row":
      return {
        tone: "bad",
        body: "対象を特定できませんでした。画面を開き直してから、もう一度お試しください。",
      };
    case "e_agency":
      return {
        tone: "bad",
        body:
          "この報酬の代理店コードが、代理店マスタに見つかりませんでした。" +
          "支払先が分からないため、支払済にしていません。代理店の登録内容をご確認ください。",
      };
    case "e_bank":
      return {
        tone: "bad",
        body:
          `${who}振込先が登録されていないため、支払済にできませんでした。` +
          "どこに振り込んだのかを残せないためです。代理店管理の「内容を直す」で、金融機関名・支店名・口座番号・口座名義をご登録ください。",
      };
    case "e_status":
      return {
        tone: "bad",
        body:
          "いまの状態からは支払済にできません。未確定の報酬は配送が完了すると確定し、そのあとで支払えるようになります。" +
          "すでに支払済になっている場合は、画面を開き直すと最新の状態が出ます。",
      };
    case "e_minus":
      return {
        tone: "bad",
        body:
          "取消の相殺（マイナスの行）は支払済にできません。" +
          "このマイナスは、次回の振込額から差し引くためのものです。" +
          "差し引いたあともこの行は残りますので、二度差し引かないようご注意ください。",
      };
    case "e_save":
      return {
        tone: "bad",
        body:
          "支払いの記録を保存できませんでした。時間をおいて、もう一度お試しください。" +
          "続く場合は、支払済になっていないことを明細で確かめてからやり直してください。",
      };
    default:
      return null;
  }
}

/* ══════════════════════════ 小さな部品 ══════════════════════════ */

/**
 * 操作のあとも、いま見ている月・並び順・絞り込みに戻れるようにする。
 * 画面から届いた値は src/actions/reward-actions.ts 側でも検分している。
 */
function NavFields({
  month,
  sort,
  dir,
  status,
  open,
}: {
  month: string;
  sort: string;
  dir: string;
  status: string;
  open: string;
}) {
  return (
    <>
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="sort" value={sort} />
      <input type="hidden" name="dir" value={dir} />
      {status !== ALL ? <input type="hidden" name="status" value={status} /> : null}
      {open ? <input type="hidden" name="open" value={open} /> : null}
    </>
  );
}

/** 振込先。登録されていなければ、そのことがひと目で分かるようにする。 */
function BankCell({ agency }: { agency: AgencyInfo | null }) {
  if (!bankReady(agency)) {
    const missing = missingBankFields(agency);
    return (
      <div className="min-w-0">
        <Badge tone="bad">振込先が未登録</Badge>
        <div className="mt-1 text-xs leading-relaxed text-warn-100">
          {missing.join("・")}がまだです
        </div>
      </div>
    );
  }
  const a = agency!;
  return (
    <div className="min-w-0 leading-relaxed">
      <div className="truncate text-ink-100">
        {a.bankName} {a.bankBranch}
      </div>
      <div className="tabnum truncate text-xs text-ink-400">
        {a.accountType || "種別未設定"} {a.accountNo}
      </div>
      <div className="truncate text-xs text-ink-400">{a.accountHolder}</div>
    </div>
  );
}

/**
 * 相殺が「もう差し引いたものか」を本部が判断するための材料。
 *
 * 消し込みの仕組みが無いため、画面のどこにも「済んだかどうか」は残っていない。
 * せめて、どの受注の相殺なのか・いつ立ったのか・その月にいつ振り込んだのかを
 * 並べて、前回の振込の控えと突き合わせられるようにする。
 */
function OffsetDetails({
  lines,
  orders,
  paidDates,
}: {
  lines: RewardLine[];
  orders: Map<string, Row>;
  paidDates: string[];
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-xs leading-relaxed">
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l.id}>
            <span className="tabnum">{yen(l.amount)}</span>
            {"　"}対象の受注：{offsetLabel(l, orders.get(l.orderId) ?? null)}
            {"　"}相殺が立った日：
            {l.confirmedOn ? jpDate(l.confirmedOn) : "記録なし"}
            {l.cancelReason ? `　理由：${l.cancelReason}` : ""}
          </li>
        ))}
      </ul>
      <div>
        この月にすでに振込を記録した日：
        {paidDates.length > 0
          ? paidDates.map((d) => jpDate(d)).join("・")
          : "まだありません（この振込が初回です）"}
      </div>
    </div>
  );
}

/* ══════════════════════════ 画面 ══════════════════════════ */

export default async function AdminRewardsPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    status?: string;
    keyword?: string;
    open?: string;
    pay?: string;
    adj?: string;
    sort?: string;
    dir?: string;
    done?: string;
    n?: string;
    amt?: string;
    target?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params: SearchParams = await searchParams;

  /* 操作の結果を伝えるクエリは、次にどこかを押した時点で消す。
     古い「支払済にしました」がいつまでも残ると、いま押した操作の結果と紛れるため。 */
  const cleanParams: SearchParams = {
    ...params,
    done: undefined,
    n: undefined,
    amt: undefined,
    target: undefined,
    pay: undefined,
  };
  const linkTo = (patch: Record<string, string | undefined>): string =>
    buildListHref(BASE, cleanParams, patch);

  const thisMonth = currentMonth();
  const month = normalizeMonth(readParam(params, "month"), thisMonth);
  const months = recentMonths(12);
  // 直近12か月に無い月（もっと前をさかのぼったとき）でも、選び直せるように残す。
  const monthChoices = months.includes(month) ? months : [month, ...months];
  const selectedStatus = readChoice(params, "status", REWARD_STATUSES);
  const keyword = readParam(params, "keyword");
  const openCodeRaw = readParam(params, "open");
  const openCode = /^[A-Za-z0-9-]{1,20}$/.test(openCodeRaw) ? openCodeRaw : "";
  const payCodeRaw = readParam(params, "pay");
  const payCode = /^[A-Za-z0-9-]{1,20}$/.test(payCodeRaw) ? payCodeRaw : "";
  // 下書きで相殺を差し引くかどうか。ALL（指定なし）なら、あとで自動で決める。
  const adjChoice = readChoice(params, "adj", ADJ_CHOICES);
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);
  const sortDir = sort.desc ? "desc" : "asc";

  /* --- 読み込み --- */
  let monthLines: RewardLine[] = [];
  let agencies: AgencyInfo[] = [];
  let truncated = false;
  let error: string | null = null;

  try {
    const [rewardRows, agencyRows] = await Promise.all([
      selectAll<Row>(
        `rewards?select=*&month=eq.${encodeURIComponent(month)}` +
          `&order=agency_code.asc,id.asc`,
        { hardLimit: LIMIT },
      ),
      selectAll<Row>(
        "agencies?select=code,name,rank,channel,code_kind,status," +
          "bank_name,bank_branch,account_type,account_no,account_holder&order=code.asc",
      ),
    ]);
    monthLines = rewardRows.map(toLine);
    truncated = rewardRows.length >= LIMIT;
    agencies = agencyRows.map(toAgencyInfo);
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "時間をおいて、画面を開き直してください。";
  }

  const header = (
    <PageHeader
      title="報酬の支払管理"
      description="月次の締めに使う画面です。対象月の報酬を代理店ごとにまとめ、確定した報酬を支払済にして、いつ振り込んだかを記録します。配送が完了していない「未確定」の報酬は支払えません。"
      actions={
        // flex-wrap: スマホで1行に収まらないときは折り返す（画面からはみ出させない）
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={linkTo({ month: shiftMonth(month, -1) })} className={quietLink}>
            ← 前の月
          </Link>
          <span className="tabnum whitespace-nowrap rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-ink-100">
            {jpMonthLabel(month)}
            {month === thisMonth ? "（今月）" : ""}
          </span>
          <Link href={linkTo({ month: shiftMonth(month, 1) })} className={quietLink}>
            次の月 →
          </Link>
        </div>
      }
    />
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          報酬を読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、担当者にご連絡ください。この画面では、まだ何も支払済にしていません。
        </Notice>
      </div>
    );
  }

  const agencyByCode = new Map(agencies.map((a) => [a.code, a]));

  /* --- 絞り込み --- */
  const shownLines = monthLines.filter((l) => {
    if (selectedStatus !== ALL && l.status !== selectedStatus) return false;
    if (keyword) {
      const a = agencyByCode.get(l.agencyCode) ?? null;
      if (!matchesKeyword(keyword, [l.agencyCode, a?.name])) return false;
    }
    return true;
  });

  const allByCode = groupLines(monthLines);
  const shownByCode = groupLines(shownLines);

  const groups: Group[] = [...shownByCode.entries()].map(([code, lines]) => {
    const agency = agencyByCode.get(code) ?? null;
    return {
      code,
      agency,
      name: agency?.name ?? "",
      rank: agency?.rank ?? lines[0]?.agencyRank ?? "",
      shown: totalsOf(lines),
      all: totalsOf(allByCode.get(code) ?? []),
      lines,
      bankOk: bankReady(agency),
    };
  });

  /* --- 並び替え --- */
  const accessors: Accessors<Group> = {
    code: (g) => g.code,
    name: (g) => g.name,
    rank: (g) => g.rank,
    count: (g) => g.shown.count,
    pending: (g) => g.shown.pending,
    confirmed: (g) => g.shown.confirmed,
    paid: (g) => g.shown.paid,
    await: (g) => g.shown.awaiting,
    // 振込先が未登録のものを先に出したいので、未登録を小さい値にする
    bank: (g) => (g.bankOk ? 1 : 0),
  };
  const rows = sortRows(groups, sort.column, sort.desc, accessors);

  /* --- 上のタイル。表に出ているぶんと同じ数字にする --- */
  const totals = sumTotals(groups.map((g) => g.shown));

  /* 振込先の未登録は、絞り込みに関係なく、その月の報酬がある代理店すべてから拾う。
     状態で絞り込んでいるあいだだけ警告が消えると、振り込めない代理店を見落とすため。 */
  const noBank: { code: string; name: string }[] = [];
  const noBankOther: { code: string; name: string }[] = [];
  for (const [code, lines] of allByCode) {
    const agency = agencyByCode.get(code) ?? null;
    if (bankReady(agency)) continue;
    const entry = { code, name: agency?.name ?? "" };
    if (totalsOf(lines).payable > 0) noBank.push(entry);
    else noBankOther.push(entry);
  }

  const isFiltered = selectedStatus !== ALL || Boolean(keyword);
  const clearHref = linkTo({ status: "", keyword: "" });

  const statusOptions: FilterOption[] = REWARD_STATUSES.map((s) => ({
    value: s,
    label: s,
    count: monthLines.filter((l) => l.status === s).length,
  }));
  const monthOptions: FilterOption[] = monthChoices.map((m) => ({
    value: m,
    label: `${jpMonthLabel(m)}${m === thisMonth ? "（今月）" : ""}`,
    count: 0,
  }));

  /* --- 操作の結果 --- */
  const doneRaw = readParam(params, "done");
  const doneCount = /^-?\d+$/.test(readParam(params, "n"))
    ? Number(readParam(params, "n"))
    : null;
  const doneAmount = /^-?\d+$/.test(readParam(params, "amt"))
    ? Number(readParam(params, "amt"))
    : null;
  const doneTarget = readParam(params, "target");
  const doneName = doneTarget
    ? `${agencyByCode.get(doneTarget)?.name || doneTarget}（${doneTarget}）`
    : "";
  const notice = doneRaw ? resultNotice(doneRaw, doneCount, doneAmount, doneName, month) : null;

  /* --- 支払いの確認（「よろしいですか？」） ---
     件数も金額も、絞り込みではなく「その月ぜんぶ」から数える。
     状態で絞り込んだまま押しても、支払う中身が変わらないようにするため
     （実際に何を支払うかは、保存の直前にもう一度データベースから引き直している）。 */
  const payLines = payCode ? (allByCode.get(payCode) ?? []) : [];
  const payAgency = payCode ? (agencyByCode.get(payCode) ?? null) : null;
  const payTotals = payCode ? totalsOf(payLines) : EMPTY_TOTALS;
  const payName = payAgency?.name || (payCode ? "代理店マスタに該当なし" : "");
  /* 相殺は支払済にならないので、確認の画面でも「もう引いたぶんではないか」を
     確かめられるように、対象の受注とすでに振り込んだ日を添える。 */
  const payOffsetLines = offsetLinesOf(payLines);
  const payPaidDates = paidDatesOf(payLines);

  /* --- 明細を開いている代理店 --- */
  const openLines = openCode ? (allByCode.get(openCode) ?? []) : [];
  const openAgency = openCode ? (agencyByCode.get(openCode) ?? null) : null;
  const openTotals = openCode ? totalsOf(openLines) : EMPTY_TOTALS;
  const openOffsetLines = offsetLinesOf(openLines);
  const openOffsetTotal = sumAmount(openOffsetLines);
  const openPaidDates = paidDatesOf(openLines);

  /* 明細と相殺に受注の情報（注文者・商品）を添える。読めなくても明細そのものは出す。 */
  const orderById = new Map<string, Row>();
  let orderLookupFailed = false;
  const detailLines = [...openLines, ...payOffsetLines];
  if (detailLines.length > 0) {
    const ids = [...new Set(detailLines.map((l) => l.orderId))].filter((id) => /^\d+$/.test(id));
    if (ids.length > 0) {
      try {
        const orderRows = await select<Row>(
          `orders?select=id,ordered_on,customer_name,product_name,quantity,ship_status` +
            `&id=in.(${ids.join(",")})`,
        );
        for (const o of orderRows) orderById.set(s_(o, "id"), o);
      } catch {
        orderLookupFailed = true;
      }
    }
  }

  const nav = {
    month,
    sort: sort.column,
    dir: sortDir,
    status: selectedStatus,
    open: openCode,
  };

  /* --- 支払通知の下書き ---
     まだ支払っていないぶんがあればその金額で、すべて支払済ならその金額で作る。
     キャンセルの相殺（マイナス）は報酬額に混ぜず、「調整」として別の行に出す。
     混ぜてしまうと、代理店側で明細と突き合わせたときに金額が合わなくなるため。 */
  const draftUnpaid = openTotals.payable > 0;
  const draftAmount = draftUnpaid ? openTotals.payable : openTotals.paid;
  const draftCount = draftUnpaid
    ? openTotals.payableCount
    : openLines.filter((l) => l.status === "支払済").length;

  /* 相殺を差し引くかどうか。
     相殺の行は支払済にならず、いちど差し引いても同じ月に残り続けるので、
     「これから振り込むぶんの下書き」なのに、その月にもう振り込んだ日がある
     ときは、前回の振込ですでに差し引かれているとみて既定では引かない。
     （初回の振込＝まだ振り込んだ日が無いとき、および、その月ぜんぶを
     振り終えたあとの控えとして作るときは、これまでどおり1回だけ引く。）
     どちらも当てはまらない振り方をした月のために、本部が選び直せるようにもする。 */
  const offsetLikelySettled = draftUnpaid && openPaidDates.length > 0;
  const includeAdjustment =
    openOffsetTotal < 0 &&
    (adjChoice === "on" || (adjChoice === ALL && !offsetLikelySettled));

  /* 調整の中身。どの受注の相殺なのかを下書きにも書いておくと、
     代理店側でも、本部の控えとも突き合わせられる。 */
  const offsetDraftLines = openOffsetLines.map(
    (l) =>
      `　　　　　　・${offsetLabel(l, orderById.get(l.orderId) ?? null)}　${yen(l.amount)}`,
  );

  const draft = openCode
    ? [
        `${openAgency?.name || openCode} 御中`,
        "",
        `${jpMonthLabel(month)}分の報酬について、下記のとおりお知らせいたします。`,
        "",
        `対象月　　：${jpMonthLabel(month)}`,
        `件数　　　：${draftCount.toLocaleString("ja-JP")}件`,
        `報酬額　　：${yen(draftAmount)}`,
        ...(includeAdjustment
          ? [
              `調整　　　：${yen(openOffsetTotal)}（キャンセルにともなう相殺 ${openOffsetLines.length.toLocaleString("ja-JP")}件）`,
              ...offsetDraftLines,
              `お振込額　：${yen(draftAmount + openOffsetTotal)}`,
            ]
          : [`お振込額　：${yen(draftAmount)}`]),
        `振込先　　：${bankOneLine(openAgency)}`,
        `振込予定日：${lastDayLabel(shiftMonth(month, 1))}`,
        "",
        "内容にお心当たりのない点がございましたら、本部までご連絡ください。",
        "",
        "VIS 本部",
      ].join("\n")
    : "";

  return (
    <div className="space-y-6">
      {header}

      {notice ? <Notice tone={notice.tone}>{notice.body}</Notice> : null}

      {/* ── 支払いの確認 ── */}
      {payCode ? (
        <Card title={`${jpMonthLabel(month)}分の報酬を支払済にします`}>
          <div className="space-y-4 px-5 py-5">
            {payLines.length === 0 ? (
              <>
                <Notice tone="warn">
                  代理店コード {payCode} には、{jpMonthLabel(month)}分の報酬がありません。
                  月を選び直すか、一覧から選び直してください。
                </Notice>
                <Link href={linkTo({})} className={quietLink}>
                  一覧に戻る
                </Link>
              </>
            ) : payTotals.payable <= 0 ? (
              <>
                <Notice tone="warn">
                  {payName}（{payCode}）の{jpMonthLabel(month)}分には、いま支払済にできる報酬がありません。
                  {payTotals.pending > 0
                    ? `未確定の報酬が ${yen(payTotals.pending)} ありますが、これは配送が完了すると「確定」に変わり、そのあとで支払えるようになります。`
                    : "すでに支払済になっているか、支払いの対象にならない報酬（取消の相殺）だけが残っています。"}
                </Notice>
                <Link href={linkTo({})} className={quietLink}>
                  一覧に戻る
                </Link>
              </>
            ) : !payAgency ? (
              <>
                <Notice tone="bad">
                  代理店コード {payCode} は、代理店マスタに登録がありません。
                  お支払い先を確かめられないため、支払済にできません。
                  受注に入っている代理店コードが正しいか、代理店の登録が済んでいるかをご確認ください。
                </Notice>
                <Link href={linkTo({})} className={quietLink}>
                  一覧に戻る
                </Link>
              </>
            ) : !bankReady(payAgency) ? (
              <>
                <Notice tone="bad">
                  {payName}（{payCode}）は振込先が登録されていないため、支払済にできません。
                  どこに振り込んだのかを記録として残せないためです。
                  {missingBankFields(payAgency).join("・")}をご登録ください。
                </Notice>
                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    href={`/admin/agencies/${encodeURIComponent(payCode)}`}
                    className={rowBtn}
                  >
                    この代理店の登録内容を開く
                  </Link>
                  <Link href={linkTo({})} className={quietLink}>
                    一覧に戻る
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-ink-100">
                  <span className="font-semibold text-ink-50">
                    {payName}（{payCode}）
                  </span>
                  の {jpMonthLabel(month)}分{" "}
                  <span className="tabnum">{payTotals.payableCount.toLocaleString("ja-JP")}</span>件{" "}
                  <span className="tabnum font-semibold text-gold-300">{yen(payTotals.payable)}</span>{" "}
                  を支払済にします。よろしいですか？
                </p>

                <div className="rounded-lg border border-ink-800 bg-ink-950 px-4 py-3 text-sm leading-relaxed text-ink-200">
                  <div>
                    振込先：<span className="text-ink-100">{bankOneLine(payAgency)}</span>
                  </div>
                  {!payAgency?.accountType ? (
                    <div className="mt-1 text-xs text-warn-100">
                      預金の種類（普通・当座）が登録されていません。振込の前にご確認ください。
                    </div>
                  ) : null}
                  <div className="mt-1 text-xs text-ink-400">
                    支払日には今日の日付を記録します。振込そのものは、この画面では行いません。
                  </div>
                </div>

                {payTotals.offset < 0 ? (
                  <Notice tone="warn">
                    この代理店には、キャンセルにともなう相殺（マイナス）が{" "}
                    {payTotals.offsetCount.toLocaleString("ja-JP")}件・{yen(payTotals.offset)}{" "}
                    残っています。マイナスの行は支払済にしません（振り込む金額ではないため）。
                    まだ差し引いていなければ、実際に振り込む金額は、この相殺を差し引いた{" "}
                    <span className="tabnum">{yen(payTotals.payable + payTotals.offset)}</span>{" "}
                    になります。
                    <br />
                    <span className="font-semibold">
                      この画面では相殺は自動で消えません。二度差し引かないようご注意ください。
                    </span>
                    支払済にしたあとも、相殺の行は「確定（支払い待ち）」のまま同じ月に残ります。
                    下の内訳と、すでに振り込んだ日を、振込の控えと突き合わせてからお決めください。
                    <OffsetDetails
                      lines={payOffsetLines}
                      orders={orderById}
                      paidDates={payPaidDates}
                    />
                  </Notice>
                ) : null}

                {payTotals.pending > 0 ? (
                  <Notice tone="info">
                    未確定の報酬 {yen(payTotals.pending)} は、まだ配送が完了していないため対象に入れていません。
                    配送が完了すると「確定」に変わり、次回の支払いで対象になります。
                  </Notice>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <form action={payMonthAction}>
                    <NavFields {...nav} />
                    <input type="hidden" name="code" value={payCode} />
                    <button type="submit" className={primaryBtn}>
                      はい、支払済にする
                    </button>
                  </form>
                  <Link href={linkTo({})} className={quietLink}>
                    やめる
                  </Link>
                </div>
              </>
            )}
          </div>
        </Card>
      ) : null}

      {/* ── 絞り込み ── */}
      <Card>
        <FilterBar
          action={BASE}
          hidden={{
            sort: sort.column,
            dir: sortDir,
            open: openCode || undefined,
          }}
        >
          {/* 「すべて」に当たる選択肢は、報酬の締めでは意味を持たない
              （全期間の合計を振り込むことは無い）ので、今月に戻す入口にしている。 */}
          <FilterSelect
            name="month"
            label="対象月"
            value={month}
            options={monthOptions}
            allLabel="今月に戻す"
            showCount={false}
          />
          <FilterSelect
            name="status"
            label="報酬の状態"
            value={selectedStatus}
            options={statusOptions}
            allLabel={`すべて（${monthLines.length}）`}
            width="w-48"
          />
          <FilterText
            name="keyword"
            label="キーワード"
            value={keyword}
            placeholder="代理店コード・法人名"
          />
          <FilterActions clearHref={clearHref} filtered={isFiltered} />
        </FilterBar>
      </Card>

      {isFiltered ? (
        <FilterSummary
          total={monthLines.length}
          shown={shownLines.length}
          clearHref={clearHref}
          note={`${jpMonthLabel(month)}の報酬のうち。上の合計も、絞り込んだ分だけを数えています`}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="未確定合計"
          value={yen(totals.pending)}
          hint="配送の完了待ち。まだ支払えません"
        />
        <StatTile
          label="確定合計"
          value={yen(totals.confirmed)}
          hint="支払済の分を含む、確定した報酬の合計"
        />
        <StatTile
          label="支払済合計"
          value={yen(totals.paid)}
          hint={`${jpMonthLabel(month)}分として振込を記録した額`}
        />
        <StatTile
          label="支払い待ち"
          value={yen(totals.awaiting)}
          tone="gold"
          hint="確定 − 支払済。これから振り込む額です"
        />
      </div>

      {truncated ? (
        <Notice tone="warn">
          件数が多いため、{LIMIT.toLocaleString("ja-JP")} 件までを読み込んでいます。
          上の合計と代理店ごとの金額も、この {LIMIT.toLocaleString("ja-JP")} 件分だけを数えた額です。
          振込の金額を確かめるときは、報酬の状態で絞り込んでからご覧ください。
        </Notice>
      ) : null}

      {noBank.length > 0 ? (
        <Notice tone="bad">
          振込先が登録されていない代理店が {noBank.length} 社あります（支払い待ちの報酬があるもの）。
          振込の記録を残せないため、この {noBank.length} 社は支払済にできません。
          代理店管理の「内容を直す」で、金融機関名・支店名・口座番号・口座名義をご登録ください。
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {noBank.map((g) => (
              <Link
                key={g.code}
                href={`/admin/agencies/${encodeURIComponent(g.code)}`}
                className="tabnum text-xs underline underline-offset-4 hover:text-bad-100"
              >
                {g.code}
                {g.name ? `　${g.name}` : ""}
              </Link>
            ))}
          </div>
        </Notice>
      ) : noBankOther.length > 0 ? (
        <Notice tone="warn">
          振込先が登録されていない代理店が {noBankOther.length} 社あります。
          いまは支払い待ちの報酬がないため支障はありませんが、報酬が確定する前にご登録ください。
        </Notice>
      ) : null}

      {totals.offset < 0 ? (
        <Notice tone="warn">
          キャンセルにともなう相殺（マイナスの報酬）が {totals.offsetCount.toLocaleString("ja-JP")}件・
          {yen(totals.offset)} 残っています。マイナスの行は支払済にしません（振り込む金額ではないため）。
          まだ差し引いていなければ、実際にお振り込みになるときに、この相殺のぶんを差し引いてください。
          <br />
          <span className="font-semibold">
            この画面では相殺は自動で消えません。二度差し引かないようご注意ください。
          </span>
          いちど差し引いても、その行は「確定（支払い待ち）」のまま同じ月に残り続けます。
          同じ月に2回以上お振り込みになるときは、代理店の「明細を見る」を開いて、
          相殺の対象になった受注と、すでに振り込んだ日をお確かめください。
        </Notice>
      ) : null}

      {/* ── 代理店ごとのまとめ ── */}
      <Card
        title={`代理店ごとの報酬（${jpMonthLabel(month)}）`}
        action={
          <span className="text-xs text-ink-400">
            {rows.length.toLocaleString("ja-JP")} 社・見出しを押すと並び替えられます
          </span>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title={
              monthLines.length === 0
                ? "この月の報酬はまだありません"
                : "条件に合うものがありません"
            }
            description={
              monthLines.length === 0
                ? "報酬は、受注が入った時点で「未確定」として立ち、商品の配送が完了すると「確定」に変わります。前の月を見るときは、右上の「← 前の月」をお使いください。"
                : `${jpMonthLabel(month)}には、${[
                    selectedStatus === ALL ? null : `状態「${selectedStatus}」`,
                    keyword ? `キーワード「${keyword}」` : null,
                  ]
                    .filter(Boolean)
                    .join("・")}に当てはまる報酬がありません。条件を変えてお試しください。`
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh column="code" label="代理店コード" sort={sort} basePath={BASE} params={cleanParams} />
                <SortableTh column="name" label="法人名" sort={sort} basePath={BASE} params={cleanParams} />
                <SortableTh column="rank" label="ランク" sort={sort} basePath={BASE} params={cleanParams} />
                <SortableTh column="count" label="件数" sort={sort} basePath={BASE} params={cleanParams} align="right" />
                <SortableTh column="pending" label="未確定" sort={sort} basePath={BASE} params={cleanParams} align="right" />
                <SortableTh column="confirmed" label="確定" sort={sort} basePath={BASE} params={cleanParams} align="right" />
                <SortableTh column="paid" label="支払済" sort={sort} basePath={BASE} params={cleanParams} align="right" />
                <SortableTh column="await" label="支払い待ち" sort={sort} basePath={BASE} params={cleanParams} align="right" />
                <Th align="right">取消</Th>
                <SortableTh column="bank" label="振込先" sort={sort} basePath={BASE} params={cleanParams} />
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const isOpen = g.code === openCode;
                const canPay = g.bankOk && g.all.payable > 0;
                return (
                  <Fragment key={g.code || "(コードなし)"}>
                    <tr className={cn(!g.bankOk && g.all.payable > 0 && "bg-warn-500/10")}>
                      <Td numeric className="whitespace-nowrap font-medium text-ink-100">
                        {g.code || <Badge tone="warn">コードなし</Badge>}
                      </Td>
                      <Td>
                        {g.name ? (
                          <Link
                            href={`/admin/agencies/${encodeURIComponent(g.code)}`}
                            className="underline underline-offset-4 hover:text-gold-300"
                          >
                            {g.name}
                          </Link>
                        ) : (
                          <span className="text-ink-400">代理店マスタに該当なし</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {rankShort(g.rank, g.agency?.codeKind)}
                      </Td>
                      <Td numeric align="right">
                        {g.shown.count.toLocaleString("ja-JP")}
                      </Td>
                      <Td numeric align="right" className="whitespace-nowrap text-ink-300">
                        {g.shown.pending === 0 ? "—" : yen(g.shown.pending)}
                      </Td>
                      <Td numeric align="right" className="whitespace-nowrap">
                        {g.shown.confirmed === 0 ? "—" : yen(g.shown.confirmed)}
                      </Td>
                      <Td numeric align="right" className="whitespace-nowrap text-ink-300">
                        {g.shown.paid === 0 ? "—" : yen(g.shown.paid)}
                      </Td>
                      <Td
                        numeric
                        align="right"
                        className={cn(
                          "whitespace-nowrap font-semibold",
                          g.shown.awaiting > 0 ? "text-gold-300" : "text-ink-400",
                        )}
                      >
                        {g.shown.awaiting === 0 ? "—" : yen(g.shown.awaiting)}
                      </Td>
                      <Td numeric align="right" className="whitespace-nowrap text-bad-100">
                        {g.shown.cancelledCount > 0 || g.shown.offsetCount > 0 ? (
                          <>
                            {g.shown.cancelledCount > 0 ? (
                              <div>{g.shown.cancelledCount.toLocaleString("ja-JP")} 件</div>
                            ) : null}
                            {g.shown.offset < 0 ? (
                              <div className="text-xs text-warn-100">
                                相殺 {yen(g.shown.offset)}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </Td>
                      <Td>
                        <BankCell agency={g.agency} />
                      </Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1.5">
                          {/* 開く代理店を変えたら、下書きの調整の選び直し（adj）は
                              引き継がない。別の代理店にそのまま効かないようにするため。 */}
                          <Link
                            href={linkTo({ open: isOpen ? "" : g.code, adj: "" })}
                            className={rowBtn}
                          >
                            {isOpen ? "明細を閉じる" : "明細を見る"}
                          </Link>
                          {canPay ? (
                            <Link href={linkTo({ pay: g.code })} className={rowBtn}>
                              確定分を支払済にする
                            </Link>
                          ) : g.all.payable > 0 ? (
                            <span className="text-xs leading-relaxed text-warn-100">
                              振込先が未登録のため
                              <br />
                              支払えません
                            </span>
                          ) : (
                            <span className="text-xs text-ink-500">支払える報酬なし</span>
                          )}
                        </div>
                      </Td>
                    </tr>

                    {isOpen ? (
                      <tr>
                        <td
                          colSpan={COLUMN_COUNT}
                          className="border-b border-ink-850 bg-ink-950/70 px-4 py-4"
                        >
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-300">
                            <span className="text-sm font-medium text-ink-100">
                              {g.code}
                              {g.name ? `　${g.name}` : ""} の明細（{jpMonthLabel(month)}・
                              {openLines.length.toLocaleString("ja-JP")}件）
                            </span>
                            <span>
                              ランク：{rankLabel(g.rank, g.agency?.codeKind)}
                            </span>
                            {isFiltered ? (
                              <span>
                                明細は絞り込みに関係なく、この月のぶんをすべて出しています
                              </span>
                            ) : null}
                            {orderLookupFailed ? (
                              <span className="text-warn-100">
                                受注の情報を読み込めませんでした（金額と状態はそのまま表示しています）
                              </span>
                            ) : null}
                          </div>

                          {openLines.length === 0 ? (
                            <p className="text-sm text-ink-400">
                              この月の明細はありません。
                            </p>
                          ) : (
                            <Table>
                              <thead>
                                <tr>
                                  <Th>受注日</Th>
                                  <Th>注文者</Th>
                                  <Th>商品</Th>
                                  <Th>種別</Th>
                                  <Th align="right">金額</Th>
                                  <Th>状態</Th>
                                  <Th>確定日</Th>
                                  <Th>支払日</Th>
                                  <Th>操作</Th>
                                </tr>
                              </thead>
                              <tbody>
                                {openLines.map((l) => {
                                  const order = orderById.get(l.orderId) ?? null;
                                  const negative = l.amount < 0;
                                  return (
                                    <tr
                                      key={l.id}
                                      className={cn(
                                        l.status === "取消" && "bg-bad-500/10",
                                        negative && "bg-warn-500/10",
                                      )}
                                    >
                                      <Td numeric className="whitespace-nowrap">
                                        {order ? jpDate(s_(order, "ordered_on")) : "—"}
                                      </Td>
                                      <Td>
                                        {order ? (
                                          <Link
                                            href={`/admin/orders/${encodeURIComponent(l.orderId)}`}
                                            className="underline underline-offset-4 hover:text-gold-300"
                                          >
                                            {s_(order, "customer_name") || "（お名前なし）"}
                                          </Link>
                                        ) : (
                                          <span className="text-ink-400">—</span>
                                        )}
                                      </Td>
                                      <Td>{order ? s_(order, "product_name") || "—" : "—"}</Td>
                                      <Td className="whitespace-nowrap">{l.kind || "—"}</Td>
                                      <Td
                                        numeric
                                        align="right"
                                        className={cn(
                                          "whitespace-nowrap",
                                          negative && "text-warn-100",
                                          l.status === "取消" && "text-ink-500 line-through",
                                        )}
                                      >
                                        {yen(l.amount)}
                                      </Td>
                                      <Td>
                                        <StatusBadge status={l.status} />
                                        {l.cancelReason ? (
                                          <div className="mt-1 text-xs text-ink-400">
                                            {l.cancelReason}
                                          </div>
                                        ) : null}
                                      </Td>
                                      <Td numeric className="whitespace-nowrap">
                                        {l.confirmedOn ? jpDate(l.confirmedOn) : "—"}
                                      </Td>
                                      <Td numeric className="whitespace-nowrap">
                                        {l.paidOn ? jpDate(l.paidOn) : "—"}
                                      </Td>
                                      <Td>
                                        {l.status === "確定" && !negative ? (
                                          g.bankOk ? (
                                            <form action={payOneAction}>
                                              <NavFields {...nav} />
                                              <input type="hidden" name="rewardId" value={l.id} />
                                              <button type="submit" className={rowBtn}>
                                                支払済にする
                                              </button>
                                            </form>
                                          ) : (
                                            <span className="text-xs text-warn-100">
                                              振込先が未登録
                                            </span>
                                          )
                                        ) : l.status === "支払済" ? (
                                          <form action={undoPayAction}>
                                            <NavFields {...nav} />
                                            <input type="hidden" name="rewardId" value={l.id} />
                                            <button type="submit" className={rowBtn}>
                                              支払済を取り消す
                                            </button>
                                          </form>
                                        ) : l.status === "未確定" ? (
                                          <span className="text-xs leading-relaxed text-ink-400">
                                            配送が完了すると
                                            <br />
                                            確定します
                                          </span>
                                        ) : negative ? (
                                          <span className="text-xs leading-relaxed text-ink-400">
                                            相殺のため
                                            <br />
                                            支払いません
                                          </span>
                                        ) : (
                                          <span className="text-xs text-ink-500">—</span>
                                        )}
                                      </Td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </Table>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td className="whitespace-nowrap text-xs text-ink-400">
                  {rows.length.toLocaleString("ja-JP")} 社
                </Td>
                <Td>{null}</Td>
                <Td numeric align="right" className="font-semibold text-ink-100">
                  {totals.count.toLocaleString("ja-JP")}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap font-semibold text-ink-300">
                  {yen(totals.pending)}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap font-semibold text-ink-100">
                  {yen(totals.confirmed)}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap font-semibold text-ink-300">
                  {yen(totals.paid)}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap font-semibold text-gold-400">
                  {yen(totals.awaiting)}
                </Td>
                <Td numeric align="right" className="whitespace-nowrap text-xs text-bad-100">
                  {totals.cancelledCount > 0
                    ? `${totals.cancelledCount.toLocaleString("ja-JP")} 件`
                    : null}
                </Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {/* ── 支払通知の下書き ──
          明細が1件も無い月では出さない（0円の通知を作っても意味がないため）。 */}
      {openCode && openLines.length > 0 ? (
        <Card
          title={`支払通知の下書き（${openAgency?.name || openCode}）`}
          action={
            <Link href={linkTo({ open: "", adj: "" })} className={quietLink}>
              閉じる
            </Link>
          }
        >
          <div className="space-y-3 px-5 py-5">
            <p className="text-sm leading-relaxed text-ink-300">
              下の文面を選んでコピーし、メールにお使いください（文字をクリックすると全体が選ばれます）。
              この画面からメールは送りません。金額は、必ず振込の控えと突き合わせてからお送りください。
            </p>
            {!bankReady(openAgency) ? (
              <Notice tone="bad">
                振込先が登録されていないため、下書きの振込先が空欄になっています。
                {missingBankFields(openAgency).join("・")}をご登録のうえ、開き直してください。
              </Notice>
            ) : null}
            {openTotals.payable > 0 ? (
              <Notice tone="info">
                下書きの金額は「支払い待ち（これから振り込む額）」で作っています。
                支払済にしたあとは、支払済の金額で作り直されます。
              </Notice>
            ) : null}

            {/* 相殺は消し込めないので、下書きの調整行は「入れるかどうか」を
                本部が決められるようにし、判断の材料をその場に出す。 */}
            {openOffsetLines.length > 0 ? (
              <Notice tone="warn">
                <span className="font-semibold">
                  この画面では相殺は自動で消えません。二度差し引かないようご注意ください。
                </span>
                <br />
                キャンセルにともなう相殺が {openOffsetLines.length.toLocaleString("ja-JP")}件・
                {yen(openOffsetTotal)} あります。この行は支払済にならないため、前回の振込で
                差し引いていても、同じ月にそのまま残り続けます。
                {adjChoice !== ALL
                  ? "下書きの調整は、いまこの画面で選んだとおりにしています。"
                  : offsetLikelySettled
                    ? "この月にはすでに振込の記録があるので、相殺は前回の振込で差し引き済みとみて、下書きからは外してあります。"
                    : "この月にはまだ振込の記録がないので、相殺を差し引いた金額で下書きを作っています。"}
                <OffsetDetails
                  lines={openOffsetLines}
                  orders={orderById}
                  paidDates={openPaidDates}
                />
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-xs">
                    いまの下書き：
                    {includeAdjustment
                      ? `調整として ${yen(openOffsetTotal)} を差し引いています`
                      : "相殺を差し引いていません"}
                  </span>
                  <Link
                    href={linkTo({ adj: includeAdjustment ? "off" : "on" })}
                    className={quietLink}
                  >
                    {includeAdjustment
                      ? "差し引かない下書きにする"
                      : "差し引く下書きにする"}
                  </Link>
                </div>
              </Notice>
            ) : null}

            <div className="scroll-x rounded-lg border border-ink-700 bg-ink-950 px-4 py-3">
              <pre className="select-all whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-100">
                {draft}
              </pre>
            </div>
            <p className="text-xs leading-relaxed text-ink-500">
              振込予定日は「対象月の翌月末」で入れてあります。実際の予定日が違う場合は、
              コピーしたあとに書き換えてください。
            </p>
          </div>
        </Card>
      ) : null}

      <Notice tone="info">
        未確定は、受注は入ったものの、まだ配送が完了していない報酬です。配送が完了すると「確定」に変わり、
        支払いの対象になります。未確定のまま支払済にすることはできません（配送前にお支払いしないためです）。
        確定は、支払済のぶんも含めた「確定した報酬の合計」で、支払い待ちはそのうちまだ振り込んでいない額です。
        受注がキャンセルになった報酬は「取消」になり、同額のマイナスが相殺として立ちます。
        マイナスの行は支払済にせず、次回の振込額から差し引いてください。
        ただし、差し引いてもこの画面では相殺は自動で消えず、「確定（支払い待ち）」のまま
        同じ月に残り続けます。同じ月に2回以上お振り込みになるときは、二度差し引かないよう
        ご注意ください。すべての操作は記録に残しています。
      </Notice>
    </div>
  );
}
