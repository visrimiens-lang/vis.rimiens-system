import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select, selectOne } from "@/lib/db";
import { listAllAgencies } from "@/lib/agencies";
import type { Agency } from "@/lib/types";
import {
  Card,
  PageHeader,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  cn,
  jpDate,
  yen,
} from "@/components/ui";
import { Progress, yamatoTrackingUrl } from "@/components/Progress";
import { paymentMethodLabel, paymentStatusLabel } from "@/lib/payment-status";
import { companyNameOf } from "@/lib/labels";
import {
  CustomerEditForm,
  STAFF_CODE_LIST_ID,
  type CustomerView,
} from "../CustomerForm";

/**
 * お客様1名ぶんの詳細（本部）。
 *
 * もとは顧客管理の一覧で、行の下に登録内容を開く形にしていた。
 * ただ受注一覧は注文者名から専用ページへ飛ぶ作りで、操作が揃っていなかった。
 * それに、行の下に開く形ではそのお客様の受注を並べる場所が無く、
 * 「この方が何を何回買ったか」を見るには受注一覧へ移って探し直すことになる。
 * 2026-08-31 の依頼で、受注詳細と同じ専用ページに寄せた。
 */

export const metadata = { title: "お客様の詳細（本部）｜VIS 代理店ポータル" };

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

const n_ = (r: Row, k: string): number => {
  const v = Number(r[k]);
  return Number.isFinite(v) ? v : 0;
};

function toCustomer(r: Row): CustomerView {
  return {
    id: s_(r, "id"),
    name: s_(r, "name"),
    nameKana: s_(r, "name_kana"),
    email: s_(r, "email"),
    phone: s_(r, "phone"),
    zip: s_(r, "zip"),
    address: s_(r, "address"),
    building: s_(r, "building"),
    receiptName: s_(r, "receipt_name"),
    note: s_(r, "note"),
    referrerCode: s_(r, "referrer_code"),
    agencyCode: s_(r, "agency_code"),
    staffCode: s_(r, "staff_code"),
    reviewStatus: s_(r, "review_status"),
    paymentStatus: s_(r, "payment_status"),
    paymentMethod: s_(r, "payment_method"),
    contractedOn: s_(r, "contracted_on"),
    shipStatus: s_(r, "ship_status"),
    trackingNo: s_(r, "tracking_no"),
    deliveredOn: s_(r, "delivered_on"),
    serialNo: s_(r, "serial_no"),
    padSubscriptionId: s_(r, "pad_subscription_id"),
    padChargeFrom: s_(r, "pad_charge_from"),
  };
}

/** 項目1つぶん。受注詳細と同じ見え方にそろえてある。 */
function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children?: ReactNode;
  wide?: boolean;
}) {
  const empty =
    children === null || children === undefined || children === "" || children === false;
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-3")}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
        {label}
      </dt>
      <dd className="mt-1.5 break-words text-sm leading-relaxed text-ink-100">
        {empty ? <span className="text-ink-500">—</span> : children}
      </dd>
    </div>
  );
}

function Fields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-5 px-5 py-5 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </dl>
  );
}

/** コードと名前を並べて出す。マスタに無いコードははっきり分かるようにする。 */
function CodeCell({ code, name }: { code: string; name: string }) {
  if (!code) return <span className="text-ink-500">—</span>;
  return (
    <>
      <span className="tabnum">{code}</span>
      <div className="mt-0.5 text-xs text-ink-400">
        {name || "代理店一覧に見当たりません"}
      </div>
    </>
  );
}

/** 年をまたぐ台帳なので、日付は年まで出す。 */
function fullDate(v: string): string {
  if (!v) return "";
  return `${v.slice(0, 4)}/${jpDate(v)}`;
}

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const row = await selectOne<Row>(`customers?select=*&id=eq.${id}`);
  if (!row) notFound();
  const customer = toCustomer(row);

  /*
   * そのお客様の受注。顧客台帳の番号で引く。
   * 台帳と結びついていない受注（番号が入る前のもの）は電話番号で拾えるが、
   * 別人を混ぜる方が困るので、ここでは番号が一致するものだけにする。
   */
  let orders: Row[] = [];
  try {
    orders = await select<Row>(
      `orders?select=*&customer_id=eq.${id}&order=ordered_on.desc`,
    );
  } catch {
    // 受注が読めなくても、お客様の内容は出せるので続ける
  }

  let agencies: Agency[] = [];
  try {
    agencies = await listAllAgencies();
  } catch {
    // 代理店名が引けないだけ。コードはそのまま出す
  }
  const nameByCode = new Map(agencies.map((a) => [a.code, a.name]));
  const companyByCode = new Map(agencies.map((a) => [a.code, companyNameOf(a)]));
  const staffName = nameByCode.get(customer.staffCode) ?? "";

  /* 顧客台帳の言葉を、進み具合の部品が読める言葉に言い換える（一覧と同じ扱い） */
  const review =
    customer.reviewStatus === "審査完了"
      ? "承認"
      : customer.reviewStatus === "審査NG"
        ? "否決"
        : "";
  const progress = {
    reviewResult: review,
    shipStatus: customer.paymentStatus === "否決・キャンセル" ? "キャンセル" : customer.shipStatus,
    deliveredOn: customer.deliveredOn,
    paymentMethod: customer.paymentMethod,
    paymentStatus: customer.paymentStatus,
  };

  const liveOrders = orders.filter((o) => s_(o, "ship_status") !== "キャンセル");
  const total = liveOrders.reduce((sum, o) => sum + n_(o, "amount"), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${customer.name || "（お名前未登録）"} 様`}
        description={`顧客台帳の番号 ${customer.id}${
          customer.contractedOn ? `・${fullDate(customer.contractedOn)} ご契約` : ""
        } のお客様です。登録内容の修正と、これまでのご注文を確認できます。`}
        actions={
          <Link
            href="/admin/customers"
            className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200 transition hover:bg-ink-850"
          >
            顧客管理へ戻る
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="ご注文"
          value={liveOrders.length.toLocaleString("ja-JP")}
          unit="件"
          hint={
            orders.length > liveOrders.length
              ? `ほかに取り消し ${orders.length - liveOrders.length} 件`
              : "キャンセルを除いた件数"
          }
        />
        <StatTile
          label="お支払い総額（税込）"
          value={yen(total)}
          hint="キャンセルを除いたご注文の合計"
        />
        <StatTile
          label="お支払い"
          value={
            paymentStatusLabel(customer.paymentMethod, customer.paymentStatus) ||
            customer.paymentStatus ||
            "—"
          }
          hint={paymentMethodLabel(customer.paymentMethod) || "決済方法は未記録です"}
        />
      </div>

      <Card title="申込からお届けまで">
        <div className="px-5 py-5">
          <Progress {...progress} />
        </div>
      </Card>

      <Card title="ご連絡先とお届け先">
        <Fields>
          <Field label="お名前">{customer.name}</Field>
          <Field label="フリガナ">{customer.nameKana}</Field>
          <Field label="電話番号">
            <span className="tabnum">{customer.phone}</span>
          </Field>
          <Field label="メールアドレス">{customer.email}</Field>
          <Field label="郵便番号">
            <span className="tabnum">{customer.zip}</span>
          </Field>
          <Field label="ご契約日">{fullDate(customer.contractedOn)}</Field>
          <Field label="お届け先住所" wide>
            {[customer.address, customer.building].filter(Boolean).join("　")}
          </Field>
          <Field label="領収書のお宛名">{customer.receiptName}</Field>
          <Field label="製造番号">{customer.serialNo}</Field>
          <Field label="本部の覚書" wide>
            {customer.note}
          </Field>
        </Fields>
      </Card>

      <Card title="売上の付け先">
        <Fields>
          <Field label="担当代理店">
            <CodeCell
              code={customer.agencyCode}
              name={nameByCode.get(customer.agencyCode) ?? ""}
            />
          </Field>
          <Field label="担当スタッフ">
            <CodeCell code={customer.staffCode} name={staffName} />
          </Field>
          <Field label="紹介元">
            {customer.referrerCode ? (
              <CodeCell
                code={customer.referrerCode}
                name={nameByCode.get(customer.referrerCode) ?? ""}
              />
            ) : (
              companyByCode.get(customer.staffCode) || ""
            )}
          </Field>
        </Fields>
      </Card>

      <Card title="出荷とお届け">
        <Fields>
          <Field label="出荷状況">
            <StatusBadge status={customer.shipStatus} />
          </Field>
          <Field label="送り状番号">
            {customer.trackingNo ? (
              <a
                href={yamatoTrackingUrl(customer.trackingNo)}
                target="_blank"
                rel="noopener noreferrer"
                title="ヤマト運輸の荷物追跡ページを新しいタブで開きます"
                className="tabnum underline underline-offset-4 transition hover:text-gold-300"
              >
                {customer.trackingNo}
              </a>
            ) : null}
          </Field>
          <Field label="配達完了日">{fullDate(customer.deliveredOn)}</Field>
          <Field label="1年後の定期パッド">
            {customer.padChargeFrom
              ? `${fullDate(customer.padChargeFrom)} から`
              : "予定なし"}
          </Field>
        </Fields>
      </Card>

      <Card
        title="ご注文"
        action={
          <span className="text-xs text-ink-400">
            {orders.length.toLocaleString("ja-JP")} 件
          </span>
        }
      >
        {orders.length === 0 ? (
          <p className="px-5 py-5 text-sm text-ink-400">
            このお客様のご注文はまだありません。
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>受注日</Th>
                <Th>商品</Th>
                <Th align="right">台数</Th>
                <Th align="right">金額（税込）</Th>
                <Th>決済方法</Th>
                <Th>お支払い</Th>
                <Th>出荷状況</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={s_(o, "id")}>
                  <Td numeric className="whitespace-nowrap">
                    <Link
                      href={`/admin/orders/${encodeURIComponent(s_(o, "id"))}`}
                      className="underline underline-offset-4 transition hover:text-gold-300"
                    >
                      {fullDate(s_(o, "ordered_on")) || "—"}
                    </Link>
                  </Td>
                  <Td className="min-w-[13rem] max-w-[22rem]">
                    <span
                      className="line-clamp-2 leading-snug"
                      title={s_(o, "product_name") || undefined}
                    >
                      {s_(o, "product_name") || "—"}
                    </span>
                  </Td>
                  <Td numeric align="right">
                    {(n_(o, "quantity") || 1).toLocaleString("ja-JP")}
                  </Td>
                  <Td numeric align="right">
                    {yen(n_(o, "amount"))}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {paymentMethodLabel(s_(o, "payment_method")) || "—"}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusBadge
                      status={
                        paymentStatusLabel(
                          s_(o, "payment_method"),
                          s_(o, "payment_status"),
                        ) || s_(o, "payment_status")
                      }
                    />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusBadge status={s_(o, "ship_status")} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="登録内容を直す">
        <div className="px-5 py-5">
          <CustomerEditForm customer={customer} staffName={staffName} />
        </div>
      </Card>

      {/* 担当スタッフのコード欄で、登録されているコードから選べるようにする */}
      <datalist id={STAFF_CODE_LIST_ID}>
        {agencies.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}
