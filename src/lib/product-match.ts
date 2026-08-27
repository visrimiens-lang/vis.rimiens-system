import "server-only";

/**
 * 受注の商品名から、商品マスタの行（単価・報酬額）を引き当てる。
 *
 * ■ なぜ完全一致だけでは足りないか
 *
 * UTAGE は本体・事務手数料・オプションをまとめて1回で決済する。
 * そのとき商品名は、買ったものを並べた1本の文字列で届く。
 * 実データの例（商品マスタ id=5）:
 *   「眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円」
 * よく出る組み合わせは1レコードとして登録されているので、当たれば完全一致で引ける。
 *
 * ところが OP①（ジェルパッド1年分の先行購入）が付いた組み合わせのレコードが無い。
 * 完全一致だけだと1件も当たらず、報酬が丸ごと 0 円になる。
 *
 * ■ 当たらなかったときの分解のしかた
 *
 * 取扱中の商品名が受注の商品名の中に含まれるかを見て、
 * 長い名前から順に、同じ文字を二度数えないように拾っていく。
 *
 * 長い名前から拾うのが要点。「眼筋トレーニングマシン」のような短い名前を先に取ると、
 * 本来の「本体＋事務手数料」のレコードを取り逃がして単価が下がる。
 *
 * ■ 間違った分解を採らない仕組み
 *
 * 拾った商品の税込価格の合計が、実際に決済された金額とぴったり一致したときだけ採用する。
 * 一致しなければ null を返し、呼び出し側は「単価が引けなかった」として扱う。
 * 決済額との照合を通すので、分解を取り違えたまま金額を出すことはない。
 *
 * 足し合わせてよいことは実データで確かめてある:
 *     id=5  本体＋事務手数料        188,300 / 総販 77,000 / 2次 62,700 / 販代 55,000 / 取次 27,500
 *   ＋ id=15 3年保証セット（OP②）    11,000 /       3,300 /      2,200 /      1,100 /          0
 *   ＝ id=3  本体＋事務手数料＋OP②  199,300 /      80,300 /     64,900 /     56,100 /     27,500
 * 商品マスタに元から入っている結合レコード（id=3）と全列で一致する。
 *
 * ■ ここに集約している理由
 *
 * 報酬の計上（rewards.ts）と、画面に出す金額（orders.ts / 本部の受注一覧・受注詳細）で
 * 引き方が違うと、**実際に計上された額と代理店に見える額がずれる**。
 * 引き当てはこの1か所だけにして、全部ここを通す。
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

/** 商品マスタが持っているランク別の単価の列。 */
export const AMOUNT_COLUMNS = [
  "amount_so",
  "amount_niji",
  "amount_toritsugi",
  "amount_hanbai",
] as const;

/** 引き当てに必要な列。products を取るときはこれを select に入れること。 */
export const PRODUCT_COLUMNS =
  "name,price_incl_tax,reward_target,amount_so,amount_niji,amount_hanbai,amount_toritsugi,active";

/** どうやって引き当てたか。監査ログに残して、あとから検算できるようにする。 */
export type MatchHow = "商品名の完全一致" | "内訳への分解";

export type ProductMatch = {
  /** 商品マスタの行と同じ形。分解したときは各列を足し合わせた合成行。 */
  row: Row;
  how: MatchHow;
  /** 引き当ての根拠にした商品名。完全一致なら1件、分解なら拾った全部。 */
  used: string[];
};

/**
 * 商品マスタの一覧から引き当て関数を作る。
 *
 * @param products 商品マスタの行。PRODUCT_COLUMNS で取ったもの。
 *   `active` を含めておくと、分解の候補を取扱中のものだけに絞る。
 */
/**
 * 名前の照合用に、空白（半角・全角）をすべて取り除く。
 *
 * UTAGE はオーダーバンプ付きの決済を「本体名 ／ バンプ名」と
 * 空白入りの「 ／ 」でつないで通知してくる。商品マスタ側は
 * 「VIS本体／事務手数料／OP①(２年目ジェルパット)」のように空白なしで
 * 持っているため、文字どおりの完全一致だと同じ商品が別物になる。
 * 空白だけの違いで報酬が0円になるのを防ぐ。
 */
function keyOf(name: string): string {
  return (name || "").replace(/[\s\u3000]+/g, "");
}

export function buildProductMatcher(
  products: Row[],
): (productName: string, amount: number, quantity?: number) => ProductMatch | null {
  const exact = new Map<string, Row>();
  for (const p of products) exact.set(keyOf(s_(p, "name")), p);

  /*
   * 分解の候補は取扱中のものだけにする。
   * 取扱を止めた旧仕様（定期パッド配送など）が混ざると、
   * もう売っていない商品で金額が合ってしまうことがある。
   * active 列を取っていない呼び出し元では、全件を候補にする。
   */
  const hasActive = products.some((p) => "active" in p);
  const candidates = (hasActive ? products.filter((p) => p["active"] !== false) : products)
    .filter((p) => s_(p, "name"))
    .sort((a, b) => s_(b, "name").length - s_(a, "name").length);

  return (productName, amount, quantity = 1) => {
    const name = keyOf(productName);
    if (!name) return null;

    const hit = exact.get(name);
    if (hit) return { row: hit, how: "商品名の完全一致", used: [s_(hit, "name")] };

    if (!(amount > 0)) return null;

    /*
     * 拾った場所は、他の名前に当たらない文字で塗り潰してから次を探す。
     * 消してしまうと前後がくっついて、元の文字列には無かった並びが生まれる。
     * こちらも空白抜きの形どうしで探す（上の keyOf の説明を参照）。
     */
    let rest = name;
    const used: Row[] = [];
    for (const p of candidates) {
      const pname = keyOf(s_(p, "name"));
      if (!pname) continue;
      const at = rest.indexOf(pname);
      if (at < 0) continue;
      rest = rest.slice(0, at) + " ".repeat(pname.length) + rest.slice(at + pname.length);
      used.push(p);
    }

    /*
     * 1件しか拾えないときは採らない。
     * 単品ならその名前で完全一致しているはずなので、ここに来たものは
     * 短い名前がたまたま部分一致しただけの可能性が高い。
     */
    if (used.length < 2) return null;

    const priceSum = used.reduce((sum, p) => sum + n_(p, "price_incl_tax"), 0);
    const q = quantity || 1;
    // amount が1台ぶんか、台数を掛けた合計かは送り元によって変わる。どちらかに合えばよい。
    if (priceSum !== amount && priceSum * q !== amount) return null;

    const row: Row = {
      name: used.map((p) => s_(p, "name")).join(" ＋ "),
      price_incl_tax: priceSum,
      // 1つでも報酬対象があれば対象。対象外のもの（事務手数料など）は下で 0 として足す。
      reward_target: used.some((p) => s_(p, "reward_target") !== "対象外") ? "対象" : "対象外",
    };
    for (const c of AMOUNT_COLUMNS) {
      row[c] = used.reduce(
        (sum, p) => sum + (s_(p, "reward_target") === "対象外" ? 0 : n_(p, c)),
        0,
      );
    }
    return { row, how: "内訳への分解", used: used.map((p) => s_(p, "name")) };
  };
}
