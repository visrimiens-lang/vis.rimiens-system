/**
 * 決済方法・審査・お支払いの言葉を1か所にまとめる。
 *
 * 2026-08-27 の会議で、受注に3つのステータスを持たせることが決まった。
 *   決済方法 … 銀行振込／クレジットカード／アプラス（QR2 の選択から自動で入る）
 *   審査　　 … 審査中／審査完了（アプラス＝信販だけ審査がある。手で変えられる）
 *   お支払い … 着金待ち／決済完了（クレジットカードは自動で決済完了。
 *              銀行振込とアプラスは着金待ちから始まり、本部が確認して完了にする）
 *
 * 画面ごとに判定がずれると、本部と代理店で違うステータスが見える。
 * 判定はすべてここを通す。サーバー・クライアントの両方から使うので
 * server-only にはしない。
 */

/** お支払いのステータス。orders.payment_status に入る値。 */
export const PAYMENT_STATUSES = ["着金待ち", "決済完了"] as const;

/** 審査がある決済方法（信販・ローン）。 */
const LOAN_METHODS = ["アプラス", "九州信販", "ライフカード"];

/** その場で決済が終わる決済方法。 */
const INSTANT_METHODS = ["Stripe", "スクエア"];

export function isLoanMethod(method: string | null | undefined): boolean {
  return LOAN_METHODS.includes((method ?? "").trim());
}

/**
 * 画面に出す決済方法の呼び名。
 * 保存値は決済サービス名（Stripe など）だが、お客様や代理店に見せる言葉は
 * 会議で決まった3つ（銀行振込・クレジットカード・アプラス）にそろえる。
 */
export function paymentMethodLabel(method: string | null | undefined): string {
  const m = (method ?? "").trim();
  if (!m) return "";
  if (m === "Stripe" || m === "スクエア") return "クレジットカード";
  if (m === "振込") return "銀行振込";
  return m;
}

/**
 * 受注が入った時点のお支払いステータス。
 *   クレジットカード（Stripe・スクエア）… 決済が済んでから通知が来るので「決済完了」
 *   銀行振込・代引き・信販　　　　　　 … お金はまだ動いていないので「着金待ち」
 *   決済方法が読めなかったとき　　　　 … これまでどおり「決済完了」扱い（止めない）
 */
export function initialPaymentStatus(method: string | null | undefined): string {
  const m = (method ?? "").trim();
  if (!m || INSTANT_METHODS.includes(m)) return "決済完了";
  return "着金待ち";
}

/**
 * 画面に出すお支払いステータス。
 * 保存値があればそれ、無ければ決済方法から見た初期値
 * （payment_status の列ができる前の受注も、それらしく出すため）。
 */
export function paymentStatusOf(
  method: string | null | undefined,
  stored: string | null | undefined,
): string {
  const s = (stored ?? "").trim();
  return s || initialPaymentStatus(method);
}

/**
 * 画面に出す審査ステータス。
 *   否決 　　　　　　　　　　… そのまま「否決」（行はキャンセル扱いで赤くなる）
 *   承認 　　　　　　　　　　… 「審査完了」
 *   信販で、結果がまだ無い　 … 「審査中」（電話確認待ちも審査の途中）
 *   信販以外で、結果が無い　 … 審査そのものが無いので「審査完了」
 */
export function reviewStatusLabel(
  method: string | null | undefined,
  reviewResult: string | null | undefined,
): string {
  const r = (reviewResult ?? "").trim();
  if (r === "否決") return "否決";
  if (r === "承認") return "審査完了";
  if (r === "電話確認待ち") return "審査中";
  return isLoanMethod(method) ? "審査中" : "審査完了";
}
