/* ------------------------------------------------------------------
 * 一覧画面の「並び替え」と「絞り込み」を、URL のクエリだけで扱うための道具。
 *
 * 状態をすべて URL に持たせているので、
 *   ・画面はサーバーコンポーネントのままでよい
 *   ・絞り込んだ状態のまま URL を人に渡せる
 *   ・戻るボタンで一つ前の条件に戻れる
 * という利点がある。ここには表示に関わるものは置かない（部品は
 * src/components/SortableTh.tsx）。
 * ------------------------------------------------------------------ */

/** await 済みの searchParams。値は文字列か、同名が複数あるときは配列で届く。 */
export type SearchParams = Record<string, string | string[] | undefined>;

/** 並び替えの状態。 */
export type SortState = {
  /** 並び替えに使っている列の名前（画面ごとに決めた短い英字） */
  column: string;
  /** true なら降順（大きい順・新しい順）、false なら昇順 */
  desc: boolean;
};

/** 並び替えに使うクエリの名前。画面ごとにばらつかないようここで決める。 */
export const SORT_KEY = "sort";
export const DIR_KEY = "dir";

/** 絞り込みの「すべて」を表す合図。 */
export const ALL = "all";

/* ---------- クエリを読む ---------- */

/** クエリを1つ、文字列で取り出す。同じ名前が複数届いたら最初のものを使う。 */
export function readParam(params: SearchParams, key: string): string {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 決められた選択肢のどれかであればその値を、そうでなければ「すべて」を返す。
 * URL を手で書き換えられても、知らない値で絞り込んでしまわないようにする。
 */
export function readChoice(
  params: SearchParams,
  key: string,
  allowed: readonly string[],
): string {
  const value = readParam(params, key);
  return value && allowed.includes(value) ? value : ALL;
}

/**
 * 並び替えの指定を読む。
 * 列の名前が分からないとき（初回表示・URL が壊れているとき）は既定に戻す。
 */
export function parseSort(
  params: SearchParams,
  fallback: SortState,
  allowed?: readonly string[],
): SortState {
  const column = readParam(params, SORT_KEY);
  if (!column) return fallback;
  if (allowed && !allowed.includes(column)) return fallback;
  return { column, desc: readParam(params, DIR_KEY) === "desc" };
}

/* ---------- URL を組み立てる ---------- */

/**
 * いまのクエリを引き継ぎつつ、一部だけ差し替えた URL を作る。
 * 差し替える値が空文字か undefined なら、そのクエリは付けない（＝解除）。
 */
export function buildListHref(
  basePath: string,
  params: SearchParams,
  patch: Record<string, string | undefined> = {},
): string {
  const next = new URLSearchParams();
  for (const key of Object.keys(params)) {
    if (key in patch) continue;
    const value = readParam(params, key);
    if (value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * 見出しを押したときの遷移先。
 * 同じ列をもう一度押したら昇順と降順が入れ替わり、別の列なら昇順から始まる。
 */
export function buildSortHref(
  basePath: string,
  params: SearchParams,
  column: string,
  current: SortState,
): string {
  const desc = current.column === column ? !current.desc : false;
  return buildListHref(basePath, params, {
    [SORT_KEY]: column,
    [DIR_KEY]: desc ? "desc" : "asc",
  });
}

/* ---------- 並び替える ---------- */

/** 並び替えに使える値。null と undefined と空文字は「空欄」として扱う。 */
export type SortValue = string | number | null | undefined;

/** 列の名前から、その行の値を取り出す方法を並べたもの。 */
export type Accessors<T> = Record<string, (row: T) => SortValue>;

function isBlank(v: SortValue): boolean {
  return v === null || v === undefined || v === "";
}

/** 数値どうしは数として、それ以外は日本語として自然な順で比べる。 */
function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ja");
}

/**
 * 行を並び替えた新しい配列を返す（元の配列は変えない）。
 *
 * ・空欄は昇順でも降順でも必ず末尾に置く
 *   （「未入力の行が上に溜まって邪魔」を避けるため）
 * ・同じ値のときは元の並び順のままにする
 */
export function sortRows<T>(
  rows: readonly T[],
  column: string,
  desc: boolean,
  accessors: Accessors<T>,
): T[] {
  const pick = accessors[column];
  if (!pick) return [...rows];

  return rows
    .map((row, index) => ({ row, index, value: pick(row) }))
    .sort((a, b) => {
      const aBlank = isBlank(a.value);
      const bBlank = isBlank(b.value);
      if (aBlank && bBlank) return a.index - b.index;
      if (aBlank) return 1;
      if (bBlank) return -1;
      const result = compareValues(a.value, b.value);
      if (result !== 0) return desc ? -result : result;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/* ---------- キーワード検索 ---------- */

/** 電話番号や送り状番号は書き方がぶれるので、数字だけにして比べる。 */
export function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * 渡した項目のどれかにキーワードが含まれていれば当たり。
 * キーワードが空なら全部当たりにする（絞り込まない）。
 * 数字だけのキーワードは、ハイフン入りの番号にも当たるようにしている。
 */
export function matchesKeyword(
  keyword: string,
  fields: (string | null | undefined)[],
): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  const kwDigits = digitsOf(kw);
  for (const field of fields) {
    if (!field) continue;
    const value = field.toLowerCase();
    if (value.includes(kw)) return true;
    if (kwDigits.length >= 2 && digitsOf(value).includes(kwDigits)) return true;
  }
  return false;
}

/* ---------- 絞り込みの選択肢 ---------- */

/** 絞り込みの選択肢1つぶん。count はその値に当てはまる件数。 */
export type FilterOption = { value: string; label: string; count: number };

/**
 * 選択肢を作る。
 * 決まった選択肢（known）を先に並べ、データにしか無い値をその後ろに足す。
 * いま選ばれている値は、件数が 0 でも必ず残す（自分で外せなくなるため）。
 */
export function buildOptions<T>(
  rows: readonly T[],
  pick: (row: T) => string,
  known: readonly string[] = [],
  selected = ALL,
): FilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = pick(row).trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const values: string[] = [];
  for (const value of known) if (!values.includes(value)) values.push(value);
  for (const value of counts.keys()) if (!values.includes(value)) values.push(value);
  if (selected !== ALL && selected && !values.includes(selected)) values.push(selected);

  return values.map((value) => ({
    value,
    label: value,
    count: counts.get(value) ?? 0,
  }));
}
