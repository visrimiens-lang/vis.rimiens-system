import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import {
  buildOrgTree,
  countsTowardSlot,
  findAgencyByCode,
  getSlotSummary,
  listDirectChildren,
  slotLimitsOf,
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
import { SlotRequestButton } from "./SlotRequestButton";

/* ---------- 組織図を「行＋深さ」に平らにする ---------- */

type Row = { agency: Agency; depth: number };

function flatten(node: OrgNode, depth = 0, out: Row[] = []): Row[] {
  out.push({ agency: node.agency, depth });
  for (const child of node.children) flatten(child, depth + 1, out);
  return out;
}

function kindLabel(a: Agency): string {
  if (a.codeKind === "00") return "販売代理店";
  if (a.codeKind === "01") return "取次パートナー";
  if (a.codeKind === "02") return "スタッフ";
  return "区分未設定";
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
        増枠が承認されています。上限は {slots.limit} 社に設定済みです。空き枠にそのまま登録を進められます。
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
        枠がすべて埋まっています。新しく販売代理店を登録するには、増枠のお申し込みが必要です。
      </Notice>
    );
  }
  return null;
}

/* ---------- 枠のマス ---------- */

function SlotGrid({ slots }: { slots: SlotSummary }) {
  const total = Math.max(slots.limit, slots.used);
  const cells = Array.from({ length: total }, (_, i) => i);

  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((i) => {
        const member = slots.members[i];
        const overflow = i >= slots.limit;

        if (!member) {
          return (
            <li
              key={`empty-${i}`}
              className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-center"
            >
              <div className="text-sm text-ink-400">空き</div>
              <div className="tabnum mt-0.5 text-[11px] text-ink-600">{i + 1} 枠目</div>
            </li>
          );
        }

        return (
          <li
            key={member.code || `filled-${i}`}
            className={cn(
              "rounded-lg border px-3 py-3",
              overflow
                ? "border-warn-500/40 bg-warn-500/10"
                : "border-gold-500/35 bg-gold-500/10",
            )}
            title={member.name}
          >
            <div className="truncate text-sm font-medium text-ink-50">
              {member.name || "（名称未登録）"}
            </div>
            <div
              className={cn(
                "tabnum mt-0.5 truncate text-[11px]",
                overflow ? "text-warn-100" : "text-gold-300",
              )}
            >
              {member.code || "—"}
              {overflow ? "・上限超過" : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- 画面本体 ---------- */

export default async function OrganizationPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const header = (
    <PageHeader
      title="組織と枠"
      description="配下の代理店の並びと、枠の空き状況をまとめています。枠は販路種別ごとに分かれていて、合計100枠です。"
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
      } else if (model === "channel") {
        breakdown = breakdownSlots(me, direct, slotLimitsOf(me));
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

  const kindRows = [
    { label: "販売代理店（コード区分00）", kind: "00", slot: "1社ぶん消費" },
    { label: "取次パートナー", kind: "01", slot: "消費しない" },
    { label: "スタッフ", kind: "02", slot: "消費しない" },
    { label: "区分未設定", kind: "", slot: "—" },
  ]
    .map((b) => ({
      ...b,
      direct: countBy(directChildren, b.kind),
      all: countBy(descendants, b.kind),
    }))
    .filter((b) => b.kind !== "" || b.all > 0);

  const suspendedDirect = directChildren.filter(
    (a) => a.codeKind === "00" && a.status === "停止・解約",
  ).length;

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
              const consumes = countsTowardSlot(agency);
              const isSelf = agency.code === me.code;
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
                      {agency.rank}
                    </Badge>
                  ) : null}
                  <StatusBadge status={agency.status} />
                  <span className="text-xs text-ink-400">{kindLabel(agency)}</span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-800 px-5 py-3 text-xs text-ink-400">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-0.5 shrink-0 bg-gold-500/70" />
            枠を消費する販売代理店（コード区分 00）
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-0.5 shrink-0 bg-ink-800" />
            取次パートナー・スタッフ（枠は消費しません）
          </span>
        </div>
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
            ? `直下の販売代理店のうち ${suspendedDirect} 社は停止・解約のため、枠には数えていません。`
            : ""}
        </div>
      </Card>
    </div>
  );
}
