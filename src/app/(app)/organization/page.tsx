import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import {
  buildOrgTree,
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
  Table,
  Td,
  Th,
  cn,
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
import {
  agencyTypeOf,
  belongsToOrg,
  companyKey,
  companyNameOf,
  statusTone,
} from "@/lib/labels";
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
        枠がすべて埋まっています。新しくスタッフを登録するには、増枠のお申し込みが必要です。
      </Notice>
    );
  }
  return null;
}

/* ---------- 画面本体 ---------- */

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    company?: string;
    type?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const keyword = readParam(params, "q");
  /* 絞り込み。"all" は絞っていない状態（選び直しの部品と同じ決まり）。 */
  const companyParam = readParam(params, "company") || ALL;
  const typeParam = readParam(params, "type") || ALL;
  const sort = parseSort(params, DEFAULT_SORT, SORT_COLUMNS);

  const header = (
    <PageHeader
      title="スタッフ一覧"
      description="スタッフの一覧と、枠の空き状況をまとめています。枠はスタッフ100名です。スタッフの連絡先（メールアドレス・電話番号）もこの画面で確認でき、所属会社と種別はこの画面で設定します。"
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
        // 総販売代理店の下にいるのは統括代理店。全国60社のエリア枠で見る。
        const usage = areaUsage(await listAllAgencies());
        areaRows = usage.rows;
        areaTotal = usage.total;
      } else if (model === "staff") {
        breakdown = breakdownSlots(me, direct);
      }
      // model === "none"（取次パートナー・スタッフ）は下に人を持たないため枠を出さない
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

  /* --- スタッフ一覧（連絡先つき） --- */

  /*
   * 絞り込みに使う値。
   * 会社名は売上・報酬と同じ出し方（labels.ts の companyNameOf）にそろえる。
   * ばらばらに書くと、同じ人が画面によって別の会社に見えてしまう。
   */
  const companyOf = (a: Agency) => companyNameOf(a);
  const typeOf = (a: Agency) => agencyTypeOf(a.rank, a.channel, a.codeKind, a.staffType);

  /*
   * 選択肢は、いまいる顔ぶれから作る。
   * 選ばれている値は件数が0でも残る（自分で外せなくなるため・buildOptions の決まり）。
   */
  const companyOptions = buildOptions(descendants, companyOf, [], companyParam);
  const typeOptions = buildOptions(descendants, typeOf, [], typeParam);

  const contacts = descendants.filter((a) => {
    if (!matchesKeyword(keyword, [a.code, a.name, a.representative, a.email, a.phone])) {
      return false;
    }
    // 会社名は表記のゆれを吸収して突き合わせる（「(株)樹」と「株式会社樹」を同じ会社と見る）
    if (companyParam !== ALL && companyKey(companyOf(a)) !== companyKey(companyParam)) {
      return false;
    }
    if (typeParam !== ALL && typeOf(a) !== typeParam) return false;
    return true;
  });

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

  const isFiltered = keyword !== "" || companyParam !== ALL || typeParam !== ALL;
  const clearHref = buildListHref(BASE, params, { q: "", company: "", type: "" });
  const missingContact = descendants.filter((a) => !a.email && !a.phone).length;

  return (
    <div className="space-y-6">
      {header}

      {/* 枠。取次パートナーとスタッフは下に人を持たないので出さない */}
      {breakdown || areaRows ? (
      <Card
        title={areaRows ? "エリア枠（統括代理店）" : "スタッフの枠"}
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
                この枠の相手は統括代理店なので、枠はエリアごとに決まっています。全国で {areaTotal.limit} 社までです。
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

      {/* スタッフ一覧（連絡先） */}
      <Card title={`スタッフ一覧　${contactRows.length} 名`}>
        {descendants.length === 0 ? (
          <EmptyState
            title="まだスタッフの登録がありません。"
            description="スタッフが登録されると、連絡先（メールアドレス・電話番号）をここで確認できます。"
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
                placeholder="例：山田／ABCD0001／090"
                width="w-72"
              />
              {companyOptions.length > 1 ? (
                <FilterSelect
                  name="company"
                  label="会社で絞る"
                  value={companyParam}
                  options={companyOptions}
                  allLabel={`すべての会社（${descendants.length}）`}
                  width="w-64"
                />
              ) : null}
              {typeOptions.length > 1 ? (
                <FilterSelect
                  name="type"
                  label="種別で絞る"
                  value={typeParam}
                  options={typeOptions}
                  allLabel={`すべての種別（${descendants.length}）`}
                  width="w-52"
                />
              ) : null}
              <FilterActions clearHref={clearHref} filtered={isFiltered} />
            </FilterBar>

            {isFiltered ? (
              <div className="border-t border-ink-800 px-5 py-3">
                <FilterSummary
                  total={descendants.length}
                  shown={contactRows.length}
                  unit="名"
                  clearHref={clearHref}
                />
              </div>
            ) : null}

            {contactRows.length === 0 ? (
              <EmptyState
                title="条件に合うスタッフがいません"
                description="名前・コード・メールアドレス・電話番号の一部で探せます。会社と種別でも絞れます。条件を外すとスタッフ全員が表示されます。"
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
                            /*
                              所属会社名と種別は、自分より下にいる相手であれば直せる。
                              旧方式で登録された会社の下にいるスタッフは
                              統括から見ると孫にあたるため、直下に限ると誰も直せなくなる。
                              金額に関わらない情報なので、下にいる相手すべてに開く。
                            */
                            editable
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
                ? `連絡先が登録されていない方が ${missingContact} 名います。ご本人が「アカウント設定」から入れられます（郵便番号・住所・電話番号）。`
                : ""}
            </div>
          </>
        )}
      </Card>

    </div>
  );
}
