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

export const metadata = { title: "デモ機｜VIS 代理店ポータル" };

/** "2026-08-07" を "2026/8/7" にする。年をまたぐ台帳なので年まで出す。 */
function fullDate(v: string): string {
  if (!v) return "—";
  return `${v.slice(0, 4)}/${jpDate(v)}`;
}

export default async function DemoMachinesPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

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
      description="自分と配下が保有しているデモ機の一覧です。製造番号・状態・貸出先を確認できます。"
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
        </Notice>
      ) : null}

      <Card title="デモ機一覧">
        {machines.length === 0 ? (
          <EmptyState
            title="デモ機の登録がありません"
            description="デモ機登録フォームから申請すると、ここに表示されます。申請から反映までは本部での登録作業が入ります。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>製造番号</Th>
                <Th>機種</Th>
                <Th>端末状態</Th>
                <Th>取得区分</Th>
                <Th>取得日</Th>
                <Th>貸出先</Th>
                <Th>返却予定日</Th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const overdue = isOverdue(m, today);
                return (
                  <tr key={m.recordId}>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span className="tabnum font-medium text-ink-50">
                          {m.serial || "—"}
                        </span>
                        {m.reuseFlag === "転用済" ? <Badge tone="gold">転用済</Badge> : null}
                      </div>
                      <div className="mt-1 text-xs text-ink-400">
                        {m.holderCode === self?.code
                          ? "自分の保有"
                          : `${m.holderName || "保有代理店名なし"}（${m.holderCode || "コードなし"}）`}
                      </div>
                    </Td>
                    <Td>{m.model || "—"}</Td>
                    <Td>
                      <StatusBadge status={m.condition} />
                    </Td>
                    <Td>{m.acquisition || "—"}</Td>
                    <Td numeric>{fullDate(m.acquiredOn)}</Td>
                    <Td>
                      {m.lentTo || "—"}
                      {m.purpose ? (
                        <div className="mt-1 text-xs text-ink-400">{m.purpose}</div>
                      ) : null}
                    </Td>
                    <Td numeric className={overdue ? "text-warn-100" : undefined}>
                      {fullDate(m.dueOn)}
                      {overdue ? (
                        <div className="mt-1 text-xs font-medium text-warn-500">
                          返却予定日を過ぎています
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Notice tone="info">
        この一覧はデモ機登録フォームから申請された内容をもとにしています。製造番号や貸出先の記載に誤りがある場合、
        ポータルからは直せません。本部までご連絡ください。
      </Notice>
    </div>
  );
}
