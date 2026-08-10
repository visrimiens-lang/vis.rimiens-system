import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
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
import { CustomerFilters, type OwnerOption } from "./filters";

export const metadata = { title: "顧客一覧｜VIS 代理店ポータル" };

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

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; code?: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const { month: monthParam, code: codeParam } = await searchParams;
  const thisMonth = currentMonth();
  const months = recentMonths(12);
  const month = normalizeMonth(monthParam, thisMonth);
  const selectedCode = codeParam?.trim() ? codeParam.trim() : "all";
  const periodLabel = month === "all" ? "全期間" : jpMonthLabel(month);
  const allPeriod = month === "all";

  let self: Agency | null = null;
  let members: Agency[] = [];
  let periodOrders: OrderWithReward[] = [];
  let error: string | null = null;

  try {
    self = await findAgencyByCode(viewer.code);
    if (!self) {
      error = `代理店一覧にあなたのコード（${viewer.code}）が見つかりませんでした。本部にお問い合わせください。`;
    } else {
      const descendants = await listDescendants(self.code);
      members = [self, ...descendants];
      const { orders } = await listOrders(
        scopeCodes(self, descendants),
        allPeriod ? {} : { month },
      );
      periodOrders = orders;
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
      description="自分と配下が獲得した受注です。期間と担当コードで絞り込めます。"
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

  // 担当コードごとの件数（期間で絞ったあと・担当で絞る前）
  const countByCode = new Map<string, number>();
  for (const o of periodOrders) {
    const key = o.ownerCode || "";
    countByCode.set(key, (countByCode.get(key) ?? 0) + 1);
  }

  // 選択肢は「配下の全コード」＋「受注に出てきたコード」。0件の人も選べるようにする。
  const optionCodes = new Set<string>(members.map((m) => m.code).filter(Boolean));
  for (const code of countByCode.keys()) if (code) optionCodes.add(code);

  const options: OwnerOption[] = [...optionCodes]
    .map((code) => ({
      code,
      name: nameByCode.get(code) ?? "",
      count: countByCode.get(code) ?? 0,
      isSelf: code === self?.code,
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.code.localeCompare(b.code);
    });

  const rows =
    selectedCode === "all"
      ? periodOrders
      : periodOrders.filter((o) => o.ownerCode === selectedCode);

  const unitTotal = rows.reduce((s, o) => s + (o.quantity || 1), 0);
  const salesTotal = rows.reduce((s, o) => s + o.amount, 0);
  const selectedName = nameByCode.get(selectedCode) ?? "";

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <CustomerFilters
          month={month}
          months={months}
          code={selectedCode}
          options={options}
          defaultMonth={thisMonth}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="受注件数"
          value={String(rows.length)}
          unit="件"
          hint={periodLabel}
        />
        <StatTile label="台数" value={String(unitTotal)} unit="台" hint="数量の合計" />
        <StatTile
          label="販売金額"
          value={yen(salesTotal)}
          tone="gold"
          hint="お客様のお支払額の合計"
        />
      </div>

      <Card
        title={`受注明細（${periodLabel}${
          selectedCode === "all" ? "" : `・${selectedCode}`
        }）`}
        action={
          <span className="text-xs text-ink-400">
            担当={selectedCode === "all" ? "すべて" : selectedCode}
          </span>
        }
      >
        {rows.length === 0 ? (
          selectedCode === "all" ? (
            <EmptyState
              title="まだ受注がありません"
              description="QR2の決済が完了すると、この一覧に自動で表示されます。反映は数分以内です。"
            />
          ) : (
            <EmptyState
              title="この担当コードの受注はありません"
              description={`${selectedCode}${
                selectedName ? `（${selectedName}）` : ""
              } の${periodLabel}の受注はまだありません。担当コードを「すべての担当」に戻すと、配下全体の受注を確認できます。`}
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>受注日</Th>
                <Th>顧客名</Th>
                <Th>商品名</Th>
                <Th align="right">台数</Th>
                <Th align="right">金額</Th>
                <Th>担当コード</Th>
                <Th>出荷状況</Th>
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
                    <Td>{o.productName || "—"}</Td>
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
                      <StatusBadge status={o.shippingStatus} />
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
                <Td className="font-semibold text-ink-50">{rows.length}件</Td>
                <Td> </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-300">
                  {yen(salesTotal)}
                </Td>
                <Td> </Td>
                <Td> </Td>
                <Td> </Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        担当コードは、取次紹介コードが入っている受注ではそのコード、入っていない受注では受注に記録された代理店コードです。
        コードの下の名前は代理店一覧から引いています。名前が出ない場合は、代理店一覧にそのコードが登録されていないか、
        配下から外れています。
      </Notice>
    </div>
  );
}
