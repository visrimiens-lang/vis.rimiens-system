/**
 * 振込先の確認。画面（admin/rewards）とサーバー（reward-actions）の両方が使う。
 *
 * 判定を2か所に別々に書くと「画面では押せるのに保存で断られる」か、
 * その逆が起きるので、ここにだけ置く。
 *
 * ■ そろっているかだけでなく、口座番号の形も見る
 *
 * 以前は「4項目が空でないか」しか見ていなかったため、
 * ダミーの口座（番号 00000000001・名義が別人）がそのまま支払済みにできた。
 * 実在しない口座への振込記録が作れると、支払管理の最後の砦が働かない。
 *
 * 日本の銀行の口座番号は最大7桁（短いものは前に0を詰める）。
 * ゆうちょ銀行も振込用の番号は7桁に直して使うので、
 * 数字7桁を超える番号は入力の誤りかダミーとみなして止める。
 * 全部同じ数字（0000000 など）も実在しないので止める。
 */

export type BankFields = {
  bankName: string;
  bankBranch: string;
  accountNo: string;
  accountHolder: string;
};

/**
 * 口座番号として通せない理由。通せるときは空。
 *
 * 理由を分けて返す。ひとまとめに「7桁までの数字になっていません」と出していたころ、
 * 0000000（7桁の数字）を入れた方が「正しく入れているのにエラーになる」と詰まった。
 * 何が引っかかったのかが分からないと直しようがない。
 */
export function accountNoProblem(accountNo: string): string {
  const digits = (accountNo || "").replace(/[^0-9]/g, "");
  if (digits.length < 4 || digits.length > 7) {
    return "口座番号（半角の数字4〜7桁で入力してください）";
  }
  if (/^(\d)\1+$/.test(digits)) {
    return "口座番号（0000000 のように同じ数字だけの番号は、実在しない口座とみなして登録できません）";
  }
  return "";
}

/** 口座番号として通せる形か。 */
export function accountNoLooksReal(accountNo: string): boolean {
  return accountNoProblem(accountNo) === "";
}

/** 振込先がそろっていて、支払済みにしてよいか。 */
export function bankReady(b: BankFields | null): boolean {
  return Boolean(
    b &&
      b.bankName &&
      b.bankBranch &&
      b.accountNo &&
      b.accountHolder &&
      accountNoLooksReal(b.accountNo),
  );
}

/** 振込先のうち、何が足りない・おかしいのか。画面の案内に使う。 */
export function missingBankFields(b: BankFields | null): string[] {
  if (!b) return ["金融機関名", "支店名", "口座番号", "口座名義"];
  const missing: string[] = [];
  if (!b.bankName) missing.push("金融機関名");
  if (!b.bankBranch) missing.push("支店名");
  if (!b.accountNo) missing.push("口座番号");
  else {
    const problem = accountNoProblem(b.accountNo);
    if (problem) missing.push(problem);
  }
  if (!b.accountHolder) missing.push("口座名義");
  return missing;
}
