/**
 * QRコードの発行にまつわる決まりごとと、QR画像の作成。
 *
 *   QR1 … 体験・デモのご案内（公式LINEの友だち追加）
 *   QR2 … ご契約・お支払いのご案内（決済フォーム）
 *
 * 紹介元（どの代理店からのお客様か）が当システムに残るのは QR2 の決済フォームと
 * ご紹介（トスアップ）フォームだけ。QR1 の友だち追加は LINE の中で完結するため、
 * URL に付けた代理店コードはこちらへは戻ってこない（下の withRef を参照）。
 *
 * 本部の画面（ブラウザ側）からも、保存処理（サーバー側）からも
 * まったく同じ判断を使いたいので、このファイルはデータベースにも
 * Node の機能にも触らない。読み書きは actions 側で行う。
 *
 * QR画像は外部のQR作成サービスに頼らず、この中で組み立てる。
 * 代理店コードの入ったURLを社外のサーバーへ渡さずに済むため。
 */

/* ═══════════════════ 案内先のURL ═══════════════════ */

/**
 * QR1（体験・デモのご案内）。公式LINEの友だち追加。
 * 友だち追加は LINE の中で完結するため、このURLからは紹介元を記録できない。
 */
export const QR1_BASE_URL = "https://lin.ee/nJTVC5A";

/**
 * QR2（ご契約・お支払いのご案内）。
 *
 * 2026-08-27 から、決済フォーム直行ではなく「ご購入メニュー」
 * （新規購入／パット追加購入(１年分) の選択ページ）を入り口にする。
 * ?ref= の代理店コードは、メニューページに入れた引き継ぎの仕掛けが
 * そのまま次のページへ運ぶので、紹介元の記録はこれまでどおり残る。
 * 旧URL: https://line.metore0403.com/p/fXEUN6pjHMRW（決済フォーム直行）
 */
export const QR2_BASE_URL = "https://line.metore0403.com/p/gjC5XREoMWMs";

/**
 * 取次パートナーにご案内する共通の公式LINE。
 * 取次パートナーには個別のQRを出さない決まりのため、紹介元は付けない。
 */
export const OFFICIAL_LINE_URL = QR1_BASE_URL;

/**
 * 取次パートナーがお客様をご紹介（トスアップ）するときのフォーム。
 * 本部から配布されたフォームのURLを環境変数 NEXT_PUBLIC_TOSS_FORM_URL に
 * 入れておくと、取次店コードごとの専用URLを作れる。
 * 未設定のときは空文字を返し、画面では「本部よりご案内します」と出す。
 *
 * ★ NEXT_PUBLIC_ で始まる値は、画面を組み立てるとき（ビルド時）に埋め込まれる。
 *   あとから値を入れ替えても、作り直し（再デプロイ）をしないと画面には出てこない。
 *   書き方の例は .env.local.example を見ること。
 */
export const TOSS_FORM_BASE_URL = (process.env.NEXT_PUBLIC_TOSS_FORM_URL ?? "").trim();

/**
 * ご紹介フォームで取次店コードを受け取る欄の名前。
 * フォーム側（JotForm）の「固有名」と完全に一致していないと、
 * どの取次パートナーからのご紹介か記録されない。
 */
export const TOSS_FORM_CODE_KEY = "agency_id";

/** フォームのURLの中で、取次店コードに置き換わる目印。 */
const TOSS_CODE_MARK = "{code}";

export type QrKind = "qr1" | "qr2";

export const QR_LABEL: Record<QrKind, string> = {
  qr1: "QR1（体験のご案内）",
  qr2: "QR2（ご契約のご案内）",
};

/* ═══════════════════ 代理店の見かた ═══════════════════ */

/**
 * 画面や保存処理から渡してもらう代理店。
 *
 * 受け取れるのは、代理店マスタから読んだ行（列名そのまま）だけ。
 * lib/agencies.ts が返す形は渡せない。あちらは codeKind / status /
 * qr1Url / qr2Url しか持っておらず、研修の合否（training_status）も
 * 発行申請の状況（qr2_status）も入っていないため、渡してしまうと
 * 「お渡しの状態を読み取れませんでした」と誤って表示される。
 * 取り違えをその場で気づけるよう、判断に使う項目は必須にしてある。
 *
 * 見るのは次の項目だけ:
 *   code / name / code_kind / status / training_status / training_passed_on /
 *   qr2_status / qr2_requested_on / qr2_rejected_note / qr1_url / qr2_url
 */
export type QrSource = {
  /** 代理店コード */
  code: unknown;
  /** 代理店名。無くても発行の可否は変わらないので任意。 */
  name?: unknown;
  /** 00＝会社 / 01＝取次パートナー / 02＝スタッフ */
  code_kind: unknown;
  /** 未稼働 / 稼働中 / 停止・解約 */
  status: unknown;
  /** 未受講 / 受講中 / 合格 / 不合格 */
  training_status: unknown;
  training_passed_on?: unknown;
  /** 未申請 / 申請中 / 承認済 / 差戻し */
  qr2_status: unknown;
  qr2_requested_on?: unknown;
  qr2_rejected_note?: unknown;
  qr1_url?: unknown;
  qr2_url?: unknown;
};

/** QRの画面で使う形にそろえた代理店。 */
export type QrAgency = {
  code: string;
  name: string;
  /** 00＝会社 / 01＝取次パートナー / 02＝スタッフ */
  codeKind: string;
  status: string;
  trainingStatus: string;
  trainingPassedOn: string;
  qr2Status: string;
  qr2RequestedOn: string;
  qr2RejectedNote: string;
  qr1Url: string;
  qr2Url: string;
};

/** 研修に合格している状態の呼び名。 */
export const TRAINING_PASSED = "合格";

/**
 * QR2 のお渡しの状態。
 *
 * 2026-08-21 に申請・承認の運用はやめた（登録した時点でお渡しする）。
 * 「未申請」「申請中」はそれ以前に登録された行に残っているだけで、
 * 新しく書き込むことはない。「差戻し」は QR の停止に使い続けている。
 */
export const QR2_UNAPPLIED = "未申請";
export const QR2_APPLIED = "申請中";
export const QR2_APPROVED = "承認済";
export const QR2_REJECTED = "差戻し";

/**
 * 研修の状況・発行申請の状況を読み取れなかったときの表し方。
 *
 * 代理店マスタでは、研修は「未受講」、発行申請は「未申請」が必ず入っている。
 * つまり空で返ってきたときは「まだ受けていない・まだ申請が無い」のではなく、
 * 読み取れていない。ここを「未受講」「未申請」で埋めてしまうと、
 * 研修に合格し承認も済んでいる代理店に「合格していません」「申請が届いていません」と
 * 出してしまうため、必ず別の言い方にして取り違えを防ぐ。
 */
export const STATUS_UNREADABLE = "読み取れませんでした";

function pick(source: QrSource, key: keyof QrSource): string {
  const v = source[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

/** 渡された代理店を、この画面で扱う形にそろえる。 */
export function readQrAgency(source: QrSource): QrAgency {
  return {
    code: pick(source, "code"),
    name: pick(source, "name"),
    codeKind: pick(source, "code_kind"),
    status: pick(source, "status"),
    // 空のときは「未受講」「未申請」で埋めない。読み取れていないことを残す。
    trainingStatus: pick(source, "training_status") || STATUS_UNREADABLE,
    trainingPassedOn: pick(source, "training_passed_on"),
    qr2Status: pick(source, "qr2_status") || STATUS_UNREADABLE,
    qr2RequestedOn: pick(source, "qr2_requested_on"),
    qr2RejectedNote: pick(source, "qr2_rejected_note"),
    qr1Url: pick(source, "qr1_url"),
    qr2Url: pick(source, "qr2_url"),
  };
}

/*
 * ここから下の判断は、代理店マスタの行そのものではなく、
 * readQrAgency でそろえた形（QrAgency）だけを受け取る。
 * 読み取りの入口を readQrAgency の一か所にまとめておくと、
 * 項目の足りないものを判断に回してしまう取り違えが起きない。
 */

/**
 * 取次パートナー（コード区分 01）かどうか。
 * 取次パートナーには個別のQRを発行しない（2026-08-07 会議で確定）。
 */
export function isTossPartner(a: QrAgency): boolean {
  return a.codeKind === "01";
}

/**
 * この相手に個別のQRを発行してよいか。
 * 取次パートナーには発行しない。共通の公式LINEとご紹介フォームをご案内する。
 */
export function canIssueQr(a: QrAgency): boolean {
  if (!a.code) return false;
  if (a.codeKind === "01") return false;
  return true;
}

/**
 * 研修に合格しているか。
 * 2026-08-21 から QR2 の条件ではない（記録として残すだけ）。
 */
export function isTrainingPassed(a: QrAgency): boolean {
  return a.trainingStatus === TRAINING_PASSED;
}

/**
 * QR2 をいま発行できない理由。発行できるときは null。
 * 画面の出し分けにも、保存前の確認にも同じものを使う。
 *
 * 2026-08-21 決定：研修の合否と本部の承認は、QR2 の条件にしない。
 * 登録した時点で QR1・QR2 の両方をお渡しする運用に変わったため。
 * 止めるのは「取次パートナー（個別QRを出さない決まり）」と
 * 「停止・解約」、それに QR の停止中（frozenBlocker が別に見る）だけ。
 */
export function qr2Blocker(a: QrAgency): string | null {
  if (a.codeKind === "01") {
    return "取次パートナーには個別のQRを発行しません。共通の公式LINEとご紹介フォームをご案内してください。";
  }
  if (a.status === "停止・解約") {
    return "停止・解約の登録には発行できません。稼働状況をご確認ください。";
  }
  return null;
}

/** QR1 をいま発行できない理由。発行できるときは null。 */
export function qr1Blocker(a: QrAgency): string | null {
  if (a.codeKind === "01") {
    return "取次パートナーには個別のQRを発行しません。共通の公式LINEとご紹介フォームをご案内してください。";
  }
  if (a.status === "停止・解約") {
    return "停止・解約の登録には発行できません。稼働状況をご確認ください。";
  }
  return null;
}

/* ═══════════════════ URLの組み立て ═══════════════════ */

/**
 * URLの末尾に「名前＝値」をひとつ足す。
 * すでに ? が付いていれば & でつなぎ、# から後ろはいちばん最後に回す。
 */
function withParam(base: string, key: string, encodedValue: string): string {
  const hashAt = base.indexOf("#");
  const head = hashAt >= 0 ? base.slice(0, hashAt) : base;
  const hash = hashAt >= 0 ? base.slice(hashAt) : "";
  const sep = head.includes("?") ? "&" : "?";
  return `${head}${sep}${key}=${encodedValue}${hash}`;
}

/**
 * 末尾に ?ref=代理店コード を付ける。
 *
 * このコードが紹介元として当システムに残るのは、送信内容が当システムに届く導線だけ:
 *   ・QR2（決済フォーム）… 決済完了のお知らせで ref を受け取り、受注の紹介元にする
 *
 * QR1（公式LINEの友だち追加）は LINE の中で完結し、URL に付けたコードは
 * 当システムには届かない。QR1 のコードは、どの代理店にお渡ししたURLかを
 * 本部で見分けるための目印であって、紹介元の記録には使えない。
 *
 * ご紹介（トスアップ）フォームは受け取る欄の名前が ref ではないため、
 * こちらではなく下の tossUpUrl を使う。
 */
function withRef(base: string, code: string): string {
  const ref = encodeURIComponent(code.trim());
  if (!ref) return base;
  return withParam(base, "ref", ref);
}

/**
 * QR1 / QR2 のご案内URLを作る。
 * お渡ししたURLを本部で見分けられるよう、どちらにも代理店コードを付ける。
 * ただし紹介元として記録できるのは QR2 の方だけ（withRef の説明を参照）。
 */
export function buildQrUrl(kind: QrKind, code: string): string {
  return withRef(kind === "qr2" ? QR2_BASE_URL : QR1_BASE_URL, code);
}

/**
 * 取次パートナー専用の、お客様ご紹介（トスアップ）フォームのURL。
 *
 * 取次店コードの差し込み方は2通り。
 *   ・URLの中に {code} と書いてある … そこを取次店コードに置き換える
 *   ・書いていない … 末尾に ?agency_id=取次店コード を足す
 *
 * フォーム側の受け取り欄の名前（JotForm の「固有名」）が agency_id と
 * 食い違っていると、コードは素通りして紹介元が記録されない。
 * 別の名前を使っているフォームなら、URL に {code} を入れて設定すること。
 *   例: https://form.jotform.com/＜フォームID＞?partner={code}
 *
 * URLが未設定のときは空文字を返す（画面では本部よりご案内する旨を出す）。
 */
export function tossUpUrl(code: string): string {
  if (!TOSS_FORM_BASE_URL) return "";
  const value = encodeURIComponent(code.trim());
  if (!value) return TOSS_FORM_BASE_URL;
  if (TOSS_FORM_BASE_URL.includes(TOSS_CODE_MARK)) {
    return TOSS_FORM_BASE_URL.split(TOSS_CODE_MARK).join(value);
  }
  return withParam(TOSS_FORM_BASE_URL, TOSS_FORM_CODE_KEY, value);
}

/* ═══════════════════ QR画像の作成 ═══════════════════ */

/**
 * URLをQRコードの白黒の並びに変換する。
 *
 * 規格（ISO/IEC 18004）どおりの手順。
 *   1. バイトモードで文字を詰める
 *   2. 誤り訂正（レベルM・25%まで復元できる）の符号を付ける
 *   3. ブロックに分けて並べ替える
 *   4. 位置検出パターンなどの決まった模様を置く
 *   5. 8種類のマスクを試して、いちばん読み取りやすいものを選ぶ
 *
 * 読み取れないQRを配ると現場が止まるため、外注せずここで作る。
 */

/** 誤り訂正レベルM。1ブロックあたりの訂正符号の数（型番1〜40）。 */
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** 誤り訂正レベルM。ブロックの数（型番1〜40）。 */
const ECC_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18,
  20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

function bit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

/** 型番ごとの、模様に使われない部分のマス数。 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 型番ごとに入れられるデータの数（誤り訂正の分を除く）。 */
function dataCodewords(version: number): number {
  const total = Math.floor(rawDataModules(version) / 8);
  return total - ECC_PER_BLOCK_M[version] * ECC_BLOCKS_M[version];
}

/** 位置合わせパターンの座標。 */
function alignPositions(version: number): number[] {
  if (version === 1) return [];
  const num = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 17 - 13) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < num; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/* --- 誤り訂正の計算（ガロア体 GF(256)） --- */

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function eccDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function eccRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/* --- 文字を数値の並びに変える --- */

function toUtf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** バイトモードの文字数を表すのに使うビット数。 */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const capacity = dataCodewords(v) * 8;
    if (4 + countBits(v) + byteLength * 8 <= capacity) return v;
  }
  throw new Error("QRコードに収まらない長さのURLです。");
}

function encodeData(bytes: number[], version: number): number[] {
  const bits: boolean[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push(bit(value, i));
  };

  push(0b0100, 4); // バイトモード
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(false);
  while (bits.length % 8 !== 0) bits.push(false);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | (bits[i + j] ? 1 : 0);
    words.push(w);
  }
  for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    words.push(pad);
  }
  return words;
}

/** ブロックに分けて誤り訂正を付け、規格どおりの順番に並べ替える。 */
function addEcc(data: number[], version: number): number[] {
  const blockCount = ECC_BLOCKS_M[version];
  const eccLen = ECC_PER_BLOCK_M[version];
  const totalWords = Math.floor(rawDataModules(version) / 8);
  const shortCount = blockCount - (totalWords % blockCount);
  const shortLen = Math.floor(totalWords / blockCount);
  const divisor = eccDivisor(eccLen);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const len = shortLen - eccLen + (i < shortCount ? 0 : 1);
    const part = data.slice(k, k + len);
    k += len;
    const ecc = eccRemainder(part, divisor);
    if (i < shortCount) part.push(0); // 並べ替えのときの穴埋め
    blocks.push(part.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortCount) result.push(block[i]);
    });
  }
  return result;
}

/* --- マス目に並べる --- */

type Grid = boolean[][];

function buildMatrix(words: number[], version: number): Grid {
  const size = version * 4 + 17;
  const modules: Grid = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const reserved: Grid = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const setFn = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // タイミングパターン（点線）。先に引いて、隅の模様で上書きする。
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 位置検出パターン（3隅の大きな四角）と、その周りの余白
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // 位置合わせパターン
  const positions = alignPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(
            positions[i] + dx,
            positions[j] + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }

  // 形式情報・型番情報の置き場所を先に押さえる（6行目・6列目は点線なので触らない）
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    setFn(8, i, false);
    setFn(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFn(size - 1 - i, 8, false);
    setFn(8, size - 1 - i, false);
  }
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = bit(bits, i);
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      setFn(a, c, b);
      setFn(c, a, b);
    }
  }

  // データを右下からジグザグに置く
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && idx < words.length * 8) {
          modules[y][x] = bit(words[idx >>> 3], 7 - (idx & 7));
          idx++;
        }
      }
    }
  }

  // 8種類のマスクを試し、いちばん読みやすいものを選ぶ
  let best: Grid = modules;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    applyMask(candidate, reserved, mask);
    drawFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function applyMask(grid: Grid, reserved: Grid, mask: number): void {
  const size = grid.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) grid[y][x] = !grid[y][x];
    }
  }
}

/** 形式情報（誤り訂正レベルとマスク番号）を書き込む。 */
function drawFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const data = (0b00 << 3) | mask; // 00 = 誤り訂正レベルM
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;

  for (let i = 0; i <= 5; i++) grid[i][8] = bit(bits, i);
  grid[7][8] = bit(bits, 6);
  grid[8][8] = bit(bits, 7);
  grid[8][7] = bit(bits, 8);
  for (let i = 9; i < 15; i++) grid[8][14 - i] = bit(bits, i);

  for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = bit(bits, i);
  for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = bit(bits, i);
  grid[size - 8][8] = true; // 必ず黒いマス
}

/* --- マスクの良し悪しを点数にする（規格の4つの規則） --- */

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

function countFinderLike(history: number[]): number {
  const n = history[1];
  const core =
    n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (
    (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  );
}

function addHistory(size: number, runLength: number, history: number[]): void {
  if (history[0] === 0) runLength += size; // 外側の白い余白ぶん
  history.pop();
  history.unshift(runLength);
}

function finishRun(
  size: number,
  runDark: boolean,
  runLength: number,
  history: number[],
): number {
  let length = runLength;
  if (runDark) {
    addHistory(size, length, history);
    length = 0;
  }
  length += size;
  addHistory(size, length, history);
  return countFinderLike(history);
}

function penalty(grid: Grid): number {
  const size = grid.length;
  let result = 0;

  for (let y = 0; y < size; y++) {
    let runDark = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (grid[y][x] === runDark) {
        runLength++;
        if (runLength === 5) result += N1;
        else if (runLength > 5) result++;
      } else {
        addHistory(size, runLength, history);
        if (!runDark) result += countFinderLike(history) * N3;
        runDark = grid[y][x];
        runLength = 1;
      }
    }
    result += finishRun(size, runDark, runLength, history) * N3;
  }

  for (let x = 0; x < size; x++) {
    let runDark = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (grid[y][x] === runDark) {
        runLength++;
        if (runLength === 5) result += N1;
        else if (runLength > 5) result++;
      } else {
        addHistory(size, runLength, history);
        if (!runDark) result += countFinderLike(history) * N3;
        runDark = grid[y][x];
        runLength = 1;
      }
    }
    result += finishRun(size, runDark, runLength, history) * N3;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = grid[y][x];
      if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) {
        result += N2;
      }
    }
  }

  let dark = 0;
  for (const row of grid) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * N4;
}

/* --- 外から使うところ --- */

/** URLをQRコードのマス目（true が黒）に変換する。 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = toUtf8(text);
  const version = chooseVersion(bytes.length);
  const words = addEcc(encodeData(bytes, version), version);
  return buildMatrix(words, version);
}

export type QrSvgOptions = {
  /** 1マスの大きさ（ピクセル）。 */
  scale?: number;
  /** 周囲の余白（マス数）。読み取りには最低4マス必要。 */
  margin?: number;
  /** 黒いマスの色。 */
  dark?: string;
  /** 背景の色。白のままにしておくと読み取りやすい。 */
  light?: string;
};

/** QRコードを SVG の文字列にする。 */
export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const scale = options.scale ?? 8;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? "#0a0a0b";
  const light = options.light ?? "#ffffff";

  const grid = qrMatrix(text);
  const side = grid.length + margin * 2;
  const px = side * scale;

  let path = "";
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid.length; x++) {
      if (grid[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${side}" height="${side}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

/**
 * QRの画像URL。そのまま <img src> に入れて表示・保存できる。
 * 外部のQR作成サービスには送らない（代理店コード入りのURLを社外に出さないため）。
 * 作れなかったときは空文字を返すので、呼び出し側でURLの文字だけ見せること。
 */
export function qrImageUrl(url: string, options: QrSvgOptions = {}): string {
  const text = (url ?? "").trim();
  if (!text) return "";
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text, options))}`;
  } catch {
    return "";
  }
}
