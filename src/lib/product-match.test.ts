import { describe, expect, it } from "vitest";

import {
  AMOUNT_COLUMNS,
  PRODUCT_COLUMNS,
  buildProductMatcher,
} from "./product-match";

/**
 * product-match.ts は「受注の商品名（1本の文字列）＋決済額」から
 * 商品マスタの行（単価・報酬額）を引き当てる。
 *
 * ここでは実装の意図ではなく、**現在の実装が実際にどう動くか**を固定する。
 * とくに商品名の表記ゆれが「どこまで吸収されて、どこから吸収されないか」を明示する。
 *
 * ■ fixture の出所
 * 実データは product-match.ts のドキュメントコメントに載っている3行だけ:
 *   id=5（本体＋事務手数料）/ id=15（3年保証セット OP②）/ id=3（本体＋事務手数料＋OP②）。
 * それ以外（VIS本体・事務手数料・OP①・定期パッド配送）は、分解経路を叩くための創作値。
 * 分解テストの期待値（81,400 / 66,000 / 28,600 / 57,200）は創作した OP① の数字から導いている。
 *
 * ■ 既知の欠陥について
 * ファイル末尾に「既知の欠陥」ブロックがある。
 * バグの挙動をそのまま固定しているテストはすべてそちらに置く。ここ（本文）にあるのは仕様。
 */

// id=5 実データ: 本体＋事務手数料 188,300 / 総販 77,000 / 2次 62,700 / 販代 55,000 / 取次 27,500
const P_BODY_FEE = {
  id: 5,
  name: "眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円",
  price_incl_tax: 188300,
  reward_target: "対象",
  amount_so: 77000,
  amount_niji: 62700,
  amount_hanbai: 55000,
  amount_toritsugi: 27500,
  active: true,
};

// id=3 実データ: 本体＋事務手数料＋OP② 199,300 / 80,300 / 64,900 / 56,100 / 27,500
const P_BODY_FEE_OP2 = {
  id: 3,
  name: "眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円 ／ 3年保証セット（OP②）",
  price_incl_tax: 199300,
  reward_target: "対象",
  amount_so: 80300,
  amount_niji: 64900,
  amount_hanbai: 56100,
  amount_toritsugi: 27500,
  active: true,
};

// id=15 実データ: 3年保証セット（OP②） 11,000 / 3,300 / 2,200 / 1,100 / 0
const P_OP2 = {
  id: 15,
  name: "3年保証セット（OP②）",
  price_incl_tax: 11000,
  reward_target: "対象",
  amount_so: 3300,
  amount_niji: 2200,
  amount_hanbai: 1100,
  amount_toritsugi: 0,
  active: true,
};

// OP①（ジェルパッド1年分の先行購入）。結合レコードが無く、分解でしか引けない商品。※創作値
const P_OP1 = {
  id: 16,
  name: "ジェルパッド1年分 先行購入（OP①・13,200円）",
  price_incl_tax: 13200,
  reward_target: "対象",
  amount_so: 4400,
  amount_niji: 3300,
  amount_hanbai: 2200,
  amount_toritsugi: 1100,
  active: true,
};

// ※創作値
const P_BODY = {
  id: 1,
  name: "VIS本体",
  price_incl_tax: 185000,
  reward_target: "対象",
  amount_so: 77000,
  amount_niji: 62700,
  amount_hanbai: 55000,
  amount_toritsugi: 27500,
  active: true,
};

// 事務手数料は報酬対象外。金額列に値が入っていても足されないことを確かめるため 0 にしない。※創作値
const P_FEE = {
  id: 2,
  name: "事務手数料",
  price_incl_tax: 3300,
  reward_target: "対象外",
  amount_so: 1000,
  amount_niji: 900,
  amount_hanbai: 800,
  amount_toritsugi: 700,
  active: true,
};

// 取扱停止済みの旧仕様。分解の候補から外れることを確かめるため active: false。※創作値
const P_PAD_SUB = {
  id: 20,
  name: "定期パッド配送",
  price_incl_tax: 5500,
  reward_target: "対象",
  amount_so: 1650,
  amount_niji: 1100,
  amount_hanbai: 550,
  amount_toritsugi: 0,
  active: false,
};

const PRODUCTS = [P_BODY_FEE_OP2, P_BODY_FEE, P_OP2, P_OP1, P_BODY, P_FEE, P_PAD_SUB];

const match = buildProductMatcher(PRODUCTS);

describe("公開している定数", () => {
  it("select 用の列指定は、引き当てで読む列と過不足なく一致する", () => {
    const expected = [
      "name",
      "price_incl_tax",
      "reward_target",
      "active",
      ...AMOUNT_COLUMNS,
    ];
    // 「読む列が足りない」だけでなく「もう読んでいない列が残っている」も検出する
    expect(PRODUCT_COLUMNS.split(",").sort()).toEqual([...expected].sort());
  });
});

describe("分解方式そのものの正当性（実データ id=5 ＋ id=15 ＝ id=3）", () => {
  /*
   * このモジュールが「拾った商品の各列を足し合わせてよい」と言えるのは、
   * 実データで id=5 ＋ id=15 が結合レコード id=3 と全列一致するから。
   * 分解方式の土台なので、いちばん先に固定しておく。
   */
  it("結合レコード id=3 をマスタから外しても、id=5 ＋ id=15 の分解が id=3 と全列一致する", () => {
    const withoutCombined = buildProductMatcher(
      PRODUCTS.filter((p) => p !== P_BODY_FEE_OP2),
    );
    const r = withoutCombined(P_BODY_FEE_OP2.name, P_BODY_FEE_OP2.price_incl_tax);

    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual([P_BODY_FEE.name, P_OP2.name]);
    expect(r?.row["price_incl_tax"]).toBe(P_BODY_FEE_OP2.price_incl_tax);
    for (const c of AMOUNT_COLUMNS) {
      expect(r?.row[c]).toBe(P_BODY_FEE_OP2[c]);
    }
  });
});

describe("完全一致（how = 商品名の完全一致）", () => {
  it("商品マスタと同じ商品名なら、マスタの行をそのまま返す", () => {
    const r = match(P_BODY_FEE.name, 188300);
    expect(r?.how).toBe("商品名の完全一致");
    // 合成行ではなく、マスタの行そのもの（同一オブジェクト）が返る
    expect(r?.row).toBe(P_BODY_FEE);
    expect(r?.used).toEqual([P_BODY_FEE.name]);
  });

  it("完全一致は決済額を見ない。金額 0 でも、単価と食い違っていても引ける", () => {
    expect(match(P_BODY_FEE.name, 0)?.how).toBe("商品名の完全一致");
    expect(match(P_BODY_FEE.name, -1)?.how).toBe("商品名の完全一致");
    expect(match(P_BODY_FEE.name, 999999)?.row).toBe(P_BODY_FEE);
  });

  it("取扱停止（active: false）の商品にも完全一致は当たる", () => {
    /*
     * 完全一致の表は products 全件から作っており、分解側と違って active で絞っていない。
     * 過去受注の再計算を通すための意図と思われるが、実装にその旨の記述は無い。
     * 分解側と扱いを変えている理由が書かれていないこと自体はレビュー指摘（low）。
     * 有害な形（停止済みの行が取扱中の行を覆う）は「既知の欠陥」ブロックに置いてある。
     */
    const r = match(P_PAD_SUB.name, 5500);
    expect(r?.how).toBe("商品名の完全一致");
    expect(r?.row).toBe(P_PAD_SUB);
  });
});

describe("表記ゆれ — 吸収されるもの", () => {
  it("半角スペース・全角スペースの有無と数の違いは吸収される", () => {
    const r = match("眼筋トレーニングマシンVIS本体 185,000円／事務手数料　　3,300円", 188300);
    expect(r?.how).toBe("商品名の完全一致");
    expect(r?.row).toBe(P_BODY_FEE);
  });

  it("空白をすべて詰めた形でも完全一致する", () => {
    const r = match("眼筋トレーニングマシンVIS本体185,000円／事務手数料3,300円", 188300);
    expect(r?.row).toBe(P_BODY_FEE);
  });

  it("末尾の【銀行振込】【アプラス（ローン）】などの但し書きは無視される", () => {
    expect(match(`${P_BODY_FEE.name}【銀行振込】`, 188300)?.row).toBe(P_BODY_FEE);
    expect(match(`${P_BODY_FEE.name}【アプラス（ローン）】`, 188300)?.row).toBe(P_BODY_FEE);
  });

  it("【】の除去は末尾に限らない。商品名の途中にあっても丸ごと消えて一致する", () => {
    const r = match("眼筋トレーニングマシン【2026年モデル】VIS本体　185,000円 ／ 事務手数料　3,300円", 188300);
    expect(r?.how).toBe("商品名の完全一致");
    expect(r?.row).toBe(P_BODY_FEE);
  });

  it("閉じていない【 は除去されないので、一致しなくなる", () => {
    expect(match(`${P_BODY_FEE.name}【銀行振込`, 188300)).toBeNull();
    // 対比: 閉じていれば同じ文字列で引ける（null の原因が【 の閉じ忘れであることを示す）
    expect(match(`${P_BODY_FEE.name}【銀行振込】`, 188300)?.row).toBe(P_BODY_FEE);
  });
});

describe("表記ゆれ — 吸収されないもの", () => {
  it("英字の大文字小文字は区別される（vis本体 は VIS本体 と別物）", () => {
    const lower = P_BODY_FEE.name.replace("VIS", "vis");
    // VIS の3文字を小文字にしただけで、完全一致も分解も外れる
    expect(match(P_BODY_FEE.name, 188300)?.row).toBe(P_BODY_FEE);
    expect(match(lower, 188300)).toBeNull();
    // 拾えるのは「事務手数料」1件だけなので、その金額に合わせても分解は成立しない
    expect(match(lower, 3300)).toBeNull();
  });

  it("カタカナ1文字の違い（ジェルパッド/ジェルパット）で OP① を取り逃がし、引き当てごと失敗する", () => {
    const ok = `${P_BODY_FEE.name} ／ ${P_OP1.name}`;
    const ng = ok.replace("ジェルパッド", "ジェルパット");
    // 正しい表記なら本体＋事務手数料 と OP① に分解できる
    expect(match(ok, 201500)?.used).toEqual([P_BODY_FEE.name, P_OP1.name]);
    // 「ッ」→「ッ」以外の1文字違いで OP① が拾えず、残り1件になって分解も不成立
    expect(match(ng, 201500)).toBeNull();
  });

  it("区切りが半角スラッシュだと完全一致から外れ、分解経路に落ちる", () => {
    const r = match("眼筋トレーニングマシンVIS本体　185,000円 / 事務手数料　3,300円", 188300);
    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual(["VIS本体", "事務手数料"]);
  });

  it("数字の全角・半角の違いも完全一致から外れ、分解経路に落ちる", () => {
    const r = match("眼筋トレーニングマシンVIS本体　１８５，０００円 ／ 事務手数料　３，３００円", 188300);
    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual(["VIS本体", "事務手数料"]);
  });
});

describe("内訳への分解（how = 内訳への分解）", () => {
  it("結合レコードが無い OP① 付きの決済を、本体＋事務手数料 と OP① に分解して足し合わせる", () => {
    const name = `${P_BODY_FEE.name} ／ ${P_OP1.name}`;
    const r = match(name, 201500);

    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual([P_BODY_FEE.name, P_OP1.name]);
    expect(r?.row).toEqual({
      name: `${P_BODY_FEE.name} ＋ ${P_OP1.name}`,
      price_incl_tax: 201500, // 188,300 + 13,200
      reward_target: "対象",
      amount_so: 81400, // 77,000 + 4,400
      amount_niji: 66000, // 62,700 + 3,300
      amount_toritsugi: 28600, // 27,500 + 1,100
      amount_hanbai: 57200, // 55,000 + 2,200
    });
  });

  it("3件以上にも分解できる（本体・事務手数料・OP② が別々の行として拾われる）", () => {
    // OP①＋OP② が同時に付く受注はこの経路を通る。実運用でいちばん起きやすい分解。
    const r = match("VIS本体 ／ 事務手数料 ／ 3年保証セット（OP②）", 199300);

    expect(r?.how).toBe("内訳への分解");
    expect(r?.row).toEqual({
      name: "3年保証セット（OP②） ＋ VIS本体 ＋ 事務手数料",
      price_incl_tax: 199300, // 11,000 + 185,000 + 3,300
      reward_target: "対象",
      amount_so: 80300, // 3,300 + 77,000（手数料は対象外なので 0）
      amount_niji: 64900, // 2,200 + 62,700
      amount_toritsugi: 27500, // 0 + 27,500
      amount_hanbai: 56100, // 1,100 + 55,000
    });
  });

  it("used は受注名に現れた順ではなく、候補の並び順（生の名前が長い順）になる", () => {
    /*
     * used は rewards.ts で監査ログ「単価の根拠」にそのまま記録される。
     * 受注名の並びとは一致しないことを明示しておく（並び順に業務上の意味は無い）。
     */
    const r = match("VIS本体 ／ 事務手数料 ／ 3年保証セット（OP②）", 199300);
    expect(r?.used).toEqual(["3年保証セット（OP②）", "VIS本体", "事務手数料"]);

    /*
     * PRODUCTS の宣言順はたまたまほぼ長い順なので、上の1件だけだと
     * sort を消しても通ってしまう（＝順序の主張が偶発的になる）。
     * わざと短い順に並べたマスタからも同じ順序になることまで見る。
     */
    const shortestFirst = buildProductMatcher(
      [...PRODUCTS].sort((a, b) => a.name.length - b.name.length),
    );
    expect(
      shortestFirst("VIS本体 ／ 事務手数料 ／ 3年保証セット（OP②）", 199300)?.used,
    ).toEqual(["3年保証セット（OP②）", "VIS本体", "事務手数料"]);
  });

  it("拾った場所は削除せず空白で塗り潰すので、元の文字列に無かった並びは生まれない", () => {
    /*
     * 「AXYZQ」から XY を削除すると「AZQ」になり、元には無かった AZ が現れて誤マッチする。
     * 実装は空白で塗り潰すため AZ は拾われない。
     */
    const m = buildProductMatcher([
      { name: "XY", price_incl_tax: 300, reward_target: "対象", amount_so: 30 },
      { name: "AZ", price_incl_tax: 999, reward_target: "対象", amount_so: 99 },
      { name: "Q", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
    ]);

    const r = m("AXYZQ", 400);
    expect(r?.used).toEqual(["XY", "Q"]);
    expect(r?.row["price_incl_tax"]).toBe(400);
    // 削除する実装なら used に AZ が混ざり、合計 1,399 のほうで通ってしまう
    expect(m("AXYZQ", 1399)).toBeNull();
  });

  it("塗り潰す範囲の右端は、拾った商品名の最後の1文字まで含む（1文字残すと二重計上する）", () => {
    /*
     * 塗り潰しを rest.slice(at + pname.length - 1) にすると、拾った名前の末尾1文字が
     * rest に残る。そこを起点に別の候補が再マッチし、同じ領域を二度数えて金額が水増しされる。
     * 「XY」を拾ったあと Y が残ると「YZ」が拾えてしまう並びで、境界を1文字ぶん詰める。
     */
    const m = buildProductMatcher([
      { name: "XY", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "YZ", price_incl_tax: 500, reward_target: "対象", amount_so: 50 },
      { name: "Q", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);

    // 正しくは XY と Q の2件だけ。YZ は XY の Y を塗り潰したあとなので拾えない
    const r = m("AXYZQ", 300);
    expect(r?.used).toEqual(["XY", "Q"]);
    expect(r?.row["price_incl_tax"]).toBe(300);
    expect(r?.row["amount_so"]).toBe(30);
    // 右端を1文字残す実装なら used が [XY, YZ, Q]、合計 800 のほうで通ってしまう
    expect(m("AXYZQ", 800)).toBeNull();
  });

  it("塗り潰す範囲の左端は、拾った商品名の最初の1文字から始まる（1文字残すと二重計上する）", () => {
    /*
     * 右端と同じ穴が左端にもある。rest.slice(0, at + 1) にすると拾った名前の
     * 先頭1文字が rest に残り、その文字を含む別の候補が再マッチして二重計上になる。
     * 「XY」を拾ったあと X が残ると「AX」が拾えてしまう並びで、境界を1文字ぶん詰める。
     */
    const m = buildProductMatcher([
      { name: "XY", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "AX", price_incl_tax: 500, reward_target: "対象", amount_so: 50 },
      { name: "Q", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);

    // 正しくは XY と Q の2件だけ。AX は XY の X を塗り潰したあとなので拾えない
    const r = m("AXYQ", 300);
    expect(r?.used).toEqual(["XY", "Q"]);
    expect(r?.row["price_incl_tax"]).toBe(300);
    expect(r?.row["amount_so"]).toBe(30);
    // 左端を1文字残す実装なら used が [XY, AX, Q]、合計 800 のほうで通ってしまう
    expect(m("AXYQ", 800)).toBeNull();
  });

  it("塗り潰しは拾った文字数ぶんを必ず1文字以上の空白に置き換える（幅0＝削除になると誤マッチする）", () => {
    /*
     * 上の2件は塗り潰しの「位置」の境界。こちらは「幅」の境界。
     * `" ".repeat(pname.length)` を `pname.length - 1` にすると、照合キーが1文字の
     * 商品を拾ったときだけ幅0＝削除と同じになり、前後がくっついて別候補が生まれる。
     *
     * 幅そのものに意味は無く、1文字以上あればよい（候補キーは keyOf で空白が
     * 落ちているので、空白をまたぐ一致は起こり得ない）。実際 `repeat(1)` に
     * 変えた実装と 484,000 通りで出力を突き合わせて差分ゼロを実測している。
     * ここで固定するのは「幅が 0 になり得ないこと」だけ。
     *
     * 候補の並び替えは keyOf 後ではなく生の名前の長さで行われるため、
     * 【】で嵩増しした「【単品】X」は照合キー1文字のまま候補の先頭に来る。
     */
    const m = buildProductMatcher([
      { name: "【単品】X", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "AB", price_incl_tax: 500, reward_target: "対象", amount_so: 50 },
      { name: "Q", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);

    // 「AXBQ」から X を塗り潰すと「A BQ」。AB は現れないので拾えるのは X と Q の2件
    const r = m("AXBQ", 300);
    expect(r?.used).toEqual(["【単品】X", "Q"]);
    expect(r?.row["price_incl_tax"]).toBe(300);
    expect(r?.row["amount_so"]).toBe(30);
    // 幅0で削除する実装なら「ABQ」になって AB が拾え、used が [X, AB, Q]、合計 800 で通ってしまう
    expect(m("AXBQ", 800)).toBeNull();
  });

  it("名前が空白や【】だけの行は、照合キーが空になるので候補から飛ばされる", () => {
    const m = buildProductMatcher([
      { name: "　", price_incl_tax: 999, reward_target: "対象", amount_so: 999 },
      { name: "【銀行振込】", price_incl_tax: 888, reward_target: "対象", amount_so: 888 },
      { name: null, price_incl_tax: 777, reward_target: "対象", amount_so: 777 },
      { name: "商品A", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "商品B", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);
    // 空キーを飛ばさないと indexOf("") が必ず 0 を返し、全部の行が拾われて合計が合わなくなる
    const r = m("商品A ／ 商品B", 300);
    expect(r?.used).toEqual(["商品A", "商品B"]);
    expect(r?.row["amount_so"]).toBe(30);

    /*
     * name:null の行は「照合キーが空になる」ことで飛ばされている。
     * s_ の null ガードを外すと String(null) = "null" がキーになり、受注名に
     * その4文字が現れたときだけ候補として拾えてしまう（金額が 777 円ぶん増える）。
     * DB は name not null なので実害は小さいが、飛ばしている理由を識別できる形で固定する。
     */
    const withNull = m("商品A ／ null ／ 商品B", 300);
    expect(withNull?.used).toEqual(["商品A", "商品B"]);
    expect(withNull?.row["price_incl_tax"]).toBe(300);
    // null 行を拾う実装なら合計 1,077 のほうで通ってしまう
    expect(m("商品A ／ null ／ 商品B", 1077)).toBeNull();
  });

  it("報酬対象外（事務手数料）の単価は合計に足されない。価格だけが足される", () => {
    const r = match("VIS本体 ／ 事務手数料", 188300);

    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual(["VIS本体", "事務手数料"]);
    expect(r?.row).toEqual({
      name: "VIS本体 ＋ 事務手数料",
      price_incl_tax: 188300, // 185,000 + 3,300（対象外でも価格は足す）
      reward_target: "対象", // 1つでも対象があれば対象
      amount_so: 77000, // 事務手数料の 1,000 は足さない
      amount_niji: 62700,
      amount_toritsugi: 27500,
      amount_hanbai: 55000,
    });
  });

  it("合成行が持つ列は name・price_incl_tax・reward_target と単価4列だけ（id や active は消える）", () => {
    const r = match("VIS本体 ／ 事務手数料", 188300);
    // 並び順（オブジェクトの構築順）は偶発的な性質なので、集合として比べる
    expect(Object.keys(r!.row).sort()).toEqual(
      ["name", "price_incl_tax", "reward_target", ...AMOUNT_COLUMNS].sort(),
    );
  });

  it("拾った税込価格の合計が決済額と1円でも違えば採らない（null）", () => {
    expect(match("VIS本体 ／ 事務手数料", 188301)).toBeNull();
    expect(match("VIS本体 ／ 事務手数料", 188299)).toBeNull();
  });

  it("拾えたのが1件だけなら分解しない。金額が合っていても null", () => {
    // 「VIS本体」しかマスタに無い並びなので、拾えるのは1件だけ
    expect(match("VIS本体 ／ 保護メガネ", 185000)).toBeNull();
  });

  it("マスタに同名の行が1件しか無いので、受注名に同じ商品名が2回出ても1件ぶんしか拾わない", () => {
    /*
     * これはアルゴリズムの性質ではなく、マスタ側の一意性に依存した結果。
     * products.name に unique 制約は無いので、同じキーの行が2件入ると崩れる
     * （「既知の欠陥」ブロックを参照）。
     */
    expect(match("VIS本体 ／ VIS本体 ／ 事務手数料", 373300)).toBeNull();
    const r = match("VIS本体 ／ VIS本体 ／ 事務手数料", 188300);
    expect(r?.used).toEqual(["VIS本体", "事務手数料"]);
  });

  it("長い商品名から先に拾うので、短い『VIS本体』に横取りされない", () => {
    const r = match(`${P_BODY_FEE.name} ／ ${P_OP1.name}`, 201500);
    // 「VIS本体」単品（id=1）ではなく、本体＋事務手数料（id=5）が採られている
    expect(r?.used).toContain(P_BODY_FEE.name);
    expect(r?.used).not.toContain("VIS本体");

    /*
     * これも宣言順（PRODUCTS では長い id=5 が短い id=1 より先）に助けられている。
     * 短い「VIS本体」を先頭に置いたマスタでも、長いほうが先に拾われることを確かめる。
     * 横取りされると used は [VIS本体, 事務手数料, OP①] になり、合計は同じ 201,500 円なので
     * 金額照合では気づけない（単価・報酬だけが id=5 ではなく id=1 のものにすり替わる）。
     */
    const shortFirst = buildProductMatcher([P_BODY, P_FEE, P_OP1, P_BODY_FEE]);
    expect(shortFirst(`${P_BODY_FEE.name} ／ ${P_OP1.name}`, 201500)?.used).toEqual([
      P_BODY_FEE.name,
      P_OP1.name,
    ]);
  });
});

describe("決済額と台数（quantity）", () => {
  const name = "VIS本体 ／ 事務手数料"; // 1セット 188,300 円

  it("1セットぶんの金額で送られてきたら、台数に関わらず通る", () => {
    expect(match(name, 188300)?.how).toBe("内訳への分解");
    expect(match(name, 188300, 2)?.how).toBe("内訳への分解");
  });

  it("台数を掛けた合計金額で送られてきても通る", () => {
    expect(match(name, 376600, 2)?.how).toBe("内訳への分解");
  });

  it("台数を掛けた合計で通ったときも、合成行の価格・単価は1セットぶんのまま", () => {
    const r = match(name, 376600, 2);
    expect(r?.row["price_incl_tax"]).toBe(188300);
    expect(r?.row["amount_so"]).toBe(77000);
  });

  it("台数と金額の関係が合わなければ null", () => {
    expect(match(name, 376600, 3)).toBeNull();
    expect(match(name, 376600)).toBeNull();
  });

  it("台数が 0・NaN でも結果は変わらない（amount>0 ガードで 1 台と同じ判定に潰れる）", () => {
    /*
     * 実装には `const q = quantity || 1` があるが、この `|| 1` は結果を変えていない。
     * ここに来る時点で amount > 0 が保証されており、q が falsy（0/NaN/null）なら
     * priceSum * q !== amount が常に真になるため、条件全体が priceSum !== amount に潰れて
     * q = 1 のときと同じ判定になる。
     * `|| 1` を外した実装と 9,936 通り（マスタ4種 × 商品名6種 × 決済額23種 × 台数18種）で
     * 出力を突き合わせ、差分ゼロを実測済み（＝等価）。
     * したがってこのテストは「0 を 1 に読み替えている」ことの検証ではない。
     */
    expect(match(name, 188300, 0)?.how).toBe("内訳への分解");
    expect(match(name, 376600, 0)).toBeNull();
    expect(match(name, 188300, Number.NaN)?.how).toBe("内訳への分解");
    expect(match(name, 376600, Number.NaN)).toBeNull();
  });
});

describe("引き当てられない入力", () => {
  it("商品名が空、空白だけ、【】だけなら null（金額を見るまでもない）", () => {
    expect(match("", 188300)).toBeNull();
    expect(match("　  ", 188300)).toBeNull();
    expect(match("【銀行振込】", 188300)).toBeNull();
  });

  it("照合キーが空になる商品名は、完全一致の表を引く前に止める（空キーの行に化けさせない）", () => {
    /*
     * 上のテストは PRODUCTS に「キーが空になる行」が無いので、
     * `if (!name) return null` を消しても分解側が空振りして null になり、
     * ガードの有無を区別できない。
     *
     * 商品マスタ側に「【銀行振込】」のような但し書きだけの行が紛れ込むと、
     * その行の照合キーも "" になって完全一致の表に登録される。
     * ガードを外すと、受注名が【】や空白だけのときにその行が引けてしまい、
     * まったく別の単価・報酬で決済が通る（実データでも【】付きの商品名は日常的に来る）。
     */
    const m = buildProductMatcher([
      { name: "【銀行振込】", price_incl_tax: 5000, reward_target: "対象", amount_so: 500 },
      { name: "商品A", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "商品B", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);

    // 対比: 中身のある受注名なら、ふつうに分解できるマスタである
    expect(m("商品A ／ 商品B", 300)?.used).toEqual(["商品A", "商品B"]);

    // 受注名の照合キーが空になる形は、金額に関わらずすべて null
    expect(m("", 5000)).toBeNull();
    expect(m("　  ", 5000)).toBeNull();
    expect(m("【銀行振込】", 5000)).toBeNull();
    expect(m("【アプラス（ローン）】", 5000)).toBeNull();
    // ガードを外すと上の4件が「【銀行振込】」の行に完全一致してしまう
  });

  it("完全一致しない商品名は、決済額が 0・マイナス・NaN なら分解を試みずに null", () => {
    const name = "VIS本体 ／ 事務手数料";
    expect(match(name, 0)).toBeNull();
    expect(match(name, -188300)).toBeNull();
    expect(match(name, Number.NaN)).toBeNull();
  });

  it("決済額 0 は、拾った合計も 0 なら「一致」してしまうので、分解に入る前に止める", () => {
    /*
     * 上のテストは PRODUCTS の単価が正なので「合計が合わない」からも null になり、
     * `if (!(amount > 0)) return null` の有無を区別できない。
     * 税込 0 円の行だけで組んだマスタなら priceSum も 0 になり、ガードを外すと
     * 0 === 0 で分解が成立してしまう。単価（amount_so）が付いていれば
     * 0 円決済から報酬が発生する。ガードが効いていることをここで固定する。
     */
    const m = buildProductMatcher([
      { name: "特典A", price_incl_tax: 0, reward_target: "対象", amount_so: 3000 },
      { name: "特典B", price_incl_tax: 0, reward_target: "対象", amount_so: 5000 },
    ]);

    expect(m("特典A ／ 特典B", 0)).toBeNull();
    // ガードは完全一致より後ろにあるので、完全一致なら 0 円でも引ける（対比）
    expect(m("特典A", 0)?.how).toBe("商品名の完全一致");
  });

  it("商品マスタが空なら、何を渡しても null", () => {
    const empty = buildProductMatcher([]);
    expect(empty(P_BODY_FEE.name, 188300)).toBeNull();
  });
});

describe("取扱中フラグ（active）の効き方", () => {
  it("取扱停止の商品は分解の候補に入らないので、旧仕様で金額が合っても引かれない", () => {
    // 185,000 + 5,500 = 190,500 だが「定期パッド配送」は active: false
    expect(match("VIS本体 ／ 定期パッド配送", 190500)).toBeNull();
  });

  it("どの行も active 列を持たない（select に入れていない）ときは、全件が分解の候補になる", () => {
    const noActive = PRODUCTS.map((p) => {
      const { active: _active, ...rest } = p;
      return rest as Record<string, unknown>;
    });
    const r = buildProductMatcher(noActive)("VIS本体 ／ 定期パッド配送", 190500);
    expect(r?.how).toBe("内訳への分解");
    // 名前が長い「定期パッド配送」から先に拾われる
    expect(r?.used).toEqual(["定期パッド配送", "VIS本体"]);
  });

  it("active が null / 未設定の行は「取扱中」として候補に残る（除外されるのは false だけ）", () => {
    // DB は `active boolean not null default true` なので null は来ない。防御的なテスト。
    const m = buildProductMatcher([
      { name: "商品X", price_incl_tax: 1000, reward_target: "対象", amount_so: 10, active: null },
      { name: "商品Y", price_incl_tax: 2000, reward_target: "対象", amount_so: 20 },
      { name: "商品Z", price_incl_tax: 4000, reward_target: "対象", amount_so: 40, active: false },
    ]);
    expect(m("商品X ／ 商品Y", 3000)?.used).toEqual(["商品X", "商品Y"]);
    expect(m("商品X ／ 商品Z", 5000)).toBeNull();
  });
});

describe("報酬対象フラグ（reward_target）の読み方", () => {
  it("「対象外」以外はすべて対象として扱われる。未設定・空文字でも単価が足される", () => {
    // DB は not null + check ('対象','対象外') なので未設定・空文字は来ない。防御的なテスト。
    const m = buildProductMatcher([
      { name: "本体A", price_incl_tax: 1000, amount_so: 500 }, // reward_target 未設定
      { name: "本体B", price_incl_tax: 2000, reward_target: "", amount_so: 300 }, // 空文字
    ]);
    const r = m("本体A ／ 本体B", 3000);
    expect(r?.row["reward_target"]).toBe("対象");
    expect(r?.row["amount_so"]).toBe(800); // 500 + 300 がどちらも足される
  });

  it("拾った全部が「対象外」なら、合成行も対象外で単価はすべて 0", () => {
    const m = buildProductMatcher([
      { name: "手数料A", price_incl_tax: 1000, reward_target: "対象外", amount_so: 500 },
      { name: "手数料B", price_incl_tax: 2000, reward_target: "対象外", amount_so: 300 },
    ]);
    const r = m("手数料A ／ 手数料B", 3000);
    expect(r?.row["reward_target"]).toBe("対象外");
    expect(r?.row["amount_so"]).toBe(0);
    expect(r?.row["price_incl_tax"]).toBe(3000); // 価格だけは足される
  });
});

describe("数値の読み方", () => {
  it("カンマの無い数値文字列（PostgREST の numeric）はそのまま数として扱える", () => {
    const m = buildProductMatcher([
      { name: "本体D", price_incl_tax: "185000", reward_target: "対象", amount_so: "77000" },
      { name: "手数料D", price_incl_tax: "3300", reward_target: "対象外", amount_so: "0" },
    ]);
    const r = m("本体D ／ 手数料D", 188300);
    expect(r?.row["price_incl_tax"]).toBe(188300);
    expect(r?.row["amount_so"]).toBe(77000);
  });
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】支払方法違いの2行が完全一致表で同じキーになり、後に登録した行しか引けない", () => {
    /*
     * 本来は「VIS本体【銀行振込】」と「VIS本体【アプラス（ローン）】」が別の行として引けるべき。
     * keyOf が位置を問わず【】を除去するため両者のキーが "VIS本体" で衝突し、Map が後勝ちする。
     * 直し方: 完全一致の表を【】付きのキーでも引けるようにする（両方のキーで登録する）か、
     *         マッチャ構築時に keyOf 衝突を検知して警告する。
     * 検知をすり抜ける理由: product-actions.ts の findByName は name の完全一致しか見ない。
     */
    const bank = { name: "VIS本体【銀行振込】", price_incl_tax: 185000, amount_so: 1 };
    const aplus = { name: "VIS本体【アプラス（ローン）】", price_incl_tax: 185000, amount_so: 2 };
    const m = buildProductMatcher([bank, aplus]);

    expect(m("VIS本体【銀行振込】", 185000)?.row).toBe(aplus);
    expect(m("VIS本体【アプラス（ローン）】", 185000)?.row).toBe(aplus);
  });

  it("【欠陥】キー衝突で取扱停止（active:false）の行が取扱中の行を覆い、停止済みの単価が返る", () => {
    /*
     * 本来は取扱中の行が優先されるべきで、少なくとも「どちらが後勝ちするか」が
     * products の取得順で変わってはいけない。
     * 取得順は呼び出し元でバラバラ（rewards.ts / admin の受注詳細は order=id 付き、
     * orders.ts / 受注一覧は指定なしで PostgREST の行順は未規定）なので、
     * 同じ受注でも報酬計上と画面表示で違う行が採られ得る。
     * 直し方: 全呼び出し元に order=id を付けて後勝ちを決定的にしたうえで、上の欠陥を潰す。
     */
    const inUse = { name: "パッド", price_incl_tax: 5500, reward_target: "対象", amount_so: 1650, active: true };
    const stopped = { name: "パッド【旧仕様】", price_incl_tax: 9999, reward_target: "対象", amount_so: 9, active: false };
    const m = buildProductMatcher([inUse, stopped]);

    const r = m("パッド", 5500);
    expect(r?.row).toBe(stopped);
    expect(r?.row["price_incl_tax"]).toBe(9999); // 取扱中の 5,500 ではない
  });

  it("【欠陥】分解の並べ替えが生の文字数なので、空白入りの短い商品名が先に採られる", () => {
    /*
     * 本来は照合に使うキーの長さ（keyOf(name).length）で並べ替えるべき。
     * 直し方: candidates の sort を s_(b,"name").length ではなく
     *         keyOf(s_(b,"name")).length で比較する（1行）。
     * 現行マスタでは発火しない（キー長が十分離れている）が、
     * 「空白入りの短い名前」と「空白なしの長い名前」がキー長6文字以内に並ぶと顕在化する。
     */
    // 「眼筋 トレーニング マシン」は空白込み13文字。空白を詰めると11文字で、
    // 「眼筋トレーニングマシンV」（12文字）より短いのに、先に拾われてしまう。
    const spaced = { name: "眼筋 トレーニング マシン", price_incl_tax: 100000, amount_so: 10000 };
    const longer = { name: "眼筋トレーニングマシンV", price_incl_tax: 150000, amount_so: 20000 };
    const fee = { name: "事務手数料", price_incl_tax: 3300, reward_target: "対象外", amount_so: 0 };
    const m = buildProductMatcher([spaced, longer, fee]);

    const orderName = "眼筋トレーニングマシンV ／ 事務手数料";

    expect(m(orderName, 103300)?.used).toEqual(["眼筋 トレーニング マシン", "事務手数料"]);
    // その結果、本来の内訳（longer 150,000 ＋ 3,300）で決済されていても引き当てられない
    expect(m(orderName, 153300)).toBeNull();
  });

  it("【欠陥】拾い残しを検証しないので、未知の商品が混ざった受注名でも分解が成立する", () => {
    /*
     * 本来は rest（塗り潰しきれずに残った文字列）があれば null を返すべき。
     * 実装は「拾えた商品の合計が決済額と一致するか」しか見ないため、
     * 認識できなかった商品が受注名に含まれていても検出できない。
     * rewards.ts:229 の `if (!basis) return 0` により、引き当ての成否は受注1件の
     * 報酬全体を左右する。「引けなさすぎる」より「引けてはいけないのに引ける」ほうが危ない。
     */
    const m = buildProductMatcher([
      { name: "商品A", price_incl_tax: 100, reward_target: "対象", amount_so: 10 },
      { name: "商品B", price_incl_tax: 200, reward_target: "対象", amount_so: 20 },
    ]);

    const r = m("商品A ／ 商品B ／ 未知の高額商品", 300);
    expect(r?.how).toBe("内訳への分解");
    expect(r?.used).toEqual(["商品A", "商品B"]);
  });

  it("【欠陥】マスタに同じキーの行が2件あると、同じ商品名を2回拾って二重計上する", () => {
    /*
     * 本来は同一商品を二度数えないか、そもそも重複登録を防ぐべき（products.name は unique が無い）。
     * 直し方: DB 側に一意制約を入れる。難しければ used に同じ行が入らないようにする。
     * 上の【】キー衝突と組み合わさると、見た目が違う2行でも同じキーになるため起きやすい。
     */
    const body1 = { name: "VIS本体", price_incl_tax: 185000, reward_target: "対象", amount_so: 77000 };
    const body2 = { name: "VIS本体", price_incl_tax: 185000, reward_target: "対象", amount_so: 77000 };
    const fee = { name: "事務手数料", price_incl_tax: 3300, reward_target: "対象外", amount_so: 1000 };
    const m = buildProductMatcher([body1, body2, fee]);

    const r = m("VIS本体 ／ VIS本体 ／ 事務手数料", 373300);
    expect(r?.used).toEqual(["VIS本体", "VIS本体", "事務手数料"]);
    expect(r?.row["price_incl_tax"]).toBe(373300);
    expect(r?.row["amount_so"]).toBe(154000); // 77,000 が2回足されている
  });

  it("【欠陥】価格がカンマ入り文字列だと黙って 0 として合計される", () => {
    /*
     * 本来は数値として解釈できない値を 0 に丸めず、引き当て失敗として扱うべき。
     * price_incl_tax は integer 列なので DB 経由では到達しないが、
     * 「文字列が来たら黙って 0」という読み方自体は n_ の実装として残っている。
     */
    const m = buildProductMatcher([
      { name: "本体C", price_incl_tax: "185,000", reward_target: "対象", amount_so: 100 },
      { name: "手数料C", price_incl_tax: 3300, reward_target: "対象外", amount_so: 0 },
    ]);
    // 正しい合計 188,300 では通らず
    expect(m("本体C ／ 手数料C", 188300)).toBeNull();
    // カンマ入りを 0 とみなした 3,300 でだけ通る
    expect(m("本体C ／ 手数料C", 3300)?.row["price_incl_tax"]).toBe(3300);
  });
});
