import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import {
  buildOrgTree,
  countsTowardSlot,
  findAgencyByCode,
  getSlotSummary,
  listDirectChildren,
  type SlotSummary,
} from "@/lib/agencies";
import {
  areaUsage,
  breakdownSlots,
  slotModelOf,
  type AreaUsage,
  type SlotBreakdown as Breakdown,
} from "@/lib/slots";
import { listAllAgencies } from "@/lib/agencies";
import { SlotBreakdown } from "@/components/SlotBreakdown";
import type { Agency, OrgNode } from "@/lib/types";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatusBadge,
  Table,
  Td,
  Th,
  cn,
} from "@/components/ui";
import {
  buildListHref,
  matchesKeyword,
  parseSort,
  readParam,
  sortRows,
  type Accessors,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import {
  FilterActions,
  FilterBar,
  FilterSummary,
  FilterText,
  SortableTh,
} from "@/components/SortableTh";
import { agencyTypeOf, belongsToOrg, codeKindLabel, statusTone } from "@/lib/labels";
import { SlotRequestButton } from "./SlotRequestButton";
import { PayUnitCell } from "@/components/PayUnitCell";
import { StaffProfileCell } from "@/components/StaffProfileCell";
import { defaultPayUnit } from "@/lib/pay-defaults";

const BASE = "/organization";

/** 見出しを押して並び替えられる列。 */
const SORT_COLUMNS = ["code", "name", "rank", "status", "email", "phone", "parent"];

/** 既定はコードの若い順（組織図と同じ並び）。 */
const DEFAULT_SORT: SortState = { column: "", desc: false };

/* ---------- 組織図を「行＋深さ」に平らにする ---------- */

type Row = { agency: Agency; depth: number };

function flatten(node: OrgNode, depth = 0, out: Row[] = []): Row[] {
  out.push({ agency: node.agency, depth });
  for (const child of node.children) flatten(child, depth + 1, out);
  return out;
}

/* ---------- 枠の状態メッセージ ---------- */

function SlotStateNotice({ slots }: { slots: SlotSummary }) {
  if (slots.requestStatus === "申請中") {
    return (
      <Notice tone="warn">
        増枠のご申請をお預かりしています。<strong className="font-semibold">本部が確認中です。</strong>
        結果が出るまで、もうしばらくお待ちください。
      </Notice>
    );
  }
  if (slots.requestStatus === "承認済") {
    return (
      <Notice tone="info">
        増枠が承認されています。
        {slots.limit > 0
          ? `上限は ${slots.limit} 名に設定済みです。`
          : "上限は設けていません（特別枠）。"}
        空き枠にそのまま登録を進められます。
      </Notice>
    );
  }
  if (slots.requestStatus === "却下") {
    return (
      <Notice tone="bad">
        前回の増枠のご依頼は見送りとなりました。理由と、再度お申し込みできる条件については本部にお問い合わせください。
      </Notice>
    );
  }
  if (slots.isOver) {
    return (
      <Notice tone="warn">
        枠がすべて埋まっています。新しく{codeKindLabel("00")}（コード区分00）を登録するには、増枠のお申し込みが必要です。
      </Notice>
    );
  }
  return null;
}

/* ---------- 画面本体 ---------- */

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const keyword = readParam(params, "q");
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  const header = (
    <PageHeader
      title="組織と枠"
      description="配下の並びと、枠の空き状況をまとめています。枠はスタッフ100名です。配下の連絡先（メールアドレス・電話番号）もこの画面で確認でき、所属会社と種別はこの画面で設定します。"
    />
  );

  let me: Agency | null = null;
  let slots: SlotSummary | null = null;
  let breakdown: Breakdown | null = null;
  let areaRows: AreaUsage[] | null = null;
  let areaTotal: { limit: number; used: number; remaining: number } | null = null;
  let tree: OrgNode | null = null;
  let loadError = "";

  try {
    me = await findAgencyByCode(viewer.code);
    if (me) {
      const [s1, t1, direct] = await Promise.all([
        getSlotSummary(me),
        buildOrgTree(me.code),
        listDirectChildren(me.code),
      ]);
      slots = s1;
      tree = t1;
      const model = slotModelOf(me);
      if (model === "area") {
        // 総販売代理店の配下は統括代理店。全国60社のエリア枠で見る。
        const usage = areaUsage(await listAllAgencies());
        areaRows = usage.rows;
        areaTotal = usage.total;
      } else if (model === "staff") {
        breakdown = breakdownSlots(me, direct);
      }
      // model === "none"（取次パートナー・スタッフ）は配下を持たないため枠を出さない
    }
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "代理店情報の読み込みに失敗しました。時間をおいてもう一度お試しください。";
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          代理店情報を読み込めませんでした。{loadError}
          <br />
          しばらく待っても表示されない場合は、本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  if (!me || !slots) {
    return (
      <div className="space-y-6">
        {header}
        <Notice tone="bad">
          代理店コード「{viewer.code}」の登録が見つかりませんでした。本部にお問い合わせください。
        </Notice>
      </div>
    );
  }

  const rows = tree ? flatten(tree) : [{ agency: me, depth: 0 }];
  const descendants = rows.slice(1).map((r) => r.agency);
  const directChildren = tree ? tree.children.map((c) => c.agency) : [];

  const countBy = (list: Agency[], kind: string) =>
    list.filter((a) => (a.codeKind || "") === kind).length;

  // 区分の呼び方は labels.ts の codeKindLabel() だけを出所にする。
  // ここで文字を直書きすると、同じ区分が画面ごとに違う呼ばれ方になる。
  // とくに 00 は総販売代理店・統括代理店・サロン代理店・個人販売パートナーまで
  // まとめて入る区分なので、「販売代理店」と書くと配下の統括代理店まで
  // 販売代理店として数えているように見えてしまう。
  const kindRows = [
    { kind: "00", note: "（コード区分00）", slot: "1名分消費" },
    { kind: "01", note: "", slot: "1名分消費" },
    { kind: "02", note: "", slot: "1名分消費" },
    { kind: "", note: "", slot: "—" },
  ]
    .map((b) => ({
      ...b,
      label: `${codeKindLabel(b.kind)}${b.note}`,
      direct: countBy(directChildren, b.kind),
      all: countBy(descendants, b.kind),
    }))
    .filter((b) => b.kind !== "" || b.all > 0);

  const suspendedDirect = directChildren.filter((a) => a.status === "停止・解約").length;

  /* --- 配下の一覧（連絡先つき） --- */
  const contacts = descendants.filter((a) =>
    matchesKeyword(keyword, [a.code, a.name, a.representative, a.email, a.phone]),
  );

  const accessors: Accessors<Agency> = {
    code: (a) => a.code,
    name: (a) => a.name,
    rank: (a) => agencyTypeOf(a.rank, a.channel, a.codeKind, a.staffType),
    status: (a) => a.status,
    email: (a) => a.email,
    phone: (a) => a.phone,
    parent: (a) => a.parentCode,
  };
  const contactRows = sortRows(contacts, sort.column, sort.desc, accessors);

  const isFiltered = keyword !== "";
  const clearHref = buildListHref(BASE, params, { q: "" });
  const missingContact = descendants.filter((a) => !a.email && !a.phone).length;

  return (
    <div className="space-y-6">
      {header}

      {/* 枠。取次パートナーとスタッフは配下を持たないので出さない */}
      {breakdown || areaRows ? (
      <Card
        title={areaRows ? "エリア枠（統括代理店）" : "配下の枠"}
        action={
          me.specialSlot ? <Badge tone="gold">特別枠</Badge> : <Badge>通常枠</Badge>
        }
      >
        {breakdown ? <SlotBreakdown data={breakdown} /> : null}

        {areaRows && areaTotal ? (
          <div className="px-5 py-4">
            <div className="border-b border-ink-800 pb-4">
              <div className="tabnum text-3xl font-semibold tracking-tight text-ink-50">
                {areaTotal.used}
                <span className="text-lg text-ink-500"> / {areaTotal.limit}</span>
              </div>
              <div className="mt-1 text-sm leading-relaxed text-ink-300">
                配下は統括代理店なので、枠はエリアごとに決まっています。全国で {areaTotal.limit} 社までです。
              </div>
            </div>
            <div className="divide-y divide-ink-850">
              {areaRows.map((r) => (
                <div key={r.area} className="flex items-center justify-between gap-4 py-3">
                  <span className="text-sm text-ink-100">{r.area}</span>
                  <span className="tabnum text-sm text-ink-300">
                    <span
                      className={cn(
                        "text-base font-semibold",
                        r.isFull ? "text-warn-500" : r.used > 0 ? "text-gold-400" : "text-ink-200",
                      )}
                    >
                      {r.used}
                    </span>
                    <span className="text-ink-500"> / {r.limit}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-4 border-t border-ink-800 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm leading-relaxed text-ink-300">
              いずれかの枠が埋まった場合は、本部に増枠を申請できます。
            </p>
            <SlotRequestButton alreadyRequested={slots.requestStatus === "申請中"} />
          </div>
          <SlotStateNotice slots={slots} />
        </div>
      </Card>
      ) : null}

      {/* 組織図 */}
      <Card title="組織図">
        {rows.length <= 1 ? (
          <EmptyState
            title="まだ配下の登録がありません。"
            description="あなたの紹介URL（QR1）から代理店の登録申請が届き、本部で承認されると、ここに組織図が表示されます。"
          />
        ) : (
          <ul className="px-5 py-4">
            {rows.map(({ agency, depth }) => {
              // 枠を使うのは自分の直下だけ（その下の配下は上位の枠を使う）
              const consumes = agency.parentCode === me.code && countsTowardSlot(agency);
              const isSelf = agency.code === me.code;
              // 階層と区分が同じ呼び方になる相手（取次パートナー・スタッフ）は、
              // 同じ言葉を2つ並べない。
              const rankText = agencyTypeOf(
                agency.rank,
                agency.channel,
                agency.codeKind,
                agency.staffType,
              );
              const kindText = codeKindLabel(agency.codeKind);
              return (
                <li
                  key={agency.code || agency.recordId}
                  style={{ marginLeft: Math.min(depth, 6) * 20 }}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-2 py-2 pl-3",
                    consumes ? "border-gold-500/70" : "border-ink-800",
                  )}
                >
                  <span
                    className={cn(
                      "text-sm",
                      consumes ? "font-medium text-ink-50" : "text-ink-300",
                    )}
                  >
                    {agency.name || "（名称未登録）"}
                  </span>
                  <span className="tabnum text-xs text-ink-400">
                    {agency.code || "—"}
                  </span>
                  {isSelf ? <Badge tone="gold">あなた</Badge> : null}
                  {agency.rank ? (
                    <Badge tone={agency.rank === "総販売代理店" ? "gold" : "neutral"}>
                      {rankText}
                    </Badge>
                  ) : null}
                  <StatusBadge status={agency.status} />
                  {kindText !== rankText ? (
                    <span className="text-xs text-ink-400">{kindText}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-800 px-5 py-3 text-xs text-ink-400">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-0.5 shrink-0 bg-gold-500/70" />
            自分の直下（1名ぶん枠を使います）
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-0.5 shrink-0 bg-ink-800" />
            その下の配下・停止解約（枠には数えません）
          </span>
        </div>
      </Card>

      {/* 配下の一覧（連絡先） */}
      <Card title={`配下の一覧　${contactRows.length} 社`}>
        {descendants.length === 0 ? (
          <EmptyState
            title="まだ配下の登録がありません。"
            description="配下が登録されると、連絡先（メールアドレス・電話番号）をここで確認できます。"
          />
        ) : (
          <>
            <FilterBar
              action={BASE}
              hidden={{
                sort: sort.column,
                dir: sort.column ? (sort.desc ? "desc" : "asc") : "",
              }}
            >
              <FilterText
                name="q"
                label="名前・コード・連絡先"
                value={keyword}
                placeholder="例：山田／RIM0003／090"
                width="w-72"
              />
              <FilterActions clearHref={clearHref} filtered={isFiltered} />
            </FilterBar>

            {isFiltered ? (
              <div className="border-t border-ink-800 px-5 py-3">
                <FilterSummary
                  total={descendants.length}
                  shown={contactRows.length}
                  unit="社"
                  clearHref={clearHref}
                />
              </div>
            ) : null}

            {contactRows.length === 0 ? (
              <EmptyState
                title="条件に合う配下がありません"
                description="名前・代理店コード・メールアドレス・電話番号の一部で探せます。条件を外すと配下すべてが表示されます。"
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <SortableTh
                      column="code"
                      label="代理店コード"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <Th>スタッフコード</Th>
                    <SortableTh
                      column="name"
                      label="名前"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <SortableTh
                      column="rank"
                      label="代理店種別"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <SortableTh
                      column="status"
                      label="稼働状況"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <SortableTh
                      column="email"
                      label="メールアドレス"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <SortableTh
                      column="phone"
                      label="電話番号"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <SortableTh
                      column="parent"
                      label="所属先"
                      sort={sort}
                      basePath={BASE}
                      params={params}
                    />
                    <Th>所属会社・種別</Th>
                    <Th>支払額（1台・税抜）</Th>
                  </tr>
                </thead>
                <tbody>
                  {contactRows.map((a) => (
                    <tr key={a.code || a.recordId}>
                      {/*
                        スタッフ・取次パートナーは、会社の下に採番された人。
                        「スタッフコード SASA0001 ／ 代理店コード SASA」と分けて出す。
                        個人販売代理店は自分自身が代理店なので、分けない
                        （KVIS0002 が、その方の代理店コードそのもの）。
                      */}
                      <Td numeric>
                        {belongsToOrg(a.codeKind)
                          ? a.orgCode || a.parentCode || "—"
                          : a.code || "—"}
                      </Td>
                      <Td numeric>{belongsToOrg(a.codeKind) ? a.code || "—" : "—"}</Td>
                      <Td className="whitespace-nowrap">
                        <div className="text-ink-100">{a.name || "（名称未登録）"}</div>
                        {a.representative && a.representative !== a.name ? (
                          <div className="mt-1 text-xs text-ink-400">
                            ご担当：{a.representative}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {/* 申込フォームと同じ呼び方で出す（「取次」ではなく「販売代理店」） */}
                        <Badge tone={a.rank === "総販売代理店" ? "gold" : "neutral"}>
                          {agencyTypeOf(a.rank, a.channel, a.codeKind, a.staffType)}
                        </Badge>
                      </Td>
                      <Td>
                        <Badge tone={statusTone(a.status)}>{a.status || "未設定"}</Badge>
                      </Td>
                      <Td>
                        {a.email ? (
                          <a
                            href={`mailto:${a.email}`}
                            className="break-all text-gold-300 underline underline-offset-2 transition hover:text-gold-100"
                          >
                            {a.email}
                          </a>
                        ) : (
                          <span className="text-ink-500">未登録</span>
                        )}
                      </Td>
                      <Td numeric>
                        {a.phone ? (
                          <a
                            href={`tel:${a.phone.replace(/[^0-9+]/g, "")}`}
                            className="whitespace-nowrap text-gold-300 underline underline-offset-2 transition hover:text-gold-100"
                          >
                            {a.phone}
                          </a>
                        ) : (
                          <span className="text-ink-500">未登録</span>
                        )}
                      </Td>
                      <Td numeric>
                        {a.parentCode === me.code ? (
                          <Badge>自分の直下</Badge>
                        ) : (
                          <span className="text-ink-300">{a.parentCode || "—"}</span>
                        )}
                      </Td>
                      {/*
                        スタッフの「どこの会社の人か」「販売代理店かサロンか個人か」は、
                        申込フォームからは送られてこない（2026-08-22〜）。
                        自分の直下のスタッフについては、ここで直接設定できるようにする。
                      */}
                      <Td>
                        {a.codeKind === "02" ? (
                          <StaffProfileCell
                            code={a.code}
                            name={a.name || a.code}
                            companyName={a.companyName}
                            staffType={a.staffType}
                            fallbackName={a.parentName}
                            editable={a.parentCode === me.code}
                          />
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </Td>
                      {/*
                        自分の直下にだけ、払う額を決められるようにする。
                        間に人が挟まっている相手の取り分を飛び越えて決められないようにするため。
                        空欄なら推奨の税抜単価（3次 50,000／取次 25,000）がそのまま使われる。
                      */}
                      <Td numeric>
                        <PayUnitCell
                          code={a.code}
                          name={a.name || a.code}
                          value={a.payUnit}
                          fallback={defaultPayUnit(a)}
                          note={a.payUnitNote}
                          editable={a.parentCode === me.code}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            <div className="border-t border-ink-800 px-5 py-3 text-xs leading-relaxed text-ink-400">
              メールアドレスを押すとメールの作成画面が、電話番号を押すと電話の発信画面が開きます。
              「所属会社・種別」と「支払額」は、自分の直下であればこの画面で直せます（押すと入力欄が出ます）。
              {missingContact > 0
                ? `連絡先が登録されていない配下が ${missingContact} 社あります。連絡先はポータルからは直せないため、本部にご連絡ください。`
                : ""}
            </div>
          </>
        )}
      </Card>

      {/* 内訳 */}
      <Card title="配下の内訳">
        <Table>
          <thead>
            <tr>
              <Th>区分</Th>
              <Th align="right">直下</Th>
              <Th align="right">配下すべて</Th>
              <Th>枠のあつかい</Th>
            </tr>
          </thead>
          <tbody>
            {kindRows.map((b) => (
              <tr key={b.label}>
                <Td>{b.label}</Td>
                <Td numeric align="right">
                  {b.direct}
                </Td>
                <Td numeric align="right">
                  {b.all}
                </Td>
                <Td>
                  <span className="text-xs text-ink-400">{b.slot}</span>
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="font-medium text-ink-50">合計</Td>
              <Td numeric align="right" className="font-medium text-ink-50">
                {directChildren.length}
              </Td>
              <Td numeric align="right" className="font-medium text-ink-50">
                {descendants.length}
              </Td>
              <Td>
                <span className="text-xs text-ink-400">—</span>
              </Td>
            </tr>
          </tbody>
        </Table>

        <div className="border-t border-ink-800 px-5 py-3 text-xs leading-relaxed text-ink-400">
          「直下」はあなたが直接登録した先、「配下すべて」はその先の階層も含めた数です。
          {suspendedDirect > 0
            ? `直下の${codeKindLabel("00")}（コード区分00）のうち ${suspendedDirect} 社は停止・解約のため、枠には数えていません。`
            : ""}
        </div>
      </Card>
    </div>
  );
}
