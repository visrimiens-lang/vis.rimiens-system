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
import { CustomerFilters, type OwnerOption } from "./filters";

export const metadata = { title: "顧客一覧｜VIS 代理店ポータル" };

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

  // 受注1件ごとの「審査結果」と「配達完了日」。進み具合の判定に使う。
  const reviewByOrder = new Map<string, string>();
  const customerByOrder = new Map<string, string>();
  const deliveredByCustomer = new Map<string, string>();

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
      periodOrders = orders;

      for (const r of raw) {
        const id = text(r, "id");
        if (!id) continue;
        reviewByOrder.set(id, text(r, "review_result"));
        const customerId = text(r, "customer_id");
        if (customerId) customerByOrder.set(id, customerId);
      }

      // 配達が終わった日は顧客台帳のほうに入る。
      // 顧客が紐づいている受注があるときだけ引きに行く。
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
      description="自分と配下が獲得した受注です。申込から商品のお届けまで、いまどこまで進んでいるかを一覧で確認できます。"
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

  /** その受注の進み具合を判定するための材料をそろえる。 */
  const sourceOf = (o: OrderWithReward) => ({
    reviewResult: reviewByOrder.get(o.recordId) ?? "",
    shipStatus: o.shippingStatus,
    deliveredOn: deliveredByCustomer.get(customerByOrder.get(o.recordId) ?? "") ?? "",
  });

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

  // 進み具合の内訳。件数だけ先に数えて、上の数字タイルに出す。
  const states = rows.map((o) => progressOf(sourceOf(o)));
  const shippedCount = states.filter((s) => !s.stopped && s.percent >= 80).length;
  const stoppedCount = states.filter((s) => s.stopped).length;

  // 配達の完了日が入った受注があるかどうかで、凡例と注記の書き方を変える。
  const deliveredCount = states.filter((s) => !s.stopped && s.percent >= 100).length;
  const legendSteps =
    deliveredCount > 0
      ? PROGRESS_STEPS
      : PROGRESS_STEPS.filter((s) => s.key !== "delivered");

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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        <StatTile
          label="発送まで進んだ受注"
          value={String(shippedCount)}
          unit="件"
          tone={stoppedCount > 0 ? "warn" : "default"}
          hint={
            stoppedCount > 0
              ? `中止になった受注が ${stoppedCount} 件あります`
              : deliveredCount > 0
                ? "出荷済・配達完了の合計"
                : "出荷済まで進んだ受注の合計"
          }
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
                <Th>進み具合</Th>
                <Th>審査結果</Th>
                <Th>出荷状況・送り状番号</Th>
                <Th>照合ステータス</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const name = nameByCode.get(o.ownerCode);
                const source = sourceOf(o);
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
                      <Progress compact {...source} />
                    </Td>
                    <Td>
                      <StatusBadge status={source.reviewResult} />
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
                <Td className="font-semibold text-ink-50">{rows.length}件</Td>
                <Td> </Td>
                <Td numeric align="right" className="font-semibold text-ink-50">
                  {unitTotal}
                </Td>
                <Td numeric align="right" className="font-semibold text-gold-300">
                  {yen(salesTotal)}
                </Td>
                <Td> </Td>
                <Td className="text-xs text-ink-400">発送まで進んだ受注 {shippedCount}件</Td>
                <Td> </Td>
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
        コードの下の名前は代理店一覧から引いています。名前が出ない場合は、代理店一覧にそのコードが登録されていないか、
        配下から外れています。
      </Notice>
    </div>
  );
}
