import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select, selectOne } from "@/lib/db";
import { PRODUCT_COLUMNS, buildProductMatcher } from "@/lib/product-match";
import {
  paymentMethodLabel,
  paymentStatusLabel,
  paymentStatusOf,
} from "@/lib/payment-status";
import { rankLabel, rankShort } from "@/lib/labels";
import { digitsOf } from "@/lib/list-params";
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
  cn,
  jpMonthLabel,
  yen,
} from "@/components/ui";
import { AttributionForm } from "./AttributionForm";
import { ShipForm, type ReferrerOption } from "./ShipForm";

export const metadata = { title: "受注の詳細（本部）｜VIS 代理店ポータル" };

/* ------------------------------------------------------------------
 * 受注1件の全体像。
 * 本部はこの画面だけで「誰の売上か」「審査は通ったか」「出荷したか」
 * 「いくらの報酬が立ったか」を確かめて、出荷の手配まで済ませる。
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const str = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const num = (r: Row | null, k: string): number => {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

/** 「2026年8月11日」の形。一覧の M/D と違い、詳細では年まで出す。 */
function fullDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v || "—";
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/** 日時。サーバーの時計に関係なく日本時間で出す。 */
function fullDateTime(v: string): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * ヤマト運輸の追跡ページ。
 * 番号にハイフンや空白が入っていても開けるよう、数字だけにして渡す。
 */
function trackingUrl(trackingNo: string): string {
  const digits = digitsOf(trackingNo) || trackingNo;
  return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=${encodeURIComponent(digits)}`;
}

/** 項目1つぶんの表示。値が空なら「—」を出す。 */
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
    children === null ||
    children === undefined ||
    children === "" ||
    children === false;
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

/** 代理店コードと法人名を並べて出す。マスタに無いコードははっきり分かるようにする。 */
function AgencyCell({
  code,
  names,
}: {
  code: string;
  names: Map<string, string>;
}) {
  if (!code) return null;
  const name = names.get(code);
  return (
    <div className="min-w-0">
      <div className="tabnum font-medium text-ink-50">{code}</div>
      {name ? (
        <div className="mt-0.5 text-xs text-ink-400">{name}</div>
      ) : (
        <div className="mt-1">
          <Badge tone="warn">代理店マスタに該当なし</Badge>
        </div>
      )}
    </div>
  );
}

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const { id: rawId } = await params;
  const id = /^\d+$/.test(rawId) ? rawId : "";

  const backLink = (
    <Link
      href="/admin/orders"
      className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50"
    >
      受注一覧へ戻る
    </Link>
  );

  const header = (title: string, description: string) => (
    <PageHeader title={title} description={description} actions={backLink} />
  );

  if (!id) {
    return (
      <div className="space-y-6">
        {header("受注の詳細", "受注を1件ずつ確認し、出荷の手配まで行う画面です。")}
        <Notice tone="warn">
          受注番号が正しくありません。受注一覧から、確認したいご注文を選び直してください。
        </Notice>
      </div>
    );
  }

  /* --- 受注そのもの。ここが読めなければ何も出せない --- */
  let order: Row | null = null;
  let loadError: string | null = null;
  try {
    order = await selectOne<Row>(`orders?select=*&id=eq.${id}`);
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "時間をおいて画面を開き直してください。";
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        {header("受注の詳細", "受注を1件ずつ確認し、出荷の手配まで行う画面です。")}
        <Notice tone="bad">
          ご注文を読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、保管先（Supabase）の接続設定をご確認ください。
        </Notice>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-6">
        {header("受注の詳細", "受注を1件ずつ確認し、出荷の手配まで行う画面です。")}
        <Notice tone="warn">
          受注番号 {id} のご注文は見つかりませんでした。すでに削除されたか、番号が違う可能性があります。
          受注一覧から選び直してください。
        </Notice>
      </div>
    );
  }

  const customerName = str(order, "customer_name");
  const productName = str(order, "product_name");
  const quantity = num(order, "quantity") || 1;
  const amount = num(order, "amount");
  const shipStatus = str(order, "ship_status");
  const matchStatus = str(order, "match_status");
  const referrerCode = str(order, "referrer_code");
  const reviewResult = str(order, "review_result");
  /**
   * 取り消されたご注文。
   * キャンセルと審査否決は、受注一覧の売上合計・支払対象額・代理店ごとの集計から外している。
   * 判定を一覧（admin/orders/page.tsx）と同じにしておかないと、
   * 一覧では消えているのに詳細では売上のように見える、という食い違いが起きる。
   */
  const voided = shipStatus === "キャンセル" || reviewResult === "否決";
  /** 「キャンセル」「審査否決」「キャンセル・審査否決」。取り消しの理由をそのまま文章に差し込む。 */
  const voidedLabel = [
    shipStatus === "キャンセル" ? "キャンセル" : "",
    reviewResult === "否決" ? "審査否決" : "",
  ]
    .filter(Boolean)
    .join("・");

  /* --- 付随する情報。読めなくても受注そのものは出す --- */
  let rewards: Row[] = [];
  let rewardError: string | null = null;
  let agencies: Row[] = [];
  let agencyError: string | null = null;
  let product: Row | null = null;

  /*
   * 配達完了日は顧客台帳に入っている（受注ではない）。
   * 出荷フォームで直せるように、いまの値をここで読んでおく。
   * 読めなくても画面は出す（配達完了日が空欄で始まるだけ）。
   */
  const customerId = str(order, "customer_id");

  const [rewardResult, agencyResult, productResult, customerResult] =
    await Promise.allSettled([
      select<Row>(`rewards?select=*&order_id=eq.${id}&order=id.asc`),
      select<Row>("agencies?select=code,name,status,code_kind&order=code.asc"),
      /*
       * 商品の引き当ては @/lib/product-match に集約してある。
       * ここだけ商品名の完全一致で引いていると、OP①付きのように
       * 複数商品が1本の名前で届いた受注で「商品マスタに無い」と出てしまい、
       * 実際には報酬が計上されているのに画面では警告になる。
       */
      productName
        ? select<Row>(`products?select=${PRODUCT_COLUMNS}&order=id`).then((all) =>
            buildProductMatcher(all)(
              productName,
              num(order, "amount"),
              num(order, "quantity") || 1,
            )?.row ?? null,
          )
        : Promise.resolve(null),
      customerId
        ? selectOne<Row>(
            `customers?select=delivered_on&id=eq.${encodeURIComponent(customerId)}`,
          )
        : Promise.resolve(null),
    ]);

  const deliveredOn =
    customerResult.status === "fulfilled"
      ? str(customerResult.value, "delivered_on").slice(0, 10)
      : "";

  if (rewardResult.status === "fulfilled") rewards = rewardResult.value;
  else {
    rewardError =
      rewardResult.reason instanceof Error
        ? rewardResult.reason.message
        : "時間をおいて画面を開き直してください。";
  }

  if (agencyResult.status === "fulfilled") agencies = agencyResult.value;
  else {
    agencyError =
      agencyResult.reason instanceof Error
        ? agencyResult.reason.message
        : "時間をおいて画面を開き直してください。";
  }

  if (productResult.status === "fulfilled") product = productResult.value;

  const names = new Map<string, string>();
  for (const a of agencies) names.set(str(a, "code"), str(a, "name"));

  // 紹介元コードの入力候補。解約済みは外す（新しく紹介元に据えることはないため）。
  // コード区分（00=会社 / 01=取次パートナー / 02=スタッフ）も渡す。
  // 担当スタッフの候補をスタッフだけに絞るのに使う。
  const selectable: ReferrerOption[] = agencies
    .filter((a) => str(a, "status") !== "停止・解約" && str(a, "code"))
    .map((a) => ({
      code: str(a, "code"),
      name: str(a, "name"),
      kind: str(a, "code_kind"),
    }));

  const referrerOptions: ReferrerOption[] = selectable.slice(0, 500);
  /**
   * 担当スタッフの入力候補。スタッフ（コード区分 02）だけを出す。
   *
   * 紹介元の候補とは別に作る。同じ配列を使い回すと、上限（500件）に達したときに
   * スタッフが1人も候補に出ない、ということが起こり得るため。
   * コード区分がどこにも入っていない場合は 0 件になってしまうので、
   * そのときは渡さず、入力欄の側で全件を候補にしてもらう。
   */
  const staffOnly = selectable.filter((o) => o.kind === "02").slice(0, 500);
  const staffOptions: ReferrerOption[] | undefined =
    staffOnly.length > 0 ? staffOnly : undefined;

  /* --- 報酬の集計 --- */
  const confirmed = rewards
    .filter((r) => ["確定", "支払済"].includes(str(r, "status")))
    .reduce((s, r) => s + num(r, "amount"), 0);
  const pending = rewards
    .filter((r) => str(r, "status") === "未確定")
    .reduce((s, r) => s + num(r, "amount"), 0);
  const cancelled = rewards.filter((r) => str(r, "status") === "取消").length;

  /**
   * 取り消し扱いの受注に、支払対象のまま残っている報酬。
   *
   * 報酬は受注が登録された時点で「未確定」として立つ（lib/intake.ts の accrueRewards）。
   * それを打ち消すマイナスは、出荷状況をキャンセルにしたときにしか立たない
   * （actions/order-actions.ts の updateShipStatusAction）。
   * 一方で受注一覧は、審査否決の受注も支払対象額から外している。
   * そのため審査否決だけの受注は、一覧では 0 円なのにこの画面には金額が残り、
   * 同じ受注の報酬見込みが一覧と詳細で食い違って見える。
   * 数字そのものを消すかどうかは運用の判断が要るので、ここでは
   * 「支払対象にならない」と断り書きを出して、一覧と読み方を揃える。
   */
  const rewardLeftOver = voided && confirmed + pending > 0;

  const rewardOff = product !== null && str(product, "reward_target") === "対象外";
  const productUnknown = Boolean(productName) && product === null;

  return (
    <div className="space-y-6">
      {header(
        `受注 ${customerName || "（注文者名なし）"} 様`,
        `受注番号 ${id}・${fullDate(str(order, "ordered_on"))} のご注文です。出荷の手配と、売上の付け先の確認を行います。`,
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="ご請求額（税込）"
          value={yen(amount)}
          tone={voided ? "warn" : "gold"}
          hint={
            voided
              ? `${productName || "商品名なし"}・${quantity.toLocaleString("ja-JP")} 台（売上には数えていません）`
              : `${productName || "商品名なし"}・${quantity.toLocaleString("ja-JP")} 台`
          }
        />
        <StatTile
          label="出荷状況"
          value={shipStatus || "未設定"}
          tone={shipStatus === "出荷済" ? "default" : "warn"}
          hint={
            str(order, "shipped_on")
              ? `出荷日 ${fullDate(str(order, "shipped_on"))}`
              : shipStatus === "キャンセル"
                ? "取り消されたご注文です"
                : "まだ出荷していません"
          }
        />
        <StatTile
          label="確定した報酬（税込）"
          value={yen(confirmed)}
          tone={voided ? "warn" : "default"}
          hint={
            rewardError
              ? "報酬を読み込めませんでした"
              : `未確定 ${yen(pending)}${cancelled > 0 ? `・取消 ${cancelled} 件` : ""}${
                  voided ? "（取り消し扱いのため支払対象になりません）" : ""
                }`
          }
        />
      </div>

      {voided ? (
        <Notice tone="bad">
          <p>
            このご注文は{voidedLabel}です。受注一覧の売上合計・支払対象額・代理店ごとの集計には
            数えていません。下の「このご注文から発生した報酬」に金額が残っていても、
            支払対象にはなりません。
            取り消しを取り下げる場合は、下の「出荷を手配する」で出荷状況を、
            「審査結果と紹介元を直す」で審査結果を戻してください。
          </p>
          {shipStatus === "キャンセル" ? (
            <p className="mt-2.5">
              ただし、出荷状況を戻しても、キャンセル時に取り消した報酬は自動では戻りません。
              報酬は下の一覧をご確認のうえ、担当者にご相談ください。
            </p>
          ) : null}
          {rewardLeftOver ? (
            <p className="mt-2.5">
              なお、報酬を打ち消すマイナス（相殺）は、出荷状況をキャンセルにしたときにだけ自動で立ちます。
              そのため下の一覧には、支払対象にならない金額がそのまま残って見えることがあります。
              帳簿の上でも消す場合は、担当者にご相談ください。
            </p>
          ) : null}
        </Notice>
      ) : null}

      <Card title="注文者とお届け先">
        <Fields>
          <Field label="注文者名">{customerName}</Field>
          <Field label="電話番号">
            {str(order, "phone") ? (
              <a
                href={`tel:${str(order, "phone")}`}
                className="tabnum text-ink-100 underline underline-offset-2 hover:text-gold-300"
              >
                {str(order, "phone")}
              </a>
            ) : null}
          </Field>
          <Field label="受注日">{fullDate(str(order, "ordered_on"))}</Field>
          <Field label="郵便番号">
            {str(order, "zip") ? (
              <span className="tabnum">{str(order, "zip")}</span>
            ) : null}
          </Field>
          <Field label="お届け先住所" wide>
            {[str(order, "address"), str(order, "building")].filter(Boolean).join(" ") ||
              null}
          </Field>
          <Field label="顧客台帳の番号">
            {str(order, "customer_id") ? (
              <span className="tabnum">{str(order, "customer_id")}</span>
            ) : (
              <span className="text-ink-500">顧客台帳と結び付いていません</span>
            )}
          </Field>
        </Fields>
      </Card>

      <Card title="商品とお支払い">
        <Fields>
          <Field label="商品名">{productName}</Field>
          <Field label="台数">
            <span className="tabnum">{quantity.toLocaleString("ja-JP")} 台</span>
          </Field>
          <Field label="ご請求額（税込）">
            <span className={cn("tabnum", voided ? "text-ink-500 line-through" : "text-gold-300")}>
              {yen(amount)}
            </span>
          </Field>
          <Field label="お支払い方法">
            {paymentMethodLabel(str(order, "payment_method")) || str(order, "payment_method")}
          </Field>
          {/* 出す言葉は決済方法で変える（振込は着金、アプラスは決済）。一覧と同じ言い方。 */}
          <Field label="お支払い">
            <StatusBadge
              status={
                paymentStatusLabel(
                  str(order, "payment_method"),
                  paymentStatusOf(str(order, "payment_method"), str(order, "payment_status")),
                ) || paymentStatusOf(str(order, "payment_method"), str(order, "payment_status"))
              }
            />
          </Field>
          <Field label="審査結果">
            {reviewResult ? (
              <StatusBadge status={reviewResult} />
            ) : (
              <span className="text-ink-500">まだ結果が入っていません</span>
            )}
          </Field>
          <Field label="信販受付番号">
            {str(order, "credit_ref_no") ? (
              <span className="tabnum">{str(order, "credit_ref_no")}</span>
            ) : null}
          </Field>
          <Field label="カード決済の番号">
            {str(order, "stripe_payment_id") ? (
              <span className="tabnum break-all">{str(order, "stripe_payment_id")}</span>
            ) : null}
          </Field>
          <Field label="継続課金の番号">
            {str(order, "subscription_id") ? (
              <span className="tabnum break-all">{str(order, "subscription_id")}</span>
            ) : null}
          </Field>
          <Field label="初回引き落とし日">
            {str(order, "pad_first_debit_on")
              ? fullDate(str(order, "pad_first_debit_on"))
              : null}
          </Field>
          <Field label="自動引き落としの同意">
            {str(order, "auto_debit_agreed_at")
              ? fullDateTime(str(order, "auto_debit_agreed_at"))
              : null}
          </Field>
          <Field label="付与ポイント">
            {num(order, "points") > 0 ? (
              <span className="tabnum">{num(order, "points").toLocaleString("ja-JP")} pt</span>
            ) : null}
          </Field>
        </Fields>
      </Card>

      <Card title="誰の売上か">
        {agencyError ? (
          <div className="px-5 pt-5">
            <Notice tone="bad">
              代理店マスタを読み込めませんでした。{agencyError}
              <br />
              コードは下に表示していますが、法人名を出せていません。
            </Notice>
          </div>
        ) : null}
        <Fields>
          <Field label="売った代理店">
            <AgencyCell code={str(order, "agency_code")} names={names} />
          </Field>
          <Field label="担当スタッフ">
            <AgencyCell code={str(order, "staff_code")} names={names} />
          </Field>
          {/* データベースの値は「2次代理店」のまま。画面の呼び方だけ labels.ts に揃える。 */}
          <Field label={rankLabel("2次代理店")}>
            <AgencyCell code={str(order, "niji_code")} names={names} />
          </Field>
          <Field label="ゼロ次代理店">
            <AgencyCell code={str(order, "zeroth_code")} names={names} />
          </Field>
          <Field label="紹介元の取次店">
            <AgencyCell code={referrerCode} names={names} />
          </Field>
        </Fields>

        {/*
          決済のときに ?ref= が届かなかった受注は、売上の付け先が空のまま入る。
          あとから本部が入れ直して報酬を立て直せるようにする。
        */}
        <AttributionForm id={String(order["id"])} current={str(order, "agency_code")} />
      </Card>

      <Card title="出荷">
        <Fields>
          <Field label="出荷状況">
            <StatusBadge status={shipStatus} />
          </Field>
          <Field label="送り状番号">
            {str(order, "tracking_no") ? (
              <a
                href={trackingUrl(str(order, "tracking_no"))}
                target="_blank"
                rel="noreferrer"
                title="ヤマト運輸の追跡ページを開きます"
                className="tabnum text-ink-100 underline underline-offset-2 hover:text-gold-300"
              >
                {str(order, "tracking_no")}
              </a>
            ) : null}
          </Field>
          <Field label="出荷日">
            {str(order, "shipped_on") ? fullDate(str(order, "shipped_on")) : null}
          </Field>
        </Fields>
      </Card>

      <ShipForm
        orderId={id}
        shipStatus={shipStatus}
        trackingNo={str(order, "tracking_no")}
        shippedOn={str(order, "shipped_on").slice(0, 10)}
        deliveredOn={deliveredOn}
        reviewResult={str(order, "review_result")}
        creditRefNo={str(order, "credit_ref_no")}
        matchStatus={matchStatus}
        referrerCode={referrerCode}
        referrerOptions={referrerOptions}
        staffCode={str(order, "staff_code")}
        staffOptions={staffOptions}
        paymentMethod={str(order, "payment_method")}
        paymentStatus={str(order, "payment_status")}
        aplusUrlSentAt={str(order, "aplus_url_sent_at")}
      />

      <Card
        title="このご注文から発生した報酬"
        action={
          rewards.length > 0 ? (
            <span className="text-xs text-ink-400">
              {rewards.length.toLocaleString("ja-JP")} 件
            </span>
          ) : null
        }
      >
        {rewardError ? (
          <div className="px-5 py-5">
            <Notice tone="bad">
              報酬を読み込めませんでした。{rewardError}
              <br />
              金額が確かめられないため、この画面での出荷済への変更は、読み込めるようになってから行ってください。
            </Notice>
          </div>
        ) : rewards.length === 0 ? (
          <EmptyState
            title="報酬はまだ計上されていません"
            description={
              rewardOff
                ? `「${productName}」は報酬の対象外に設定されている商品です。そのため、このご注文では報酬が発生しません。`
                : productUnknown
                  ? `「${productName}」が商品マスタに見つかりません。商品名が一致していないと単価を引けず、報酬が立ちません。商品マスタの商品名をご確認ください。`
                  : "報酬は受注が登録されたときに自動で計上されます。計上されていない場合は、受注に代理店コードが入っているか、商品名が商品マスタと一致しているかをご確認ください。"
            }
          />
        ) : (
          <>
            {voided ? (
              <div className="px-5 pt-5">
                <Notice tone="warn">
                  このご注文は{voidedLabel}（取り消し扱い）のため、
                  ここに出ている報酬は支払対象になりません。
                  受注一覧の支払対象額でも 0 円として扱っています。
                </Notice>
              </div>
            ) : null}
            <Table>
            <thead>
              <tr>
                <Th>受け取る代理店</Th>
                <Th>ランク</Th>
                <Th>種別</Th>
                <Th>対象月</Th>
                <Th align="right">金額（税込）</Th>
                <Th>状態</Th>
                <Th>確定日</Th>
                <Th>支払日</Th>
              </tr>
            </thead>
            <tbody>
              {rewards.map((r) => {
                const code = str(r, "agency_code");
                const amountValue = num(r, "amount");
                const cancelledRow = str(r, "status") === "取消" || amountValue < 0;
                return (
                  <tr key={str(r, "id")} className={cn(cancelledRow && "bg-bad-500/5")}>
                    <Td>
                      <AgencyCell code={code} names={names} />
                    </Td>
                    <Td>{str(r, "agency_rank") ? rankShort(str(r, "agency_rank")) : "—"}</Td>
                    <Td>{str(r, "kind") || "—"}</Td>
                    <Td numeric className="whitespace-nowrap">
                      {str(r, "month") ? jpMonthLabel(str(r, "month")) : "—"}
                    </Td>
                    <Td
                      numeric
                      align="right"
                      className={cn(
                        "whitespace-nowrap font-medium",
                        amountValue < 0 ? "text-bad-100" : "text-ink-50",
                      )}
                    >
                      {yen(amountValue)}
                    </Td>
                    <Td>
                      <StatusBadge status={str(r, "status")} />
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {str(r, "confirmed_on") ? fullDate(str(r, "confirmed_on")) : "—"}
                    </Td>
                    <Td numeric className="whitespace-nowrap">
                      {str(r, "paid_on") ? fullDate(str(r, "paid_on")) : "—"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <Td className="font-semibold text-ink-100">合計</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
                <Td
                  numeric
                  align="right"
                  className={cn(
                    "font-semibold",
                    voided ? "text-ink-500 line-through" : "text-gold-400",
                  )}
                >
                  {yen(confirmed + pending)}
                </Td>
                <Td className="text-xs text-ink-400">
                  確定 {yen(confirmed)} / 未確定 {yen(pending)}
                </Td>
                <Td>{null}</Td>
                <Td>{null}</Td>
              </tr>
            </tfoot>
            </Table>
          </>
        )}
        {rewards.length > 0 ? (
          <p className="border-t border-ink-800 px-5 py-3.5 text-xs leading-relaxed text-ink-400">
            報酬は出荷済にした時点で確定します。キャンセルにすると、同額のマイナスを立てて相殺します
            （支払済のぶんを消すと帳簿が合わなくなるため、行そのものは残します）。
            {voided
              ? "このご注文は取り消し扱いのため、上の金額は支払対象になりません。"
              : ""}
          </p>
        ) : null}
      </Card>

      {str(order, "note") || str(order, "status_history") ? (
        <Card title="備考と履歴">
          <Fields>
            <Field label="備考" wide>
              {str(order, "note") ? (
                <span className="whitespace-pre-wrap">{str(order, "note")}</span>
              ) : null}
            </Field>
            <Field label="これまでの経緯" wide>
              {str(order, "status_history") ? (
                <span className="whitespace-pre-wrap">{str(order, "status_history")}</span>
              ) : null}
            </Field>
          </Fields>
        </Card>
      ) : null}
    </div>
  );
}
