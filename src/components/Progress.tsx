import { Badge, cn } from "@/components/ui";
import { paymentStatusOf, reviewStatusLabel } from "@/lib/payment-status";

/**
 * 申込から商品のお届けまでの進み具合。
 *
 * 2026-04-23 の打ち合わせで「自分が獲得したお客様が今どこまで進んでいるか、
 * その場で分かるようにしてほしい」という要望が出ている。
 * 段階と割合は設計書の取り決め（申込20 → 審査完了40 → 出荷手配中60 →
 * 出荷済80 → 配達完了100）を土台に、2026-08-27 の会議で「決済完了（着金）」を
 * 審査と出荷の間に足した（申込20 → 審査完了40 → 決済完了50 → 出荷手配中60 →
 * 出荷済80 → 配達完了100）。銀行振込・アプラスは、お金が届くまでここで止まる。
 *
 * 判定のもとになるのは受注の「審査結果」「出荷状況」と、顧客台帳の「配達完了日」。
 * どの画面でも同じ言い方・同じ割合になるように、判定はこのファイルに集める。
 */

export type ProgressStep = {
  key: string;
  label: string;
  percent: number;
};

export const PROGRESS_STEPS: readonly ProgressStep[] = [
  { key: "applied", label: "申込", percent: 20 },
  { key: "reviewed", label: "審査完了", percent: 40 },
  { key: "paid", label: "決済完了", percent: 50 },
  { key: "arranging", label: "出荷手配中", percent: 60 },
  { key: "shipped", label: "出荷済", percent: 80 },
  { key: "delivered", label: "配達完了", percent: 100 },
];

export type ProgressSource = {
  /** 受注の審査結果（承認 / 否決 / 電話確認待ち）。 */
  reviewResult?: string | null;
  /** 受注の出荷状況（出荷待ち / 出荷手配中 / 出荷済 / キャンセル）。 */
  shipStatus?: string | null;
  /** 顧客台帳の配達完了日。入っていればお届け済み。 */
  deliveredOn?: string | null;
  /** 受注の決済方法（Stripe / 振込 / アプラス など）。審査の有無の判定に使う。 */
  paymentMethod?: string | null;
  /** 受注のお支払い状況（着金待ち / 決済完了）。空なら決済方法から補う。 */
  paymentStatus?: string | null;
};

/** 進んでいる途中か、途中で止まったか。 */
export type ProgressState =
  | {
      stopped: false;
      /** いまの段階の呼び名（例:「出荷手配中」）。 */
      label: string;
      percent: number;
      /** 何が起きているかの説明。 */
      note: string;
      /** 次に進む段階。最後まで進んでいれば null。 */
      next: string | null;
    }
  | {
      stopped: true;
      /** 止まった理由の見出し（例:「キャンセル」）。 */
      label: string;
      note: string;
    };

const clean = (v: string | null | undefined): string => (v ?? "").trim();

function stepAt(key: string): ProgressStep {
  return PROGRESS_STEPS.find((s) => s.key === key) ?? PROGRESS_STEPS[0];
}

function nextLabelAfter(key: string): string | null {
  const i = PROGRESS_STEPS.findIndex((s) => s.key === key);
  if (i < 0 || i >= PROGRESS_STEPS.length - 1) return null;
  return PROGRESS_STEPS[i + 1].label;
}

function advancing(key: string, note: string): ProgressState {
  const step = stepAt(key);
  return {
    stopped: false,
    label: step.label,
    percent: step.percent,
    note,
    next: nextLabelAfter(key),
  };
}

/** 受注1件の進み具合を判定する。 */
export function progressOf(src: ProgressSource): ProgressState {
  const ship = clean(src.shipStatus);
  const review = clean(src.reviewResult);
  const delivered = clean(src.deliveredOn);
  const reviewLabel = reviewStatusLabel(src.paymentMethod, review);
  const paid = paymentStatusOf(src.paymentMethod, src.paymentStatus) === "決済完了";

  // 途中で止まったもの。棒を伸ばさず、止まったことが分かる形で出す。
  if (ship === "キャンセル") {
    return {
      stopped: true,
      label: "キャンセル",
      note: "この申込は取り消されています。詳しくは本部にお問い合わせください。",
    };
  }
  if (review === "否決") {
    return {
      stopped: true,
      label: "審査が通りませんでした",
      note: "信販会社の審査が通らなかったため、この申込はここで止まっています。",
    };
  }

  if (delivered) {
    return advancing("delivered", "商品のお届けが完了しました。");
  }
  if (ship === "出荷済") {
    return advancing(
      "shipped",
      "商品を発送しました。お届けの状況は送り状番号から確認できます。",
    );
  }
  if (ship === "出荷手配中") {
    return advancing("arranging", "発送の準備をしています。");
  }
  /*
   * 出荷前は「審査 → 決済（着金） → 出荷」の順に見る。
   * 銀行振込・アプラスは、審査が済んでいてもお金が届くまでは
   * 「審査完了」で止め、着金の確認待ちであることを伝える。
   */
  if (reviewLabel === "審査完了") {
    if (paid) {
      return advancing("paid", "お支払いを確認しました。発送の手配をお待ちください。");
    }
    return advancing(
      "reviewed",
      "審査は完了しています。ご入金（着金）の確認待ちです。",
    );
  }
  if (review === "電話確認待ち") {
    return advancing(
      "applied",
      "信販会社からお客様へ、お電話での確認が入る段階です。",
    );
  }
  return advancing("applied", "お申込みを受け付けました。審査の結果をお待ちください。");
}

/**
 * 進み具合を横棒で見せる。
 * compact は一覧の列に入れるとき用（説明文を省く）。
 */
export function Progress({
  reviewResult,
  shipStatus,
  deliveredOn,
  paymentMethod,
  paymentStatus,
  compact = false,
  className,
}: ProgressSource & { compact?: boolean; className?: string }) {
  const state = progressOf({ reviewResult, shipStatus, deliveredOn, paymentMethod, paymentStatus });

  if (state.stopped) {
    return (
      <div className={cn("min-w-[9rem]", className)}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="bad">中止</Badge>
          <span className="text-sm font-medium text-ink-200">{state.label}</span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{state.note}</p>
      </div>
    );
  }

  const done = state.percent >= 100;

  return (
    <div className={cn("min-w-[9rem]", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "text-sm font-medium",
            done ? "text-good-100" : "text-ink-100",
          )}
        >
          {state.label}
        </span>
        <span className="tabnum text-xs text-ink-400">{state.percent}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.percent}
        aria-label={`進み具合：${state.label}`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800"
      >
        <div
          className={cn(
            "h-full rounded-full transition-all",
            done ? "bg-good-500" : "bg-brand",
          )}
          style={{ width: `${state.percent}%` }}
        />
      </div>

      {compact ? (
        state.next ? (
          <p className="mt-1.5 text-xs text-ink-500">次は「{state.next}」</p>
        ) : null
      ) : (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{state.note}</p>
      )}
    </div>
  );
}

/** 段階の並びと割合の説明。一覧の下に添えて、棒の読み方を示す。 */
export function ProgressLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-ink-400">
      {PROGRESS_STEPS.map((step, i) => (
        <span key={step.key} className="flex items-center gap-2">
          <span className="whitespace-nowrap">
            {step.label}
            <span className="tabnum ml-1 text-ink-500">{step.percent}%</span>
          </span>
          {i < PROGRESS_STEPS.length - 1 ? (
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

/** ヤマト運輸の荷物追跡ページのアドレスを作る。 */
export function yamatoTrackingUrl(trackingNo: string): string {
  return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=${encodeURIComponent(
    trackingNo.trim(),
  )}`;
}
