import { redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { attachRewards, listOrders, scopeCodes } from "@/lib/orders";
import { effectivePayUnit } from "@/lib/pay-defaults";
import { companyKey } from "@/lib/labels";
import { readParam, type SearchParams } from "@/lib/list-params";
import { Notice, jpMonthLabel } from "@/components/ui";
import { PayeeNoticeDoc, type NoticeDoc, type NoticeLine } from "./PayeeNoticeDoc";
import { PrintButton } from "../PrintButton";

/**
 * 御支払通知書（配下へ渡す1枚）。
 *
 * 「売上・報酬」の担当ごとの内訳を、そのまま渡せる書面にしたもの。
 * 画面をそのまま印刷するのではなく、支払通知の様式で組み直している。
 *
 *   /rewards/notice?month=2026-08&company=株式会社◯◯   会社ごと（その会社の全員をまとめて1枚）
 *   /rewards/notice?month=2026-08&owner=SASA0001        担当ごと（その人だけで1枚）
 *
 * 支払う相手が決まらないと書面にならないので、どちらも無いときは選び方を案内する。
 */

export const dynamic = "force-dynamic";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default async function PayeeNoticePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  const params: SearchParams = await searchParams;
  const monthParam = readParam(params, "month");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : currentMonth();
  const company = readParam(params, "company");
  const owner = readParam(params, "owner");

  const back = `/rewards?month=${month}`;

  if (!company && !owner) {
    return (
      <div className="space-y-6">
        <Notice tone="info">
          支払通知書は、お支払いする相手ごとに作ります。
          「売上・報酬」の画面で会社または担当で絞り込んでから、
          「支払通知書を作る」を押してください。
          <Link href={back} className="ml-2 underline underline-offset-4">
            売上・報酬に戻る
          </Link>
        </Notice>
      </div>
    );
  }

  const self = await findAgencyByCode(viewer.code);
  if (!self) {
    return (
      <Notice tone="bad">
        代理店コード {viewer.code} の登録が見つかりませんでした。本部にお問い合わせください。
      </Notice>
    );
  }

  const descendants = await listDescendants(self.code);
  const byCode = new Map(descendants.map((d) => [d.code, d]));
  const { raw } = await listOrders(scopeCodes(self, descendants), {
    month,
    basis: "shipped",
  });
  /*
   * キャンセルと審査否決は入金にならないので、支払通知にも載せない
   * （売上・報酬の画面と同じ決まり）。
   */
  const live = raw.filter((r) => {
    const s = String(r["ship_status"] ?? "");
    const rv = String(r["review_result"] ?? "");
    return s !== "キャンセル" && rv !== "否決";
  });
  const orders = attachRewards(live, "");

  /*
   * この通知書に載せる相手を決める。
   * 会社で作るときは、その会社に属する人全員の売上をまとめる。
   */
  const target = descendants.filter((d) => {
    if (owner) return d.code === owner;
    const label = d.codeKind === "02" ? d.companyName || d.parentName : d.name;
    return companyKey(label) === companyKey(company);
  });
  const targetCodes = new Set(target.map((d) => d.code));

  const rows = orders.filter((o) => targetCodes.has(o.ownerCode));

  /*
   * 品目は「人ごと × 単価ごと」に1行。
   * 同じ人でも単価が違う受注があれば行を分ける（数量×単価が合わなくなるため）。
   */
  const bucket = new Map<string, NoticeLine>();
  for (const o of rows) {
    const person = byCode.get(o.ownerCode);
    const unit = person ? effectivePayUnit(person) : null;
    const key = `${o.ownerCode}|${unit ?? "none"}`;
    const name = person?.name || o.ownerCode;
    const hit = bucket.get(key);
    const qty = o.quantity || 1;
    if (hit) {
      hit.qty += qty;
      hit.amount = unit === null ? null : (hit.amount ?? 0) + unit * qty;
    } else {
      bucket.set(key, {
        item: `販売委託手数料　${name}（${o.ownerCode}）`,
        unit,
        qty,
        amount: unit === null ? null : unit * qty,
      });
    }
  }
  const lines = [...bucket.values()].sort((a, b) => a.item.localeCompare(b.item, "ja"));

  /*
   * 宛先。会社でまとめるときは、振込先はその会社の誰かに入っているものを使う
   * （個別に入っていなければ空欄で出し、手で書き足してもらう）。
   */
  const head = target.find((d) => d.bankName) ?? target[0];
  const toName = owner ? head?.name || owner : company;

  const doc: NoticeDoc = {
    to: {
      name: toName,
      invoiceNo: head?.invoiceNo ?? "",
      bank: head?.bankName ?? "",
      branch: head?.bankBranch ?? "",
      type: head?.accountType ?? "",
      no: head?.accountNo ?? "",
      holder: head?.accountHolder ?? "",
    },
    from: {
      name: self.name || self.code,
      zip: self.zip ?? "",
      address: self.address ?? "",
      tel: self.phone ?? "",
      invoiceNo: self.invoiceNo ?? "",
    },
    subject: `${jpMonthLabel(month)}度 販売委託手数料`,
    issuedOn: new Date().toISOString().slice(0, 10),
    lines,
  };

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="text-sm text-ink-300 underline underline-offset-4">
          ← 売上・報酬に戻る
        </Link>
        <PrintButton />
      </div>

      {lines.length === 0 ? (
        <Notice tone="warn">
          {jpMonthLabel(month)}に、この相手の出荷完了した受注がありません。
          月を変えるか、絞り込みを見直してください。
        </Notice>
      ) : null}

      {lines.some((l) => l.amount === null) ? (
        <div className="no-print">
          <Notice tone="warn">
            支払単価が決まっていない行があります。「組織と枠」でその方の支払額を入れると、
            金額が入った状態で出せます。
          </Notice>
        </div>
      ) : null}

      <PayeeNoticeDoc doc={doc} />
    </div>
  );
}
