import { redirect } from "next/navigation";
import Link from "next/link";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode, listDescendants } from "@/lib/agencies";
import { attachRewards, listOrders, scopeCodes } from "@/lib/orders";
import { effectivePayUnits } from "@/lib/pay-defaults";
import { PAY_ITEM_LABEL, payItemsOf } from "@/lib/pay-items";
import { companyKey, companyNameOf } from "@/lib/labels";
import { todayInJapan } from "@/lib/jst";
import { readParam, type SearchParams } from "@/lib/list-params";
import { Card, Notice, jpMonthLabel } from "@/components/ui";
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
    basis: "delivered",
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
   * 相手が指定されていないときは、その月に売上があった相手を並べて選んでもらう。
   * 「売上・報酬」で絞り込まずにこの画面へ来た場合が該当する。
   */
  if (!company && !owner) {
    const seen = new Map<string, { label: string; href: string; qty: number }>();
    for (const o of orders) {
      const person = byCode.get(o.ownerCode);
      if (!person) continue;
      const label =
        person.codeKind === "02"
          ? person.companyName || person.parentName || person.name
          : person.name;
      const key = companyKey(label) || o.ownerCode;
      const hit = seen.get(key);
      const qty = o.quantity || 1;
      if (hit) hit.qty += qty;
      else
        seen.set(key, {
          label,
          href: `/rewards/notice?month=${month}&company=${encodeURIComponent(label)}`,
          qty,
        });
    }
    const choices = [...seen.values()].sort((a, b) => b.qty - a.qty);

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href={back} className="text-sm text-ink-300 underline underline-offset-4">
            ← 売上・報酬に戻る
          </Link>
        </div>
        <Card title={`支払通知書を作る（${jpMonthLabel(month)}）`}>
          {choices.length === 0 ? (
            <div className="px-5 py-6">
              <Notice tone="warn">
                {jpMonthLabel(month)}に出荷が完了した受注がありません。
                月を選び直してください。
              </Notice>
            </div>
          ) : (
            <div className="space-y-2 px-5 py-4">
              <p className="text-sm text-ink-300">
                お支払いする相手を選んでください。会社ごとに1枚の通知書を作ります。
              </p>
              <ul className="divide-y divide-ink-850">
                {choices.map((c) => (
                  <li key={c.href}>
                    <Link
                      href={c.href}
                      className="flex items-center justify-between gap-4 py-3 text-sm transition hover:text-gold-300"
                    >
                      <span className="text-ink-100">{c.label}</span>
                      <span className="tabnum text-xs text-ink-400">{c.qty} 台分 →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    );
  }

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
   * 品目は「人ごと × 支払いの品目ごと × 単価ごと」に1行。
   *
   * 2026-08-27 に支払額を本体価格・OP①・OP②・1年後定期の4つに分けたので、
   * 1人ぶんを1行にまとめると、単価×台数と金額が合わなくなる。
   * 受注に入っている品目を読み取って（lib/pay-items.ts）、品目ごとに立てる。
   *
   * 同じ人・同じ品目でも単価が違う受注があれば行を分ける
   * （途中で額を変えた月に、単価×台数が合わなくなるため）。
   *
   * 額を決めていない品目は行を作らない。OP の空欄は「その品目では払わない」ため。
   * ただし本体だけは、額が未設定でも行を残して「—」を出す
   * （払う相手なのに額が決まっていないことに気づけるようにする）。
   */
  const bucket = new Map<string, NoticeLine>();
  for (const o of rows) {
    const person = byCode.get(o.ownerCode);
    const units = person ? effectivePayUnits(person) : null;
    const name = person?.name || o.ownerCode;
    const qty = o.quantity || 1;

    for (const item of payItemsOf(o.productName)) {
      const unit = units ? units[item] : null;
      if (item !== "body" && unit === null) continue;

      const key = `${o.ownerCode}|${item}|${unit ?? "none"}`;
      const hit = bucket.get(key);
      if (hit) {
        hit.qty += qty;
        hit.amount = unit === null ? null : (hit.amount ?? 0) + unit * qty;
      } else {
        bucket.set(key, {
          item: `販売委託手数料　${name}（${o.ownerCode}）　${PAY_ITEM_LABEL[item]}`,
          unit,
          qty,
          amount: unit === null ? null : unit * qty,
        });
      }
    }
  }
  const lines = [...bucket.values()].sort((a, b) => a.item.localeCompare(b.item, "ja"));

  /* 宛名。控えにある名前から出す（URLに書かれた文字はそのまま使わない）。 */
  const toName = owner
    ? target[0]?.name || owner
    : target[0]
      ? companyNameOf(target[0])
      : company;

  const doc: NoticeDoc = {
    to: { name: toName },
    from: {
      name: self.name || self.code,
      zip: self.zip ?? "",
      address: self.address ?? "",
      tel: self.phone ?? "",
    },
    subject: `${jpMonthLabel(month)}度 販売委託手数料`,
    issuedOn: todayInJapan(),
    lines,
  };

  const backLink = (
    <div className="no-print flex flex-wrap items-center justify-between gap-3">
      <Link href={back} className="text-sm text-ink-300 underline underline-offset-4">
        ← 売上・報酬に戻る
      </Link>
    </div>
  );

  /*
   * 相手が見つからない、またはその月の売上が無いときは、書面自体を出さない。
   * 出してしまうと「御支払金額 ¥0」の通知書や、URLに書いただけの
   * 存在しない宛名の通知書がそのまま印刷できてしまう。
   */
  if (target.length === 0) {
    return (
      <div className="space-y-4">
        {backLink}
        <Notice tone="bad">
          「{owner || company}」にあたるスタッフが見つかりませんでした。
          売上・報酬の画面から選び直してください。
        </Notice>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="space-y-4">
        {backLink}
        <Notice tone="warn">
          {jpMonthLabel(month)}に、{toName} の配達が完了した受注がありません。
          月を変えるか、絞り込みを見直してください。
        </Notice>
      </div>
    );
  }

  const missing = lines.filter((l) => l.amount === null);

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="text-sm text-ink-300 underline underline-offset-4">
          ← 売上・報酬に戻る
        </Link>
        <PrintButton />
      </div>

      {missing.length > 0 ? (
        <div className="no-print">
          <Notice tone="warn">
            支払額が決まっていない方がいるため、合計を出せません（
            {missing.map((l) => l.item.replace("販売委託手数料　", "")).join("／")}）。
            「スタッフ一覧」でその方の支払額を入れると、金額の入った通知書になります。
          </Notice>
        </div>
      ) : null}

      <PayeeNoticeDoc doc={doc} />
    </div>
  );
}
