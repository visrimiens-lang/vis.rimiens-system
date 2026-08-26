import "server-only";
import { audit, insert, inList, select, selectAll, selectOne, update } from "./db";
import { todayInJapan } from "./jst";
import { AMOUNT_COLUMNS, PRODUCT_COLUMNS, buildProductMatcher, type MatchHow } from "./product-match";

/**
 * 報酬の計上。
 *
 * これまで Make のシナリオ#11 がやっていたことを、ここに持ってきた。
 *
 * 考え方（2026-07-09 回答書・2026-08-07 会議）:
 *   ・1件の受注から、階層ごとに複数の報酬が同時に発生する
 *     （例：2次代理店の報酬と、紹介した取次店の報酬）
 *   ・単価は商品マスタに入っている。ランクごとに額が違う
 *   ・報酬が確定するのは「配送完了」のとき
 *   ・キャンセルや否決になったら、その報酬を打ち切る。
 *     すでに振り込んだぶんだけ、同額のマイナスを立てて次の振込から差し引く（赤伝票）。
 *     まだ振り込んでいないぶんは「取消」にするだけで、マイナスは立てない
 *     （立てると、払ってもいない額を次の振込から差し引くことになるため）。
 *   ・振り込んだ事実は、あとから何が起きても消さない。
 *     支払済の報酬は status を「取消」に書き換えず「支払済」のまま残す
 *     （書き換えると支払管理の「支払済合計」からその額が消え、
 *     「支払済を取り消す」ボタンも出なくなって、振込の記録をたどれなくなる）
 */

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};
const n_ = (r: Row | null, k: string): number => {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

/** rewards.status に入る値（保存先の制約と同じ。これ以外は入れない）。 */
const PAID = "支払済";
const CANCELLED = "取消";

/**
 * 金額の書き方。画面部品（@/components/ui の yen）と同じ形にそろえてある。
 * ここはサーバー専用の処理なので、画面部品そのものは読み込まない。
 */
function yen_(n: number): string {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

/* ══════════════ いま生きている報酬の見分け方 ══════════════ */

/**
 * もう打ち切った報酬か。
 *
 * 印のつき方が2通りあるのは、支払済の報酬だけ扱いが違うため。
 *   ・まだ振り込んでいない報酬 … status を「取消」にする
 *   ・すでに振り込んだ報酬     … status は「支払済」のまま。振り込んだ事実を消さないため、
 *     取消の理由（cancel_reason）を入れるだけにして、同額のマイナスで相殺する
 *
 * そのため「打ち切ったかどうか」は status だけでは分からない。必ずここを通す。
 */
function isReversed(r: Row): boolean {
  return s_(r, "status") === CANCELLED || s_(r, "cancel_reason") !== "";
}

/** まだ生きている報酬（打ち切られていない、金額がプラスの行）。 */
function isLive(r: Row): boolean {
  return n_(r, "amount") > 0 && !isReversed(r);
}

/**
 * 受注1件ぶんの報酬が、いまどうなっているか。
 *
 * 二重計上・二重取消はそのまま支払額の誤りになるので、
 * 「生きている報酬があるか」「取消が途中で止まっていないか」の判断はここに集める。
 *
 * 渡す行は cancel_reason まで読んでおくこと
 * （`rewards?select=id,status,amount,cancel_reason&order_id=eq.…`）。
 * 読み落とすと、支払済のまま相殺した報酬が「まだ生きている」に数えられてしまう。
 */
export type RewardStanding = {
  /** まだ打ち切っていない、金額がプラスの報酬の件数 */
  live: number;
  /** そのうち、すでに振り込みが済んでいるものの件数 */
  livePaid: number;
  /** 相殺のために立ててあるマイナスの件数 */
  offsets: number;
  /** すでに打ち切った元の報酬の件数（支払済のまま相殺したものも数える） */
  reversed: number;
  /** 取消が途中で止まっている疑い（マイナスだけが多い） */
  halfDone: boolean;
};

export function rewardStanding(rows: Row[]): RewardStanding {
  const positives = rows.filter((r) => n_(r, "amount") > 0);
  const live = positives.filter(isLive);
  const offsets = rows.filter((r) => n_(r, "amount") < 0).length;
  const reversed = positives.length - live.length;
  return {
    live: live.length,
    livePaid: live.filter((r) => s_(r, "status") === PAID).length,
    offsets,
    reversed,
    /*
     * マイナスは「すでに振り込んだ報酬」にしか立てないので、取消が最後まで済んでいれば
     * かならず マイナスの数 ≦ 打ち切った行の数 になる。
     * 「マイナスが1件でもあれば怪しい」とはしない。否決→承認→否決と行き来した受注では、
     * 前の周回で正しく終わったマイナスと打ち切り済みの行がそのまま残っており、
     * それを疑いとして扱うと二度と取り消せなくなるため。
     */
    halfDone: offsets > reversed,
  };
}

/** 対象月を 'YYYY-MM' で返す。 */
function monthOf(date: string): string {
  return (date || todayInJapan()).slice(0, 7);
}

/**
 * ランクに応じた単価の列名。本部が払う相手だけが列名を持つ。
 *
 * ■ 支払いは段階式（2026-08-19/20 の打合せ）
 *
 *   本部（メーカー） → 総販売代理店 77,000 → 2次（エリア統括） 62,700
 *   2次（エリア統括） → 3次（販売代理店） 50,000（税抜）・取次 25,000（税抜）
 *
 * この台帳（rewards）は本部の支払管理なので、本部が払う
 * 総販売代理店・2次代理店のぶんだけを立てる。
 *
 * 3次・取次への支払いは、その上位（エリア統括）の仕事。
 * 統括の「売上・報酬」画面にある担当ごとの内訳（支払通知の作成用）が
 * 台数 × 支払単価（pay_unit・税抜）で自動集計している。
 * 紹介案件も配下のコードに付く（lib/orders.ts の ownerCode）ので、
 * 取次の紹介報酬もそちらに含まれる。
 *
 * 以前はここで4ランク全部に行を立てていたため、同じ1台の3次の売上が
 * 本部の台帳（55,000 税込）と統括の画面（50,000 税抜）の両方に
 * 支払いとして出て、両方が払うと1台あたり最大約10万円の二重払いになった。
 */
function amountColumn(rank: string): string | null {
  if (rank === "総販売代理店") return "amount_so";
  if (rank === "2次代理店") return "amount_niji";
  // 取次店・販売代理店（3次）は統括が払う。本部の台帳には立てない。
  return null;
}

/** 単価をどう決めたか。監査ログに残して、あとから検算できるようにする。 */
type RewardBasis = {
  /** ランク別の単価。amountColumn が返す列名で引く。 */
  unit: Record<string, number>;
  /** どうやって商品マスタと突き合わせたか。 */
  how: MatchHow;
  /** 単価の根拠にした商品名。完全一致なら1件、分解なら拾った全部。 */
  used: string[];
};

/**
 * 受注の商品名から、ランク別の単価を決める。
 *
 * 引き当てそのものは ./product-match に集約してある。
 * 報酬の計上（ここ）と、画面に出す金額（./orders・本部の受注一覧）で引き方が違うと、
 * 実際に計上された額と代理店に見える額がずれるため、必ず同じ関数を通す。
 */
async function resolveRewardBasis(order: Row): Promise<RewardBasis | null> {
  const productName = s_(order, "product_name");
  if (!productName) return null;

  const products = await selectAll<Row>(`products?select=${PRODUCT_COLUMNS}&order=id`);
  const match = buildProductMatcher(products)(
    productName,
    n_(order, "amount"),
    n_(order, "quantity") || 1,
  );
  if (!match) return null;
  // 報酬対象外の商品は、今までどおり1行も立てない。
  if (s_(match.row, "reward_target") === "対象外") return null;

  const unit: Record<string, number> = {};
  for (const c of AMOUNT_COLUMNS) unit[c] = n_(match.row, c);
  return { unit, how: match.how, used: match.used };
}

/**
 * 受注1件から発生する報酬を計上する。
 *
 * 受注に記録されている「売った代理店」「2次代理店」「ゼロ次代理店」「紹介した取次店」
 * それぞれに、そのランクの単価で1行ずつ立てる。
 * 同じ受注で二度計上しないよう、既にある行は作り直さない。
 *
 * @param opts.redo
 *   取り消し済みの報酬しか残っていない受注を、もう一度計上し直したいときだけ true にする
 *   （審査の否決を取り下げて「承認」に戻したとき）。
 *   既定では、行が1つでもあれば何もしない。取消のマイナスを立てたあとの受注に
 *   うっかり計上を重ねると、支払額が二重になるため。
 */
export async function accrueRewards(
  orderId: string | number,
  opts: { redo?: boolean } = {},
): Promise<number> {
  const order = await selectOne<Row>(`orders?select=*&id=eq.${encodeURIComponent(String(orderId))}`);
  if (!order) return 0;

  // すでに計上済みなら何もしない。
  // 計上し直しのときだけ「まだ生きている報酬」（打ち切られていない、金額がプラスの行）で見る。
  // 打ち切った元の行と、相殺のマイナスは帳簿に残したままにするため、
  // 行の有無で判断すると二度と計上し直せなくなる。
  // 支払済のまま相殺した行は status が「支払済」のまま残るので、
  // 取消の理由まで見る isLive で判断する（status だけで見ると計上し直せなくなる）。
  const existing = await select<Row>(
    `rewards?select=id,status,amount,cancel_reason&order_id=eq.${encodeURIComponent(String(orderId))}`,
  );
  const blocking = opts.redo ? existing.filter(isLive) : existing;
  if (blocking.length > 0) return 0;

  const basis = await resolveRewardBasis(order);
  if (!basis) return 0;

  const month = monthOf(s_(order, "ordered_on"));
  const quantity = n_(order, "quantity") || 1;

  // 受け取る可能性のある相手。同じコードが重複しないようにする。
  const codes = [
    s_(order, "agency_code"),
    s_(order, "niji_code"),
    s_(order, "zeroth_code"),
    s_(order, "referrer_code"),
  ].filter(Boolean);
  const unique = [...new Set(codes)];
  if (unique.length === 0) return 0;

  // コードは受注の ?ref= 由来で、利用者が打った文字がそのまま入ることがある。
  // inList が引用符の escape と URL 符号化をまとめて行う（db.ts 参照）。
  const agencies = await select<Row>(
    `agencies?select=code,rank,channel&code=${inList(unique)}`,
  );

  /*
   * 個別に決めた「この相手に払う額」。入っていればランク別の単価より優先する。
   * 「インボイス登録が無いので減額したい」のような個別契約に使う。
   *
   * この台帳に立つのは総販売代理店・2次代理店だけ（amountColumn を参照）なので、
   * ここで効くのも本部がその2ランクに入れた額だけ。
   * 3次・取次の pay_unit（既定 50,000／25,000・税抜）は統括の画面の支払集計が使う。
   * 入れた額は換算せずそのまま計上する（「税抜きの金額をそのまま払う」2026-08-19 決定）。
   *
   * 列がまだ無いうちに動いても報酬計算が止まらないよう、失敗したら既定の単価だけで進む。
   * （マイグレーション supabase/migrations/2026-08-19_agency_pay_unit.sql を流すと効き始める）
   */
  const payUnit = new Map<string, number>();
  try {
    const rows = await select<Row>(`agencies?select=code,pay_unit&code=${inList(unique)}`);
    for (const r of rows) {
      const v = n_(r, "pay_unit");
      if (v > 0) payUnit.set(s_(r, "code"), v);
    }
  } catch {
    // 列がまだ無い。既定の単価で進む。
  }

  /*
   * 同じ段の報酬を二度立てない。
   *
   * 報酬は「売った代理店・その2次・ゼロ次・紹介した取次」の4つの置き場から
   * 拾うが、これはコードが違えば別々の相手だという前提で組んである。
   * ところが総販売代理店の下に総販売代理店がいると（RIM の下の RIM0001）、
   * 売った本人と ゼロ次 が別のコードのまま同じランクになり、
   * 1台で 77,000 円が2行立って合計 154,000 円（売価の82%）になる。
   *
   * 紹介報酬は販売報酬とは別の段なので、ここでは同じ扱いにしない。
   */
  const seenRank = new Set<string>();

  /*
   * 「売った本人 → その2次 → ゼロ次 → 紹介した取次」の順に見る。
   * 上の重複よけで片方を落とすとき、どちらが残るかを決めておくため。
   * データベースから返る順番は決まっていないので、ここで並べ直す。
   */
  const order4 = unique;
  const ordered = [...agencies].sort(
    (x, y) => order4.indexOf(s_(x, "code")) - order4.indexOf(s_(y, "code")),
  );

  const rows: Record<string, unknown>[] = [];
  for (const a of ordered) {
    /*
     * 3次（販売代理店）は「ランク＝取次店 ＋ 販路種別＝販売代理店」で表す。
     * 販路種別だけを見て上書きすると、
     * 「ランク＝2次代理店 ＋ 販路種別＝販売代理店」で登録される
     * エリア統括代理店まで3次の単価になり、7,700円少なく計上される。
     * 判定は src/lib/orders.ts の effectiveRank と同じにそろえてある。
     */
    const rank =
      s_(a, "rank") === "取次店" && s_(a, "channel") === "販売代理店"
        ? "販売代理店"
        : s_(a, "rank");
    const col = amountColumn(rank);
    if (!col) continue;
    // 上位が決めた額があればそれを使う。無ければランク別の単価。
    const override = payUnit.get(s_(a, "code")) ?? 0;
    const unit = override > 0 ? override : (basis.unit[col] ?? 0);
    if (unit <= 0) continue;

    const kind = s_(a, "code") === s_(order, "referrer_code") ? "紹介報酬" : "販売報酬";
    /*
     * 同じ段（ランク）の報酬がもう立っていれば飛ばす（上の説明を参照）。
     * 紹介報酬も同じガードを通す。紹介元がたまたま総販売代理店や
     * 2次代理店のコードだったとき、販売報酬と紹介報酬の2行が立って
     * 77,000円・62,700円が二重に計上されるのを防ぐ。
     * （本来の紹介報酬＝取次店は amountColumn が null なので、そもそもここに来ない）
     */
    if (seenRank.has(rank)) continue;
    seenRank.add(rank);

    rows.push({
      order_id: order["id"],
      agency_code: s_(a, "code"),
      agency_rank: rank,
      month,
      amount: unit * quantity,
      kind,
      status: "未確定",
    });
  }

  if (rows.length === 0) return 0;
  await insert("rewards", rows);
  await audit("system", opts.redo ? "報酬の計上し直し" : "報酬計上", { type: "order", key: String(orderId) }, {
    件数: rows.length,
    合計: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    // 単価をどこから取ったかを残す。分解で決めたときは、あとから検算できるようにする。
    単価の決め方: basis.how,
    単価の根拠: basis.used,
    // 上位が個別の額を決めていた相手は、それも残す（あとで「なぜこの額か」を追えるように）
    ...(payUnit.size > 0
      ? { 個別単価: Object.fromEntries(payUnit) }
      : {}),
  });
  return rows.length;
}

/**
 * 配送完了で報酬を確定させる。
 * 2026-08-07 会議「報酬確定を配送完了ベースにする」。
 */
export async function confirmRewards(orderId: string | number): Promise<number> {
  const today = todayInJapan();
  const rows = await update<Row>(
    `rewards?order_id=eq.${encodeURIComponent(String(orderId))}&status=eq.${encodeURIComponent("未確定")}`,
    { status: "確定", confirmed_on: today },
  );
  if (rows.length > 0) {
    await audit("system", "報酬確定", { type: "order", key: String(orderId) }, {
      件数: rows.length,
    });
  }
  return rows.length;
}

/**
 * キャンセル・否決になったときに、計上済みの報酬を打ち切る。
 *
 * 打ち切り方は「もうお金が出ているかどうか」で変える。
 *
 *   ・まだ振り込んでいない報酬（未確定・確定）
 *       その行を「取消」にするだけで終わりにする。
 *       支払画面は「取消」の行をどの合計にも数えないので、これで支払い待ちが 0 円になる。
 *       ここで同額のマイナスまで立てると、元の行が合計から消えたうえに
 *       マイナスだけが支払い待ちに残り、一度も払っていない額を次の振込から
 *       差し引くことになってしまう（8月に +1,000 を計上 → 同8月に否決 →
 *       支払い待ちが 0 円ではなく −1,000 円になる、という取り違え）。
 *
 *   ・すでに振り込んだ報酬（支払済）
 *       実際にお金が出ているので、同額のマイナスを立てる（赤伝票）。
 *       このマイナスが「支払い待ち」に残り、次回の振込額から差し引かれる。
 *       元の行は「支払済」のまま、支払日もそのままにして、取消の理由だけを書き添える。
 *       「取消」に書き換えてしまうと、振り込んだ事実が画面から消える
 *       （支払管理の「支払済合計」からその額が落ち、明細の「支払済を取り消す」ボタンも
 *       支払済の行にしか出ないため、誤って払ったぶんを戻すこともできなくなる）。
 *
 * 審査の否決は、出荷より前・支払より前に起きるのがふつうなので、
 * ほとんどの取消はマイナスの立たない前者になる。
 * ただし出荷済・支払済まで進んだ受注を否決にすることはあるので、
 * 支払済がまじっていたら、その件数と金額を呼んだ側に返して本部に伝えてもらう。
 */
export type ReverseOutcome = {
  /** 打ち切った報酬の件数（マイナスを立てた件数ではない） */
  count: number;
  /** そのうち、すでに振り込みが済んでいたものの件数 */
  paidCount: number;
  /** すでに振り込んでいた額の合計 */
  paidAmount: number;
  /** 支払済がまじっていたときに、本部へそのまま出せる一言。無ければ空 */
  paidNote: string;
};

/** 件数だけでよいときの呼び方。 */
export async function reverseRewards(
  orderId: string | number,
  reason: string,
): Promise<number> {
  const outcome = await reverseRewardsDetailed(orderId, reason);
  return outcome.count;
}

/** 打ち切りの中身まで受け取りたいときの呼び方（支払済があったかどうかを返す）。 */
export async function reverseRewardsDetailed(
  orderId: string | number,
  reason: string,
): Promise<ReverseOutcome> {
  const nothing: ReverseOutcome = { count: 0, paidCount: 0, paidAmount: 0, paidNote: "" };

  /*
   * 取り消すのは「まだ生きている報酬」だけ。
   * 金額がプラスというだけで選ぶと、前回の取消で印をつけた行まで拾ってしまい、
   * 同じ報酬に二度マイナスが立って、支払額を余計に差し引くことになる
   * （審査を否決 → 承認 → 否決と行き来した受注で起きる）。
   *
   * 支払済の行は打ち切ったあとも「支払済」のまま残すので、status だけでは
   * 前回のぶんと見分けられない。取消の理由が入っているかどうかまで見て外す（isLive）。
   */
  const candidates = await select<Row>(
    `rewards?select=*&order_id=eq.${encodeURIComponent(String(orderId))}` +
      `&amount=gt.0&status=neq.${encodeURIComponent(CANCELLED)}`,
  );
  const rows = candidates.filter(isLive);
  if (rows.length === 0) return nothing;

  /*
   * 書き換える行は、いま読んだ行番号で名指しする。
   * 読み取れない行番号があれば、1件も動かさずにここで止める。
   * 半分だけ動かすと、マイナスだけが立った行が残って支払額がずれるため
   * （呼んだ側は失敗として本部に伝え、やり直せる）。
   */
  const idOf = (r: Row): string => {
    const id = s_(r, "id");
    if (!/^\d+$/.test(id)) {
      throw new Error("報酬の行番号を読み取れなかったため、取消を行いませんでした。");
    }
    return id;
  };
  const paid = rows.filter((r) => s_(r, "status") === PAID);
  const unpaid = rows.filter((r) => s_(r, "status") !== PAID);
  const paidIds = paid.map(idOf);
  const unpaidIds = unpaid.map(idOf);
  const paidAmount = paid.reduce((total, r) => total + n_(r, "amount"), 0);

  const today = todayInJapan();

  // すでに振り込んだぶんだけ、同額のマイナスを立てる（赤伝票）。
  if (paid.length > 0) {
    const negatives = paid.map((r) => ({
      order_id: r["order_id"],
      agency_code: s_(r, "agency_code"),
      agency_rank: s_(r, "agency_rank"),
      month: today.slice(0, 7),    // 取消は当月に立てる（翌月の支払から差し引く）
      amount: -n_(r, "amount"),
      kind: "取消",
      status: "確定",
      confirmed_on: today,
      cancel_reason: reason,
    }));
    await insert("rewards", negatives);
  }

  /*
   * 元の行に取消の印をつける（いま打ち切ったぶんだけ。前回の取消は書き換えない）。
   *
   * 印のつけ方は行によって違う。
   *   ・支払済の行 … status は「支払済」のまま、支払日もそのまま。取消の理由だけを入れる。
   *     振り込んだ事実を画面に残すため（上の説明のとおり）。
   *     取消の理由が入っていることが「相殺済み」の印になり、二度目の相殺を防ぐ（isLive）。
   *   ・未払の行   … status を「取消」にする。支払い待ちから外すため。
   *
   * 順番は「マイナスを立てる → 支払済の行に印 → 未払の行に印」で固定する。
   * 途中で止まったときに、立ったマイナスの数が印のついた行より多くなり、
   * 呼んだ側の「取消が途中で止まっている」判定に引っかかるようにするため
   * （その判定に引っかかると、二重にマイナスを立てずに本部へ知らせて止まる）。
   */
  let moved = 0;
  if (paidIds.length > 0) {
    const done = await update<Row>(`rewards?id=in.(${paidIds.join(",")})`, {
      cancel_reason: `${reason}（振込済みのため取り消さず、同額のマイナスで相殺）`,
    });
    moved += done.length;
  }
  if (unpaidIds.length > 0) {
    const done = await update<Row>(`rewards?id=in.(${unpaidIds.join(",")})`, {
      status: CANCELLED,
      cancel_reason: reason,
    });
    moved += done.length;
  }

  await audit("system", "報酬の取消", { type: "order", key: String(orderId) }, {
    件数: moved,
    支払済のため相殺した件数: paid.length,
    支払済のため相殺した金額: paidAmount,
    未払のまま打ち切った件数: unpaid.length,
    理由: reason,
  });

  return {
    count: moved,
    paidCount: paid.length,
    paidAmount,
    paidNote:
      paid.length === 0
        ? ""
        : `この受注には支払済の報酬が ${paid.length} 件（${yen_(paidAmount)}）あります。` +
          "すでに振り込んだお金なので、支払済の記録はそのまま残し、同額のマイナスを立てました。" +
          "次回の振込から差し引いてください。",
  };
}

/**
 * 受注の出荷状況が変わったときに呼ぶ。
 * 配送完了なら確定、キャンセルなら取消。
 */
export async function onShipStatusChanged(
  orderId: string | number,
  status: string,
): Promise<void> {
  if (status === "出荷済") {
    await confirmRewards(orderId);
  } else if (status === "キャンセル") {
    await reverseRewards(orderId, "受注のキャンセル");
  }
}

/* ══════════════════ 審査結果が変わったとき ══════════════════ */

/**
 * 審査結果を変えたときに、報酬をどう動かしたか。
 *
 * 呼んだ側（受注の更新）が、そのまま本部への言葉にできる形で返す。
 * 「何もしなかった」ときこそ理由が要る。0件のまま「取り消しました」と伝えると、
 * 取消の済んでいない受注を見落とすため。
 */
export type ReviewRewardOutcome = {
  /**
   * 取消＝報酬を打ち切った / 計上し直し＝もう一度立てた / 変更なし / 中断＝触らずに止めた。
   *
   * 「取消（支払済あり）」だけは、打ち切ったうえで本部に手を動かしてもらう必要がある
   * （すでに振り込んだぶんは、次回の振込から差し引いてもらうしかない）。
   * 呼んだ側が「取消」と同じ言い回しで済ませてしまわないよう、別の名前にしてある。
   * この場合は reason に、取消の結果と差し引きのお願いをまとめて入れて返す。
   */
  action: "取消" | "取消（支払済あり）" | "計上し直し" | "変更なし" | "中断";
  /** 動いた報酬の件数 */
  count: number;
  /** 何もしなかった理由、または添える一言 */
  reason: string;
};

/**
 * 受注の審査結果が変わったときに呼ぶ。
 *
 * 出荷状況の「キャンセル」と同じで、審査の「否決」も売上にならない。
 * 受注一覧・詳細では否決を売上と支払対象額から外しているので、
 * 報酬のほうも取り消しておかないと、画面の集計と報酬データがずれる
 * （否決のまま放置された受注が、報酬一覧では支払対象として残ってしまう）。
 *
 * ・否決 … 計上済みの報酬を打ち切る（reverseRewardsDetailed）。否決は出荷より前・支払より前に
 *          出るのがふつうなので、たいていは元の行を「取消」にするだけで終わる。
 *          すでに振り込んだ報酬があるときだけ、そのぶんの同額のマイナスを立てる（赤伝票）。
 *          その行は「支払済」のまま残るので、差し引きのお願いを reason に入れて返す
 * ・承認 … 否決を取り下げた場合。取り消した分は帳簿から消さず、
 *          あらためて計上し直す（履歴として積む）
 * ・電話確認待ち・未設定 … まだ結果が出ていないので、報酬には触らない
 *
 * 二重計上・二重取消は支払額の誤りに直結する。そのため、
 * 「いま生きている報酬（打ち切られていない、金額がプラスの行）があるか」を
 * rewardStanding で毎回見て決める。
 *
 * @param note
 *   否決にした理由（信販の否決通知番号など）。本部が画面で書いたときだけ渡ってくる。
 *   報酬の取消理由に書き添えて、あとから「なぜ取り消したのか」を追えるようにする。
 */
export async function onReviewResultChanged(
  orderId: string | number,
  result: string,
  note = "",
): Promise<ReviewRewardOutcome> {
  const key = encodeURIComponent(String(orderId));

  if (result !== "承認" && result !== "否決") {
    return {
      action: "変更なし",
      count: 0,
      reason: "審査の結果が出るまで、報酬はそのままにしています。",
    };
  }

  // 打ち切ったかどうかは status だけでは分からない（支払済の行は「支払済」のまま残る）。
  // 取消の理由まで読んで、rewardStanding に数えてもらう。
  const rows = await select<Row>(
    `rewards?select=id,status,amount,cancel_reason&order_id=eq.${key}`,
  );
  const standing = rewardStanding(rows);

  /* --- 否決：計上済みの報酬を取り消す --- */
  if (result === "否決") {
    if (rows.length === 0) {
      return {
        action: "変更なし",
        count: 0,
        reason: "この受注には報酬が1件も計上されていないため、取り消すものはありませんでした。",
      };
    }
    if (standing.live === 0) {
      return {
        action: "変更なし",
        count: 0,
        reason: "この受注の報酬は、すでに取り消されています。",
      };
    }
    if (standing.halfDone) {
      // 前回の取消が途中で止まっている。ここでやり直すとマイナスが二重に立ち、
      // 支払額を余計に差し引いてしまうため、報酬には触らずに本部へ知らせる。
      return {
        action: "中断",
        count: 0,
        reason:
          `この受注の報酬は取消の途中で止まっています（相殺のマイナス ${standing.offsets} 件は立っていますが、` +
          `元の報酬 ${standing.live} 件が取消になっていません）。` +
          "このまま取消をやり直すとマイナスが二重に立つため、報酬には触っていません。",
      };
    }
    const trimmed = note.trim();
    const outcome = await reverseRewardsDetailed(
      orderId,
      trimmed ? `審査の否決（${trimmed}）` : "審査の否決",
    );
    if (outcome.paidCount > 0) {
      // すでに振り込んだ報酬がまじっていた。こちらでは帳消しにできないので、
      // 「取り消しました」で終わらせず、次の振込で差し引いてもらうところまで伝える。
      return {
        action: "取消（支払済あり）",
        count: outcome.count,
        reason:
          `審査が否決になったため、この受注の報酬 ${outcome.count} 件を取り消しました。` +
          (trimmed ? `取消の理由として「${trimmed}」を残しました。` : "") +
          outcome.paidNote,
      };
    }
    return { action: "取消", count: outcome.count, reason: "" };
  }

  /* --- 承認：否決を取り下げたときだけ、計上し直す --- */
  if (standing.live > 0) {
    return {
      action: "変更なし",
      count: 0,
      reason: "この受注の報酬はすでに計上されています。",
    };
  }

  // キャンセルされた受注まで計上し直すと、出荷しない商品の報酬が復活してしまう。
  const order = await selectOne<Row>(`orders?select=id,ship_status&id=eq.${key}`);
  if (s_(order, "ship_status") === "キャンセル") {
    return {
      action: "変更なし",
      count: 0,
      reason:
        "このご注文は出荷状況が「キャンセル」のため、報酬は計上し直していません。" +
        "報酬も戻す場合は、先に出荷状況を戻してください。",
    };
  }

  const count = await accrueRewards(orderId, { redo: true });
  if (count === 0) {
    return {
      action: "変更なし",
      count: 0,
      reason:
        "計上し直せる報酬はありませんでした。受注に代理店コードが入っているか、" +
        "商品が報酬の対象かをご確認ください。",
    };
  }

  // すでに配送が終わっている受注なら、計上し直した報酬もその場で確定させる
  // （報酬が確定するのは配送完了のとき、という決まりに合わせる）。
  let reason = "";
  if (s_(order, "ship_status") === "出荷済") {
    const confirmed = await confirmRewards(orderId);
    if (confirmed > 0) {
      reason = "この受注はすでに出荷済みのため、計上し直した報酬は確定にしています。";
    }
  }
  return { action: "計上し直し", count, reason };
}

export type MonthlyReward = {
  agencyCode: string;
  month: string;
  confirmed: number;
  pending: number;
  total: number;
};

/** 代理店ごと・月ごとの報酬をまとめる（支払通知の作成用）。 */
export async function monthlyRewards(
  codes: string[],
  month?: string,
): Promise<MonthlyReward[]> {
  const list = codes.filter(Boolean);
  if (list.length === 0) return [];
  const filters = [`agency_code=${inList(list)}`];
  if (month) filters.push(`month=eq.${month}`);
  const rows = await select<Row>(`rewards?select=*&${filters.join("&")}`);

  const map = new Map<string, MonthlyReward>();
  for (const r of rows) {
    const key = `${s_(r, "agency_code")}|${s_(r, "month")}`;
    const cur =
      map.get(key) ??
      { agencyCode: s_(r, "agency_code"), month: s_(r, "month"), confirmed: 0, pending: 0, total: 0 };
    const amt = n_(r, "amount");
    const st = s_(r, "status");
    if (st === "確定" || st === "支払済") cur.confirmed += amt;
    else if (st === "未確定") cur.pending += amt;
    if (st !== "取消") cur.total += amt;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}
