/**
 * 旧い代理店コードを、いまのコードに読み替える表。
 *
 * 2026-10-29 に総販売代理店のコードを RIM → RIMI に変えた（4文字にそろえるため）。
 * データベースの中身は SQL で一括で置き換えたが、外の世界には旧コードが残り続ける。
 *
 *   ・配り済みの QR コード（?ref=RIM）
 *   ・代理店が覚えているログインID
 *   ・ブラウザに残っているログイン中の Cookie（viewer.code = "RIM"）
 *   ・申込フォームの招待コード欄に手で打つ文字
 *
 * これらを「知らないコード」として弾くと、売上の付け先が空のまま受注だけが積み上がる
 * （intake.ts の normalizeCode の説明と同じ事故）。入口で必ずここを通して、
 * 照合そのものは完全一致のままにする。
 *
 * 表に足すときは「旧コード → 新コード」の向きで、どちらも大文字で書く。
 * 部分一致はしない（RIM0001 のような、旧コードで始まる別のコードには影響しない）。
 */
export const LEGACY_CODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  RIM: "RIMI",
});

/**
 * 旧コードならいまのコードに読み替え、それ以外はそのまま返す。
 *
 * 大文字小文字は無視して突き合わせる（"rim" も RIMI になる）が、
 * 表に無いコードには手を加えない。全角の変換や空白の除去は normalizeCode の仕事。
 */
export function canonicalCode(code: string): string {
  const key = (code || "").toUpperCase();
  return LEGACY_CODE_ALIASES[key] ?? code;
}

/** 旧コード（読み替えの対象）かどうか。画面で「旧コードで開かれた」と気づくために使う。 */
export function isLegacyCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_CODE_ALIASES, (code || "").toUpperCase());
}

/**
 * あるコードを DB で引くときに試す綴りを、優先順に返す。
 *
 * 改名の前後で DB の中身が違う（SQL を流す前は旧コード、流した後は新コード）。
 * コードの配備と SQL の実行は同時にできないので、その間も壊れないように
 * 「新コードで引いて、無ければ旧コードで引く」を1回の問い合わせ（code=in.(…)）で済ませる。
 *
 *   codeCandidates("RIM")  → ["RIMI", "RIM"]
 *   codeCandidates("RIMI") → ["RIMI", "RIM"]
 *   codeCandidates("MENO") → ["MENO"]
 *
 * 見つかった行の code（DB に実際に入っている綴り）をそのまま使うこと。
 * 読み替え後の文字を書き込むと、SQL を流す前の期間に新コードの行ができてしまい、
 * `= '旧コード'` でしか置換しない SQL がその行を見落とす。
 */
export function codeCandidates(code: string): string[] {
  const canonical = canonicalCode(code);
  const legacy = Object.entries(LEGACY_CODE_ALIASES)
    .filter(([, to]) => to === canonical.toUpperCase())
    .map(([from]) => from);
  return legacy.length > 0 ? [canonical, ...legacy] : [code];
}

/**
 * 候補の中から、DB で見つかった行を優先順（新コード → 旧コード）で1つ選ぶ。
 * 新旧が両方あることは SQL のガードで防いでいるが、万一あっても新コードの行を使う。
 */
export function pickByCandidates<T extends Record<string, unknown>>(
  rows: T[],
  candidates: string[],
): T | null {
  for (const c of candidates) {
    const hit = rows.find((r) => String(r["code"] ?? "") === c);
    if (hit) return hit;
  }
  return null;
}
