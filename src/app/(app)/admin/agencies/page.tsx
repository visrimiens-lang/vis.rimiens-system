import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer, listCodesWithPassword } from "@/lib/auth";
import { DEFAULT_SLOT_LIMIT, countsTowardSlot, listAllAgencies } from "@/lib/agencies";
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
  cn,
  jpDate,
} from "@/components/ui";
import { AgencySearch } from "./AgencySearch";
import { IssuePassword } from "./IssuePassword";
import { ResetRequests } from "./ResetRequests";

type Tab = "agency" | "partner" | "staff";

const TABS: { key: Tab; label: string; codeKind: string }[] = [
  { key: "agency", label: "代理店", codeKind: "00" },
  { key: "partner", label: "取次パートナー", codeKind: "01" },
  { key: "staff", label: "スタッフ", codeKind: "02" },
];

function toTab(v: string | undefined): Tab {
  return v === "partner" || v === "staff" ? v : "agency";
}

function hrefFor(tab: Tab, keyword: string): string {
  const params = new URLSearchParams();
  if (tab !== "agency") params.set("tab", tab);
  if (keyword) params.set("keyword", keyword);
  const qs = params.toString();
  return qs ? `/admin/agencies?${qs}` : "/admin/agencies";
}

export default async function AdminAgenciesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; keyword?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params = await searchParams;
  const tab = toTab(params.tab);
  const keyword = (params.keyword ?? "").trim();

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
      description="代理店マスタに登録されている取引先の一覧です。コード区分ごとにタブが分かれています。"
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

  const kw = keyword.toLowerCase();
  const matches = (a: Agency) =>
    !kw ||
    a.code.toLowerCase().includes(kw) ||
    a.name.toLowerCase().includes(kw);

  const filtered: Record<Tab, Agency[]> = {
    agency: agencies.filter(matches),
    partner: partners.filter(matches),
    staff: staff.filter(matches),
  };
  const rows = filtered[tab];

  // ログイン情報を発行できる相手（解約済みは除く）
  const withPassword = await listCodesWithPassword();
  const loginTargets = all
    .filter((a) => a.status !== "停止・解約" && a.code)
    .map((a) => ({
      code: a.code,
      name: a.name || "（名称未登録）",
      hasPassword: withPassword.has(a.code),
    }));
  const current = TABS.find((t) => t.key === tab)!;

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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex items-center gap-1 rounded-xl border border-ink-800 bg-ink-900/70 p-1">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={hrefFor(t.key, keyword)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition",
                  active
                    ? "bg-gold-500/12 text-gold-300"
                    : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
                )}
              >
                <span>{t.label}</span>
                <span
                  className={cn(
                    "tabnum text-xs",
                    active ? "text-gold-400" : "text-ink-400",
                  )}
                >
                  {filtered[t.key].length}
                </span>
              </Link>
            );
          })}
        </nav>

        <AgencySearch key={`${tab}:${keyword}`} tab={tab} keyword={keyword} />
      </div>

      {keyword ? (
        <p className="text-sm text-ink-300">
          「{keyword}」で絞り込み中。3つのタブそれぞれの該当件数をタブの数字に出しています。
          <Link
            href={hrefFor(tab, "")}
            className="ml-1.5 underline underline-offset-2 hover:text-gold-300"
          >
            絞り込みを解除
          </Link>
        </p>
      ) : null}

      <Card title={`${current.label}　${rows.length} 件`}>
        {rows.length === 0 ? (
          <EmptyState
            title={emptyTitle(tab, keyword)}
            description={emptyDescription(tab, keyword)}
          />
        ) : tab === "agency" ? (
          <AgencyTable rows={rows} usedByParent={usedByParent} />
        ) : (
          <PeopleTable rows={rows} />
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
}: {
  rows: Agency[];
  usedByParent: Map<string, number>;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>代理店コード</Th>
          <Th>法人名</Th>
          <Th>ランク</Th>
          <Th>エリア</Th>
          <Th>上位代理店</Th>
          <Th align="right">枠</Th>
          <Th>稼働ステータス</Th>
          <Th>登録日</Th>
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

function PeopleTable({ rows }: { rows: Agency[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>コード</Th>
          <Th>氏名</Th>
          <Th>販路種別</Th>
          <Th>上位代理店</Th>
          <Th>メールアドレス</Th>
          <Th>稼働ステータス</Th>
          <Th>登録日</Th>
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

function emptyTitle(tab: Tab, keyword: string): string {
  if (keyword) return `「${keyword}」に一致する登録はありません`;
  if (tab === "agency") return "代理店がまだ登録されていません";
  if (tab === "partner") return "取次パートナーがまだ登録されていません";
  return "スタッフがまだ登録されていません";
}

function emptyDescription(tab: Tab, keyword: string): string {
  if (keyword) {
    return "法人名の一部か、代理店コードの一部で探せます。別のタブに入っている可能性もあるので、タブの数字も確認してください。";
  }
  if (tab === "agency") {
    return "代理店の申込が承認され、代理店マスタにコード区分 00 で登録されると、ここに自動で表示されます。";
  }
  if (tab === "partner") {
    return "取次パートナー（コード区分 01）は、代理店が発行した紹介用QRから申し込まれると、ここに自動で表示されます。枠は消費しません。";
  }
  return "スタッフ（コード区分 02）は、代理店が自社の担当者を登録すると、ここに自動で表示されます。枠は消費しません。";
}
