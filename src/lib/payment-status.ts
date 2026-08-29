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

/**
 * アプラスの申込URLがまだ送られていないか。
 *
 * アプラスはAPIで連携できないので、担当者がお客様へ申込URLをメールで送る。
 * 送れていないと、審査が始まらないまま受注が着金待ちで止まり、
 * 誰も気づかないまま日にちだけが過ぎる。一覧で目印を出すために使う。
 * アプラス以外の決済方法では、そもそも送るものが無いので false。
 */
export function aplusUrlPending(
  method: string | null | undefined,
  sentAt: string | null | undefined,
): boolean {
  return isLoanMethod(method) && !(sentAt ?? "").trim();
}

/**
 * お支払いを手で変えてよい決済方法か。
 *
 * クレジットカード（Stripe・スクエア）は、決済が済んでから通知が届く。
 * 手で変えられるようにすると、まだ払われていないものを「決済完了」にできて
 * しまうので、こちらは変えさせない。
 *
 * 決済方法が記録されていない受注・お客様は、変えられる側に入れる。
 * クレジットカードなら自動で決済完了になっているはずで、
 * 着金待ちのまま残っているのは振込・アプラスのほうだから。
 * ここを「記録が無ければ変えられない」にすると、
 * 決済方法を写す前に入った古いお客様を本部が直せなくなる。
 */
export function isManualPaymentMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").trim();
  return !INSTANT_METHODS.includes(m);
}
