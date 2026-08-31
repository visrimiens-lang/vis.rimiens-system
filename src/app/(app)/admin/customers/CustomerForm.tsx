"use client";

import {
  isManualPaymentMethod,
  paymentMethodLabel,
  paymentStatusLabel,
} from "@/lib/payment-status";
import { Fragment, useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import {
  setCustomerPaymentStatusAction,
  stopPadSubscriptionAction,
  updateCustomerAction,
  type CustomerFormState,
} from "@/actions/customer-actions";
import {
  Progress,
  yamatoTrackingUrl,
  type ProgressSource,
} from "@/components/Progress";
import Link from "next/link";
import { Badge, Notice, Td, jpDate } from "@/components/ui";

/* ------------------------------------------------------------------
 * 本部の「顧客管理」の、行の表示と修正フォーム。
 *
 * 直せるのは連絡先・お届け先と、担当スタッフのコードだけにしてある。
 * 担当代理店・紹介元のコードは報酬の支払先に直結するため、
 * この画面からは変えられない（変更が必要なときは本部内で相談する）。
 *
 * 担当スタッフだけ直せるようにしているのは、2026-08-07 の打合せで出た
 * 「誰が売ったかを追えない」への対応。お申し込みの取り込みでは入らない列なので、
 * 本部が聞き取って埋める場所がないと、一覧に出しても空欄のまま残ってしまう。
 * この列は報酬の計算には使っていない。
 * ------------------------------------------------------------------ */

/**
 * 担当スタッフのコードの入力候補（datalist）の id。
 * 候補そのものは一覧側（page.tsx）が画面に1つだけ置く。
 * 修正欄はお客様の人数ぶん作られるので、行ごとに候補を持たせると同じ一覧を何度も送ることになる。
 */
export const STAFF_CODE_LIST_ID = "staff-code-candidates";

/** 一覧に出すために必要なぶんだけを持つ、お客様1名ぶんの内容。 */
export type CustomerView = {
  id: string;
  name: string;
  nameKana: string;
  email: string;
  phone: string;
  zip: string;
  address: string;
  building: string;
  receiptName: string;
  note: string;
  /** 紹介元（取次店）のコード。空なら一般のお申し込み。 */
  referrerCode: string;
  agencyCode: string;
  staffCode: string;
  reviewStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  contractedOn: string;
  shipStatus: string;
  trackingNo: string;
  /** 配達が終わった日。入っていれば進み具合は「配達完了」。 */
  deliveredOn: string;
  serialNo: string;
  /** Stripe上の定期パッド配送の契約ID。自動課金が仕込めたお客様に入る */
  padSubscriptionId: string;
  /** 定期パッド配送の初回請求予定日（1年後／OP①付きは2年後） */
  padChargeFrom: string;
};

type Tone = "neutral" | "good" | "warn" | "bad" | "gold";

const initial: CustomerFormState = {};

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";
const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-3 py-1.5 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";

/* ---------- 検索窓 ---------- */

/**
 * お名前と電話番号でお客様を探す。
 * 送信すると /admin/customers?keyword=… に移動するだけの小さな部品で、
 * 絞り込みそのものはサーバー側で行っている。
 */
export function CustomerSearch({ keyword, kind }: { keyword: string; kind: string }) {
  const router = useRouter();
  const [value, setValue] = useState(keyword);

  const go = (next: string) => {
    const params = new URLSearchParams();
    if (kind && kind !== "all") params.set("kind", kind);
    const k = next.trim();
    if (k) params.set("keyword", k);
    const qs = params.toString();
    router.push(qs ? `/admin/customers?${qs}` : "/admin/customers");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go(value);
      }}
      className="flex items-center gap-2"
      role="search"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          name="keyword"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="お名前・電話番号で探す"
          aria-label="お名前または電話番号で検索"
          className="w-64 rounded-lg border border-ink-700 bg-ink-900 py-2 pl-9 pr-8 text-sm text-ink-100 placeholder:text-ink-400 focus:border-ink-600"
        />
        {value ? (
          <button
            type="button"
            aria-label="検索条件を消す"
            onClick={() => {
              setValue("");
              go("");
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 transition hover:text-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <button
        type="submit"
        className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 transition hover:bg-ink-700"
      >
        検索
      </button>
    </form>
  );
}

/* ---------- 状態の色分け ---------- */

function paymentTone(v: string): Tone {
  if (v === "決済完了") return "good";
  if (v === "否決・キャンセル") return "bad";
  // 着金待ちなどは「まだお金が届いていない」ので注意色
  return "warn";
}

function shipTone(v: string): Tone {
  if (v === "出荷済") return "good";
  if (v === "出荷手配中") return "warn";
  return "neutral";
}

/**
 * 「お支払い」の欄。
 *
 * 銀行振込・アプラスは、本部が着金を確認して手で「決済完了」に変える。
 * その確認はこの一覧を眺めながら行うので、ここで直せないと受注詳細まで
 * 開き直すことになり、変え忘れが出る（2026-08-27 の打合せ）。
 *
 * クレジットカードは決済が済んでから通知が届くので、いつでも決済完了。
 * 手で変えられるようにすると、払われていないものを完了にできてしまうため、
 * 表示だけにして選べないようにしている。
 *
 * 選んだ時点で保存する。押し忘れる保存ボタンを増やさないため。
 */
/**
 * お支払いの状態を切り替える、横並びの2択。
 *
 * はじめはブラウザ標準の <select> を使っていたが、開いたあとの一覧は
 * OS が描くため Mac と Windows で見た目が変わり、Windows では
 * 背景も文字色も指定が効かず読みにくかった。
 *
 * そこで自前の一覧を出す形にしたところ、今度は位置合わせで手こずった。
 * 表は横スクロールする入れ物の中にあり、しかも transform の掛かった親が
 * いるため、fixed で置いても基準がずれて画面の外へ出てしまう。
 *
 * 選ぶものが2つしかないので、開くのをやめて横に並べる。
 * 開かなければ位置合わせは要らず、どの環境でも同じに見える。
 * いま選ばれている側だけ色を付ける（着金待ちは赤、決済完了は緑）。
 */
function StatusToggle({
  value,
  options,
  disabled,
  onPick,
  label,
}: {
  value: string;
  options: { value: string; label: string; tone: "good" | "bad" }[];
  disabled?: boolean;
  onPick: (next: string) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-lg border border-ink-700 bg-ink-900"
    >
      {options.map((o) => {
        const on = o.value === value;
        const tone = on
          ? o.tone === "good"
            ? "bg-good-500/25 text-good-100"
            : "bg-bad-500/25 text-bad-100"
          : "text-ink-400 hover:bg-ink-800 hover:text-ink-200";
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled || on}
            onClick={() => onPick(o.value)}
            className={
              "whitespace-nowrap px-2.5 py-1.5 text-sm font-semibold leading-tight " +
              "transition focus:outline-none focus:ring-2 focus:ring-inset " +
              "focus:ring-gold-500/40 disabled:cursor-default " +
              tone
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PaymentStatusCell({
  customerId,
  paymentStatus,
  paymentMethod,
  onPicked,
}: {
  customerId: string;
  paymentStatus: string;
  paymentMethod: string;
  /**
   * 選んだ直後に親へ知らせる。
   * 進み具合はお支払いの状態で変わるので、保存の返事を待たずにその場で動かす。
   * 待たせると「変えたのに棒が動かない」と見え、二度押しされる。
   */
  onPicked: (next: string) => void;
}) {
  /*
   * <form action={...}> は使わない。
   *
   * React はサーバーの処理が終わったあとフォームを初期化する。
   * 選ぶ欄は親の状態で値を決めているのに、初期化で DOM だけが先頭の
   * 「着金待ち」に戻され、色は「決済完了」のまま文字だけ戻る、という
   * ちぐはぐな見え方になっていた（2026-08-31）。
   * ここでは選んだ値を直接サーバーへ渡し、初期化を起こさない。
   */
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const method = (paymentMethod ?? "").trim();
  const methodLabel = paymentMethodLabel(method) || method;
  const editable = isManualPaymentMethod(method);

  if (!editable) {
    return (
      <div className="whitespace-nowrap">
        <Status
          value={paymentStatusLabel(method, paymentStatus) || paymentStatus}
          tone={paymentTone(paymentStatus)}
        />
      </div>
    );
  }

  /*
   * 着金待ちは赤、決済完了は緑。
   * この欄は本部が着金を確認して回すためのもので、
   * 赤が残っている行＝まだお金が届いていない行として一目で拾えるようにする。
   */
  const done = paymentStatus === "決済完了";

  function pick(next: string) {
    onPicked(next);
    setError("");
    const data = new FormData();
    data.set("customerId", customerId);
    data.set("paymentStatus", next);
    startTransition(async () => {
      const res = await setCustomerPaymentStatusAction({}, data);
      if (res.error) setError(res.error);
    });
  }

  return (
    <div className="whitespace-nowrap">
      {/*
        出す言葉は決済方法で変える（振込は着金、アプラスは決済）。
        保存する値は「着金待ち／決済完了」のままで、見せ方だけを変えている。
      */}
      <StatusToggle
        label="お支払いの状態"
        value={done ? "決済完了" : "着金待ち"}
        disabled={pending}
        onPick={pick}
        options={[
          { value: "着金待ち", label: paymentStatusLabel(method, "着金待ち"), tone: "bad" },
          { value: "決済完了", label: paymentStatusLabel(method, "決済完了"), tone: "good" },
        ]}
      />
      {pending ? <div className="mt-1 text-xs text-ink-400">保存中…</div> : null}
      {error ? (
        <div className="mt-1 text-xs leading-snug text-bad-500">{error}</div>
      ) : null}
    </div>
  );
}

/**
 * 1年後の定期パッド配送の状態と、解約ボタン。
 *
 * 本体をご購入のお客様は、1年後（OP①付きは2年後）から毎年17,500円の
 * 定期パッド配送が始まる。クレジットカードのお客様は Stripe に自動で
 * 契約が作られ、振込・アプラスのお客様は請求予定日だけが残る（手動請求）。
 * 解約は公式LINEで受け、本部がこのボタンで止める。
 */
function PadSubscriptionRow({ customer }: { customer: CustomerView }) {
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(
    stopPadSubscriptionAction,
    {},
  );
  const [confirmed, setConfirmed] = useState(false);

  if (!customer.padSubscriptionId && !customer.padChargeFrom) return null;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs leading-relaxed">
      <div className="font-semibold text-ink-200">定期パッド配送（17,500円/年・税込）</div>
      {customer.padSubscriptionId ? (
        <>
          <p className="mt-1 text-ink-400">
            {customer.padChargeFrom ? `${jpDate(customer.padChargeFrom)} から` : "期日が来ると"}
            自動で請求されます。解約のお申し出があったときだけ、下で止めてください。
          </p>
          <form action={formAction} className="mt-2 flex flex-wrap items-center gap-3">
            <input type="hidden" name="customerId" value={customer.id} />
            <label className="flex items-center gap-1.5 text-ink-300">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={pending}
              />
              解約のお申し出を確認しました
            </label>
            <button
              type="submit"
              disabled={pending || !confirmed}
              className="rounded-md border border-bad-500/60 px-3 py-1 font-semibold text-bad-500 transition hover:bg-bad-500/10 disabled:opacity-50"
            >
              {pending ? "停止中…" : "定期を解約する"}
            </button>
          </form>
        </>
      ) : (
        <p className="mt-1 text-ink-400">
          {jpDate(customer.padChargeFrom)} が初回の請求予定日です。カードのご登録が無いため
          自動では請求されません。期日になったら本部から請求書をお送りください。
        </p>
      )}
      {state.error ? <p className="mt-1 text-bad-500">{state.error}</p> : null}
      {state.ok ? <p className="mt-1 text-ink-300">{state.ok}</p> : null}
    </div>
  );
}

function Status({ value, tone }: { value: string; tone: Tone }) {
  if (!value) return <span className="text-ink-400">—</span>;
  return <Badge tone={tone}>{value}</Badge>;
}

/* ---------- 一覧の1行 ---------- */

/**
 * 表の1行と、「登録内容を直す」で開く修正欄。
 * 修正欄は行のすぐ下に開くので、どのお客様を直しているかを見失わない。
 */
export function CustomerRow({
  customer,
  agencyName,
  referrerName,
  staffName,
  staffCompany,
  progress,
  introduced,
}: {
  customer: CustomerView;
  /** 担当代理店の名前（代理店マスタから引いたもの）。 */
  agencyName: string;
  /** 紹介元の取次店の名前（代理店マスタから引いたもの）。 */
  referrerName: string;
  /** 担当スタッフの名前（代理店マスタから引いたもの）。無ければ空。 */
  staffName: string;
  /** 担当スタッフが属している会社の名前。紹介元の欄に添える。 */
  staffCompany: string;
  /**
   * 進み具合のもとになる状態。
   * 顧客台帳と受注では言葉が違う（審査完了／承認）ため、
   * 言い換えは一覧側（page.tsx）でまとめて行い、ここは受け取って出すだけにする。
   */
  progress: ProgressSource;
  /** 取次店からの紹介かどうか。判定は一覧側でまとめて行っている。 */
  introduced: boolean;
}) {
  /*
   * お支払いの状態は、この行の中で持つ。
   *
   * 保存はサーバー側で行うが、その返事を待って画面を作り直すと、
   * 選んでから進み具合の棒が動くまで間が空く。
   * 「変えたのに反映されない」と見えるので、選んだ時点でここを更新し、
   * 進み具合も一緒に動かす（2026-08-31 の依頼）。
   * 保存に失敗したときは PaymentStatusCell が理由を出す。
   */
  const [payStatus, setPayStatus] = useState(customer.paymentStatus);

  return (
    <Fragment>
      <tr>
        {/* お名前からその方の詳細ページへ。受注一覧の注文者名と同じ操作にそろえる。 */}
        <Td>
          <div className="min-w-0">
            <Link
              href={`/admin/customers/${encodeURIComponent(customer.id)}`}
              className="block max-w-full truncate font-medium text-ink-100 underline underline-offset-4 transition hover:text-gold-300"
            >
              {customer.name || "（お名前未登録）"}
            </Link>
            {customer.nameKana ? (
              <div className="truncate text-xs text-ink-400">{customer.nameKana}</div>
            ) : null}
          </div>
        </Td>
        <Td className="whitespace-nowrap">
          <span className="tabnum">{customer.phone || "—"}</span>
          {customer.email ? (
            <div className="mt-1 max-w-[14rem] truncate text-xs text-ink-400" title={customer.email}>
              {customer.email}
            </div>
          ) : null}
        </Td>
        <Td>
          {customer.agencyCode ? (
            <div className="min-w-0">
              <div className="tabnum truncate text-ink-200">{customer.agencyCode}</div>
              {agencyName ? (
                <div className="truncate text-xs text-ink-400">{agencyName}</div>
              ) : (
                <div className="truncate text-xs text-ink-500">代理店一覧に該当なし</div>
              )}
            </div>
          ) : (
            <span className="text-ink-400">—</span>
          )}
        </Td>
        {/* 2026-08-07 の打合せで「誰が売ったかを追えない」との指摘があったため、
            担当スタッフのコードを一覧に出す。名前は代理店マスタから引く。 */}
        <Td>
          {customer.staffCode ? (
            <div className="min-w-0">
              <div className="tabnum truncate text-ink-200">{customer.staffCode}</div>
              {staffName ? (
                <div className="truncate text-xs text-ink-400">{staffName}</div>
              ) : (
                <div className="truncate text-xs text-ink-500">代理店一覧に該当なし</div>
              )}
            </div>
          ) : (
            <span className="text-ink-500">未記録</span>
          )}
        </Td>
        {/*
          紹介元。取次店から紹介された分はそのコードを出す。
          そうでない分は「一般」だけだと誰が売ったのか読み取れないので、
          担当スタッフの所属会社を添える（2026-08-31 の依頼）。
        */}
        <Td>
          {introduced ? (
            <div className="min-w-0">
              <Badge tone="gold">取次店の紹介</Badge>
              <div className="tabnum mt-1 truncate text-xs text-ink-300">
                {customer.referrerCode}
                {referrerName ? `　${referrerName}` : ""}
              </div>
            </div>
          ) : staffCompany ? (
            /* 取次店の紹介でないときは所属会社だけを出す。
               「一般」の札は、会社名が出ていれば言い足す意味がない。 */
            <div className="min-w-0 truncate text-ink-200" title={staffCompany}>
              {staffCompany}
            </div>
          ) : (
            <span className="text-ink-500">—</span>
          )}
        </Td>
        <Td>
          <Progress {...progress} paymentStatus={payStatus} compact />
        </Td>
        {/* 決済方法は絞り込みにも使うので、お支払いとは別の列に分けて出す */}
        <Td className="whitespace-nowrap text-ink-200">
          {paymentMethodLabel(customer.paymentMethod) || "—"}
        </Td>
        <Td>
          <PaymentStatusCell
            customerId={customer.id}
            paymentStatus={payStatus}
            paymentMethod={customer.paymentMethod}
            onPicked={setPayStatus}
          />
        </Td>
        <Td>
          <Status value={customer.shipStatus} tone={shipTone(customer.shipStatus)} />
          {/* 送り状番号が入っていれば、そのままヤマト運輸の追跡ページを開けるようにする。
              本部が番号を写して検索しなおす手間をなくすため。 */}
          {customer.trackingNo ? (
            <a
              href={yamatoTrackingUrl(customer.trackingNo)}
              target="_blank"
              rel="noopener noreferrer"
              title="ヤマト運輸の荷物追跡ページを新しいタブで開きます"
              className="tabnum mt-1 block whitespace-nowrap text-xs text-gold-300 underline underline-offset-2 transition hover:text-gold-200"
            >
              {customer.trackingNo}
              <span className="ml-1 text-ink-400">お届け状況</span>
            </a>
          ) : null}
        </Td>
        <Td numeric className="whitespace-nowrap">
          {fullDate(customer.contractedOn)}
        </Td>
        <Td align="right">
          <Link
            href={`/admin/customers/${encodeURIComponent(customer.id)}`}
            className={quietBtn}
          >
            詳細を見る
          </Link>
        </Td>
      </tr>

    </Fragment>
  );
}


/**
 * お客様1名ぶんの登録内容を直す欄。
 *
 * もとは一覧の行の下に開くアコーディオンだったが、
 * 詳細は専用ページ（/admin/customers/[id]）で見る形に変えたので、
 * ここは中身だけを持つ部品にして、そのページから使う。
 */
export function CustomerEditForm({
  customer,
  staffName = "",
}: {
  customer: CustomerView;
  /** 担当スタッフの名前（代理店マスタから引いたもの）。案内文に添える。 */
  staffName?: string;
}) {
  const [state, save, saving] = useActionState(updateCustomerAction, initial);

  return (
    <div>
        <form action={save} className="space-y-4">
          <input type="hidden" name="id" value={customer.id} />

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className={labelCls}>お名前</span>
              <input
                type="text"
                name="name"
                required
                maxLength={100}
                defaultValue={customer.name}
                disabled={saving}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className={labelCls}>フリガナ</span>
              <input
                type="text"
                name="nameKana"
                maxLength={100}
                defaultValue={customer.nameKana}
                disabled={saving}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className={labelCls}>電話番号</span>
              <input
                type="tel"
                name="phone"
                maxLength={30}
                defaultValue={customer.phone}
                disabled={saving}
                placeholder="090-1234-5678"
                className={`${inputCls} tabnum`}
              />
              <span className={hintCls}>
                出荷やお届けの連絡に使います。半角の数字とハイフンで入力してください。
              </span>
            </label>
            <label className="block">
              <span className={labelCls}>メールアドレス</span>
              <input
                type="email"
                name="email"
                maxLength={200}
                defaultValue={customer.email}
                disabled={saving}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className={labelCls}>郵便番号</span>
              <input
                type="text"
                name="zip"
                maxLength={8}
                defaultValue={customer.zip}
                disabled={saving}
                placeholder="123-4567"
                className={`${inputCls} tabnum max-w-[10rem]`}
              />
            </label>
            <label className="block">
              <span className={labelCls}>領収書のあて名</span>
              <input
                type="text"
                name="receiptName"
                maxLength={100}
                defaultValue={customer.receiptName}
                disabled={saving}
                className={inputCls}
              />
              <span className={hintCls}>
                お名前と違うあて名をご希望のときだけ入力してください。
              </span>
            </label>
          </div>

          <label className="block">
            <span className={labelCls}>住所</span>
            <input
              type="text"
              name="address"
              maxLength={200}
              defaultValue={customer.address}
              disabled={saving}
              placeholder="都道府県から番地まで"
              className={inputCls}
            />
            <span className={hintCls}>
              ここがお届け先になります。出荷前であれば、直した住所で発送されます。
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>建物名・部屋番号</span>
            <input
              type="text"
              name="building"
              maxLength={100}
              defaultValue={customer.building}
              disabled={saving}
              className={inputCls}
            />
          </label>

          <label className="block">
            <span className={labelCls}>本部メモ</span>
            <textarea
              name="note"
              rows={3}
              maxLength={2000}
              defaultValue={customer.note}
              disabled={saving}
              placeholder="やり取りの経緯など、本部で共有しておきたいことを書いてください。"
              className={`${inputCls} resize-y leading-relaxed`}
            />
            <span className={hintCls}>
              代理店の画面には出ません。本部の担当者だけが見られます。
            </span>
          </label>

          {/* 「誰が売ったか」を後からでも埋められるようにする欄。
              一覧の「担当スタッフ」列が空欄の方を、本部が聞き取って入れる想定。 */}
          <label className="block md:max-w-sm">
            <span className={labelCls}>担当スタッフのコード</span>
            <input
              type="text"
              name="staffCode"
              list={STAFF_CODE_LIST_ID}
              maxLength={20}
              defaultValue={customer.staffCode}
              disabled={saving}
              placeholder="例：ABCD0001"
              className={`${inputCls} tabnum`}
            />
            <span className={hintCls}>
              このお申し込みを取った方のコードです。入力欄を押すと、登録されているコードから選べます。
              分からないときは空のままにしてください。
              {customer.staffCode
                ? staffName
                  ? `　いまの登録：${customer.staffCode}（${staffName}）`
                  : `　いまの登録：${customer.staffCode}（このコードは代理店一覧に見当たりません）`
                : ""}
            </span>
          </label>

          <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs leading-relaxed text-ink-400">
            担当代理店（{customer.agencyCode || "未設定"}）と紹介元（
            {customer.referrerCode || "なし"}）は、報酬のお支払い先に直結するため、
            この画面からは変えられません。付け替えが必要なときは本部内でご相談ください。
            また、お客様の登録を消すことはできません。
            {customer.serialNo ? `　製造番号：${customer.serialNo}` : ""}
            {customer.trackingNo ? `　送り状番号：${customer.trackingNo}` : ""}
          </div>

          <PadSubscriptionRow customer={customer} />

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving ? "保存中…" : "この内容で保存する"}
            </button>
          </div>
        </form>

      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/** 年をまたぐ台帳なので、日付は年まで出す。 */
function fullDate(v: string): string {
  if (!v) return "—";
  return `${v.slice(0, 4)}/${jpDate(v)}`;
}
