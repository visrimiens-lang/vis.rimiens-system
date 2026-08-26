import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select } from "@/lib/db";
import { b2Config } from "@/lib/yamato";
import { Card, Notice, PageHeader, jpDate } from "@/components/ui";
import { IssueForm, type ShippingRow } from "./IssueForm";

/**
 * 送り状発行（ヤマトB2クラウド・本部専用）。
 *
 * これまでのA案（kintone CSV書き出し → B2クラウド画面で取込 → 番号手入力）を
 * API直結に置き換えたもの（2026-08-27・仕様書4.3版にもとづく）。
 * ボタンひとつで、伝票番号の採番から受注への反映までが終わる。
 *
 * B2クラウドとのやり取りに印刷待ちが入るため、サーバー処理の
 * 時間上限を60秒に延ばしている（通常は数秒で終わる）。
 */
export const maxDuration = 60;

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

export default async function ShippingPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const { config, missing } = b2Config();

  /* 対象：送り状番号がまだ無く、止まっていない受注。 */
  let orders: Row[] = [];
  let issues: Row[] = [];
  let error = "";
  try {
    orders = await select<Row>(
      `orders?select=id,ordered_on,customer_name,phone,zip,address,building,product_name,quantity,ship_status,review_result,tracking_no` +
        `&or=(tracking_no.is.null,tracking_no.eq.)` +
        `&ship_status=in.("出荷待ち","出荷手配中")` +
        `&order=ordered_on.asc,id.asc`,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : "読み込みに失敗しました。";
  }
  try {
    issues = await select<Row>(
      // pdf_base64 は読まない（1件で数百KBになるため）。有無は has_pdf で見る
      `yamato_issues?select=id,issue_no,label_count,has_pdf,created_at&order=id.desc&limit=10`,
    );
  } catch {
    // 控えのテーブルがまだ無くても、発行対象の一覧までは使えるようにしておく
  }

  const rows: ShippingRow[] = orders
    .filter((o) => s_(o, "review_result") !== "否決")
    .map((o) => {
      const problems: string[] = [];
      if (!s_(o, "customer_name")) problems.push("名前");
      if (!s_(o, "phone")) problems.push("電話番号");
      if (!s_(o, "zip")) problems.push("郵便番号");
      if (!s_(o, "address")) problems.push("住所");
      return {
        id: s_(o, "id"),
        orderedOn: jpDate(s_(o, "ordered_on")),
        customerName: s_(o, "customer_name"),
        phone: s_(o, "phone"),
        zip: s_(o, "zip"),
        address: `${s_(o, "address")}${s_(o, "building")}`,
        productName: s_(o, "product_name"),
        quantity: Number(o["quantity"] ?? 1) || 1,
        shipStatus: s_(o, "ship_status"),
        reviewResult: s_(o, "review_result"),
        problem:
          problems.length > 0
            ? `${problems.join("・")}が入っていないため発行できません。受注詳細で直してください。`
            : "",
      };
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="送り状発行"
        description="ヤマトB2クラウドとつないで送り状を発行します。伝票番号は自動で受注に入り、お客様の荷物追跡にもそのまま使われます。発行後、ラベルを印刷して荷物に貼り、集荷をお渡しください。"
      />

      {error ? (
        <Notice tone="bad">読み込めませんでした。{error}</Notice>
      ) : null}

      {!config ? (
        <Notice tone="warn">
          <span className="font-semibold">B2クラウドの接続情報がまだ設定されていません。</span>
          <br />
          不足している設定：{missing.join("、")}
          <br />
          APIアクセス認証キーは、ヤマトビジネスメンバーズ →
          B2クラウド →「外部システムとの連携」で取得できます。API連携会社コードは
          ヤマトとのAPI利用契約時に発行されるものです。取得できたら担当者にお渡しください。
          設定が済むまで、送り状の発行はこれまでどおりB2クラウドの画面から行えます。
        </Notice>
      ) : null}

      <Card title={`送り状が必要な受注　${rows.length} 件`}>
        <IssueForm rows={rows} />
      </Card>

      <Card title="発行の控え（直近10回）">
        {issues.length === 0 ? (
          <div className="px-5 py-6 text-sm text-ink-300">まだ発行の記録がありません。</div>
        ) : (
          <ul className="divide-y divide-ink-850 px-5">
            {issues.map((i) => (
              <li key={s_(i, "id")} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <span className="tabnum text-sm text-ink-100">{s_(i, "issue_no")}</span>
                  <span className="ml-3 text-xs text-ink-400">
                    {s_(i, "created_at").slice(0, 16).replace("T", " ")}　{s_(i, "label_count")} 枚
                  </span>
                </div>
                {i["has_pdf"] ? (
                  <a
                    href={`/api/yamato/label/${s_(i, "id")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-gold-300 underline underline-offset-4 transition hover:text-gold-100"
                  >
                    送り状PDFを開く
                  </a>
                ) : (
                  <span className="text-xs text-ink-500">PDFの控えなし</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-ink-800 px-5 py-3 text-xs leading-relaxed text-ink-400">
          PDFは発行のときに取得した控えです。印刷し直すときはここから開けます。
          控えが無いものは、B2クラウド画面の「再発行」からお出しください。
        </div>
      </Card>
    </div>
  );
}
