import { describe, expect, it } from "vitest";

import {
  PAY_ITEMS,
  PAY_ITEM_HINT,
  PAY_ITEM_LABEL,
  payItemsOf,
  type PayItem,
} from "./pay-items";
import { itemNameFor } from "./yamato-csv";
import type { ShipperConfig } from "./yamato";

/**
 * pay-items.ts は「受注の商品名（1本の文字列）」から支払対象の品目を読み取る。
 *
 * ■ このファイルの読み方
 *
 * 前半は「こう動くべき」を書いた仕様のテスト。
 * 末尾の「既知の欠陥」ブロックは「今こう動いてしまう」ことの記録で、
 * 通っていることは正しさを意味しない。実装を直したらブロックごと更新する。
 *
 * ■ 金銭リスクの向き
 *
 * 取り逃がし（false negative）… 支払額が 0 円になる。画面には出ないまま消える。
 * 拾いすぎ（false positive） … 過払いになる。0 円と違って誰も気づかない。
 * 両方向を見る。
 */

/* ══════════════════ 商品マスタの実データ ══════════════════ */

/**
 * 実データとして出典を確認できた商品名。
 *
 * pay-items.ts の冒頭は「商品マスタに実際に入っている名前から採った」と書くが、
 * その商品マスタ（Supabase products）はリポジトリに入っていない。
 * そこでリポジトリ内・引き継ぎメモに出典がある名前だけをここに写して、
 * 「取扱中の商品で支払品目が引けなくなっていないか」を機械的に見張る。
 *
 * 出典:
 *   a) ~/workspace/notes/mem0-export/目トレ.md（2026-08-15 / 08-19 / 08-28 の記録）
 *   b) src/lib/product-match.ts / product-match.test.ts の実データコメント
 *   c) src/lib/pay-items.ts 冒頭の実例
 *
 * ※ これは商品マスタの全件ではない（全件はリポジトリ外）。
 *    マスタに商品を足したら、ここにも足すこと。
 */
const 商品マスタ実データ: ReadonlyArray<{ name: string; expected: PayItem[]; 出典: string }> = [
  // ── 本体系 ──
  { name: "VIS本体", expected: ["body"], 出典: "products id=?（product-match.test.ts の実データ）" },
  {
    name: "VIS本体／ 事務手数料",
    出典: "orders.product_name の実データ（2026-08-28）",
    expected: ["body"],
  },
  {
    name: "眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円",
    出典: "products id=5",
    expected: ["body"],
  },
  { name: "VIS本体 先行予約 ／ 事務手数料", 出典: "products id=23", expected: ["body"] },
  {
    name: "眼筋トレーニングマシンVIS本体／事務手数料【銀行振込】",
    出典: "支払方法ごとの商品行（2026-08-28）",
    expected: ["body"],
  },
  {
    name: "VIS本体／事務手数料【アプラス（ローン）】",
    出典: "支払方法ごとの商品行（2026-08-28）",
    expected: ["body"],
  },
  // ── 本体＋オプションの結合レコード ──
  {
    name: "VIS本体／事務手数料／OP①(２年目ジェルパット)",
    出典: "pay-items.ts / product-match.ts の実例",
    expected: ["body", "op1"],
  },
  {
    name: "VIS本体／事務手数料／OP②(３年延長保証)／OP①(２年目ジェルパット)",
    出典: "orders.product_name の実データ（2026-08-28）",
    expected: ["body", "op1", "op2"],
  },
  {
    name: "眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円 ／ 3年保証セット（OP②）",
    出典: "products id=3",
    expected: ["body", "op2"],
  },
  {
    name: "VIS本体 先行予約 ／ 事務手数料 ／ ジェルパッド1年分 先行購入（OP①・13,200円）",
    出典: "products id=24",
    expected: ["body", "op1"],
  },
  {
    name: "VIS本体 先行予約 ／ 事務手数料 ／ 3年保証セット ／ ジェルパッド1年分 先行購入（OP①・13,200円）",
    出典: "products id=25",
    expected: ["body", "op1", "op2"],
  },
  // ── オプション単品 ──
  { name: "3年保証セット（OP②）", 出典: "products id=15", expected: ["op2"] },
  {
    name: "ジェルパッド1年分 先行購入（OP①・13,200円）",
    出典: "products id=21",
    expected: ["op1"],
  },
  {
    name: "OP① ジェルパッド1年分を追加する（通常17,500円 → 13,200円）",
    出典: "products id=22",
    expected: ["op1"],
  },
  // ── 単体購入（QR2 の入り口・2026-08-27 追加） ──
  { name: "単体／追加パッド(１年分)", 出典: "QR2 単体購入", expected: ["padYearly"] },
  { name: "単体／追加保証(３年分)", 出典: "QR2 単体購入", expected: ["op2"] },
  // ── 取扱停止（active=false）だが受注済みの過去分は残る ──
  { name: "定期パッド配送", 出典: "products id=13（取扱停止）", expected: ["padYearly"] },
  {
    name: "定期パッド配送（VIS用・初年度無料・翌年から17,500円/年）",
    出典: "products id=2（取扱停止）",
    expected: ["padYearly"],
  },
  {
    name: "OP① 定期パッド配送（初年度0円・2年目以降は年1回お届け）",
    出典: "products id=1（取扱停止）",
    expected: ["op1", "padYearly"],
  },
];

/* ══════════════════ 品目の定義 ══════════════════ */

describe("品目の定義（PAY_ITEMS / ラベル / 説明）", () => {
  it("品目は body・op1・op2・padYearly の4つで、この順に並んでいる", () => {
    // この並びは画面（PayUnitCell）と支払通知書の行の並びそのもの。
    expect(PAY_ITEMS).toEqual(["body", "op1", "op2", "padYearly"]);
  });

  /*
   * 以下2件は実装の値をそのまま書いた「金額票の見本」。
   * 独立に計算できる値ではないが、この文字列は代理店に送る支払通知書に
   * そのまま印字される（rewards/notice/page.tsx）ので、
   * 黙って書き換わらないよう固定しておく意味がある。
   */
  it("支払通知書に印字するラベルは4品目ぶん、この文字で固定されている", () => {
    expect(PAY_ITEM_LABEL).toEqual({
      body: "本体価格",
      op1: "OP①",
      op2: "OP②",
      padYearly: "1年後定期",
    });
  });

  it("画面に添える説明は4品目ぶん、この文字で固定されている", () => {
    expect(PAY_ITEM_HINT).toEqual({
      body: "VIS本体1台あたり",
      op1: "ジェルパッド1年分",
      op2: "延長保証（3年保証）",
      padYearly: "定期購入のパッド",
    });
  });

  it("ラベルは4つとも別の文字である（支払通知書で同じ行名が2つ出ない）", () => {
    const labels = PAY_ITEMS.map((i) => PAY_ITEM_LABEL[i]);
    expect(new Set(labels).size).toBe(PAY_ITEMS.length);
  });
});

/* ══════════════════ 商品マスタの全件チェック ══════════════════ */

describe("payItemsOf — 商品マスタの実データ（取りこぼしの見張り）", () => {
  it.each(商品マスタ実データ.map((p) => [p.name, p.expected, p.出典] as const))(
    "「%s」 → %j",
    (name, expected) => {
      expect(payItemsOf(name)).toEqual(expected);
    },
  );

  it("実データの商品名で空配列になるものは1件も無い（＝支払額が黙って0円になる商品が無い）", () => {
    const 拾えない = 商品マスタ実データ.filter((p) => payItemsOf(p.name).length === 0);
    expect(拾えない.map((p) => p.name)).toEqual([]);
  });

  it("本体を含む商品名では必ず body が先頭に来る（支払通知書の行順が崩れない）", () => {
    const 本体入り = 商品マスタ実データ.filter((p) => p.expected.includes("body"));
    expect(本体入り.length).toBeGreaterThan(0);
    for (const p of 本体入り) expect(payItemsOf(p.name)[0]).toBe("body");
  });

  it("事務手数料だけの商品は品目に数えない（お客様から預かるだけで支払対象ではない）", () => {
    expect(payItemsOf("事務手数料")).toEqual([]);
    expect(payItemsOf("事務手数料　3,300円")).toEqual([]);
  });
});

/* ══════════════════ 組み合わせ商品名 ══════════════════ */

describe("payItemsOf — 実データの組み合わせ商品名", () => {
  it("本体＋事務手数料＋3年保証セット＋ジェルパッド1年分 → 本体・OP①・OP②（事務手数料は数えない）", () => {
    const name =
      "VIS本体　先行予約 ／ 事務手数料 ／ 3年保証セット ／ ジェルパッド1年分 先行購入（OP①・13,200円）";
    expect(payItemsOf(name)).toEqual(["body", "op1", "op2"]);
  });

  it("眼筋トレーニングマシンVIS本体＋事務手数料 → 本体だけ（オプション無し）", () => {
    expect(payItemsOf("眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円")).toEqual([
      "body",
    ]);
  });

  it("支払方法の但し書き【銀行振込】が付いていても判定は変わらない", () => {
    expect(payItemsOf("眼筋トレーニングマシンVIS本体／事務手数料【銀行振込】")).toEqual(["body"]);
  });

  it("本体・OP①・OP②・1年後定期がすべて含まれる名前 → 4品目すべて", () => {
    const name = "VIS本体 ／ 事務手数料 ／ OP①ジェルパッド1年分 ／ OP②延長保証 ／ 追加パッド";
    expect(payItemsOf(name)).toEqual(["body", "op1", "op2", "padYearly"]);
  });

  it("単体購入の2品を同時に買っても、本体は付かず OP②と1年後定期になる", () => {
    expect(payItemsOf("単体／追加保証(３年分) ／ 単体／追加パッド(１年分)")).toEqual([
      "op2",
      "padYearly",
    ]);
  });
});

/* ══════════════════ 本体の見分け方 ══════════════════ */

describe("payItemsOf — 本体の見分け方", () => {
  it.each([
    ["VIS本体", ["body"]],
    ["眼筋トレーニングマシン", ["body"]],
    ["眼筋トレーニングマシンVIS本体", ["body"]],
  ])("「%s」 → %j", (name, expected) => {
    expect(payItemsOf(name)).toEqual(expected);
  });

  it("小文字の「vis本体」は本体と見なされない（product-match.ts と同じく大文字小文字を区別する）", () => {
    // product-match.test.ts:182 も同じ方針。ここだけ緩めると引き当てと支払で基準がずれる。
    expect(payItemsOf("vis本体 ／ 事務手数料")).toEqual([]);
  });

  it("本体の言葉が名前の途中にあっても拾う（前後に何が付いていてもよい）", () => {
    expect(payItemsOf("【2026年モデル】眼筋トレーニングマシンVIS本体 ／ 事務手数料")).toEqual([
      "body",
    ]);
  });
});

/* ══════════════════ 表記ゆれ ══════════════════ */

/*
 * ここは正規表現の選択肢を1つずつ確かめる。実装の写経に見えるが、
 * どの選択肢がどの実データ由来かを添えることで「消してよい選択肢か」を判断できる。
 * 選択肢を1つ削ると、必ずここが赤くなる。
 */
describe("payItemsOf — 表記ゆれで拾えるもの", () => {
  it.each([
    ["ジェルパッド1年分", "products id=21「ジェルパッド1年分 先行購入（OP①・13,200円）」"],
    ["ジェルパット", "orders 実データ「OP①(２年目ジェルパット)」の誤記表記"],
    ["OP①", "orders 実データ「OP①(２年目ジェルパット)」"],
    ["２年目ジェルパット", "orders 実データの派生形"],
  ])("OP①は「%s」を含めば拾える（出典: %s）", (name) => {
    expect(payItemsOf(name)).toEqual(["op1"]);
  });

  it.each([
    ["延長保証", "orders 実データ「OP②(３年延長保証)」"],
    ["3年保証", "products id=15「3年保証セット（OP②）」"],
    ["３年保証", "全角の実データ表記"],
    ["追加保証", "QR2 単体購入「単体／追加保証(３年分)」"],
    ["OP②", "orders 実データ「OP②(３年延長保証)」"],
    ["3年保証セット", "products id=15 の派生形"],
  ])("OP②は「%s」を含めば拾える（出典: %s）", (name) => {
    expect(payItemsOf(name)).toEqual(["op2"]);
  });

  it.each([
    ["定期パッド配送", "products id=13（取扱停止）"],
    ["追加パッド", "QR2 単体購入「単体／追加パッド(１年分)」"],
    ["定期パッド", "products id=13 の派生形"],
  ])("1年後定期は「%s」を含めば拾える（出典: %s）", (name) => {
    expect(payItemsOf(name)).toEqual(["padYearly"]);
  });
});

/* ══════════════════ 拾いすぎない（過払いを防ぐ） ══════════════════ */

/*
 * 取り逃がし（0円）は画面で気づけることがあるが、拾いすぎ（過払い）は
 * 正しく見えたまま金が出ていく。「似ているが違う言葉」を混ぜて確認する。
 */
describe("payItemsOf — 拾いすぎない", () => {
  it.each([
    ["保証", "「保証」だけでは OP② にならない"],
    ["保証書", "同梱の保証書は OP② ではない"],
    ["1年保証", "標準の1年保証は OP②（3年保証）ではない"],
    ["メーカー保証", "OP② ではない"],
  ])("「%s」はどの品目にも数えない（%s）", (name) => {
    expect(payItemsOf(name)).toEqual([]);
  });

  it.each([
    ["パッド", "「パッド」だけでは 1年後定期にならない"],
    ["ジェルパッド交換", "交換対応は定期購入ではない"],
    ["パッド在庫", "定期購入ではない"],
  ])("「%s」はどの品目にも数えない（%s）", (name) => {
    expect(payItemsOf(name)).toEqual([]);
  });

  it("半角の「OP1」「OP2」は拾わない（実データは丸数字なので、半角は別物として扱う）", () => {
    expect(payItemsOf("OP1 ／ OP2")).toEqual([]);
  });

  it("本体を買っていない受注に body は付かない（パッド単品で本体ぶんを払わない）", () => {
    expect(payItemsOf("単体／追加パッド(１年分)")).not.toContain("body");
    expect(payItemsOf("3年保証セット（OP②）")).not.toContain("body");
  });

  it("OP① だけの受注に OP② は付かない（オプション同士が混ざらない）", () => {
    expect(payItemsOf("ジェルパッド1年分 先行購入（OP①・13,200円）")).toEqual(["op1"]);
  });
});

/* ══════════════════ 判定語の境界（過払いの分かれ目） ══════════════════ */

/*
 * 上の「拾いすぎない」は決め打ちの語で見張っているが、それだけでは
 * 「判定語をあと1語ぶん短くしても誰も気づかない」という穴が残る。
 * ここでは判定語を1つずつ取り上げ、「そこまで短くしたら当たってしまう
 * 実在しそうな商品名」を反例として固定する。実装の正規表現をこれ以上
 * 短くすると、必ずここが赤くなる。
 *
 * 向きはすべて過払い（false positive）側。取り逃がしと違って画面には
 * 何も出ないまま、金額だけが増える。
 */

describe("payItemsOf — 判定語をこれ以上短くすると当たってしまう境界", () => {
  it("body は「眼筋トレーニングマシン」まで一致して初めて本体（「眼筋トレーニング」では本体にしない）", () => {
    // 「眼筋トレーニング」で本体と見なすと、本体を買っていない受注に
    // 本体ぶん（185,000円）の支払が立つ。ここは OP① だけの受注。
    expect(payItemsOf("眼筋トレーニング用ジェルパッド1年分")).toEqual(["op1"]);
  });

  it("body は「マシン」だけでは本体にしない（周辺機器を本体と取り違えない）", () => {
    // 「マシン」まで短くすると、本体でない付属品の受注に本体ぶんの支払が立つ。
    expect(payItemsOf("トレーニングマシン用スタンド（別売）")).toEqual([]);
  });

  it("padYearly は「定期」だけでは数えない（パッドの語まで一致して初めて定期購入）", () => {
    // 「定期」まで短くすると、定期便の送料や事務手数料だけの受注に
    // パッド1年ぶん（17,500円）の支払が立つ。
    expect(payItemsOf("定期便送料 ／ 事務手数料")).toEqual([]);
  });

  it("op1 は「1年分」だけでは数えない（定期パッドの受注に OP① を重ねて二重計上しない）", () => {
    // 「1年分」まで短くすると、1年後定期のパッド受注が OP① にも数えられ、
    // 同じ1回の受注に padYearly と op1 の両方が立つ（二重計上）。
    // 半角の「1年分」で書く根拠: 実データの商品名には半角の「3年保証セット」が現に存在し、
    // 全角「１年分」だけが来るとは限らない（products id=15）。
    expect(payItemsOf("単体／追加パッド(1年分)")).toEqual(["padYearly"]);
  });

  it("op2 は「延長」だけでは数えない（保証の語まで一致して初めて延長保証）", () => {
    // 「延長」まで短くすると、延長ケーブルのような付属品が付いた本体受注に
    // OP②ぶんの支払が上乗せされる。本体だけを数えるのが正しい。
    expect(payItemsOf("VIS本体 ／ 延長ケーブル")).toEqual(["body"]);
  });

  it("op2 は半角の「3年」だけでは数えない（保証の語まで一致して初めて延長保証）", () => {
    // 「3年保証」を「3年」まで短くすると、支払回数や期間の但し書きが OP② に化ける。
    // 実データの商品名には金額・期間の但し書きが普通に入る（products id=5 の「185,000円」など）。
    expect(payItemsOf("VIS本体 ／ 事務手数料 ／ 3年分割払い")).toEqual(["body"]);
  });

  it("op2 は全角の「３年」だけでも数えない（３年保証も半角と同じ境界を持つ）", () => {
    // 全角側だけ緩むと、実データに全角表記（「単体／追加保証(３年分)」）がある以上こちらが当たる。
    expect(payItemsOf("VIS本体 ／ 事務手数料 ／ ３年分割払い")).toEqual(["body"]);
  });

  it("op2 は丸数字の「②」だけでは数えない（箇条書きの番号を OP② と取り違えない）", () => {
    // 「OP②」から OP を落とすと、番号を振って並べただけの商品名に OP②ぶんが上乗せされる。
    expect(payItemsOf("VIS本体 ／ ①事務手数料 ／ ②送料")).toEqual(["body"]);
  });

  it("op1 は「パッド1年分」まで短くしても数えない（括弧の無い定期パッド表記で二重計上しない）", () => {
    // 実データは「単体／追加パッド(１年分)」と括弧付きだが、括弧の無い書き方で来ると
    // 「パッド1年分」まで短くした判定語に当たり、padYearly と op1 の二重計上になる。
    expect(payItemsOf("単体／追加パッド1年分")).toEqual(["padYearly"]);
  });
});

/* ══════════════════ 該当なし・異常入力 ══════════════════ */

describe("payItemsOf — 該当なし", () => {
  it.each([
    ["", "空文字"],
    ["   ", "空白だけ"],
    ["　", "全角空白だけ"],
    ["送料 ／ 代引き手数料", "関係のない商品名"],
    ["キャンセル", "商品名ですらない値"],
  ])("「%s」は空配列を返す（%s）", (name) => {
    expect(payItemsOf(name)).toEqual([]);
  });

  it("null / undefined を渡しても落ちずに空配列を返す（DB の null がそのまま来る経路がある）", () => {
    // 注意: この2行は実装の `productName || ""` ガードを見張れていない。
    // ガードを外しても null/undefined は RegExp.test 側で "null" "undefined" に
    // 文字列化されるだけで、どちらも品目語を含まないため出力は変わらない
    // （falsy 全種・ラッパー・Symbol まで振って実測で一致を確認済み）。
    // 「落ちないこと」の記録として残しているだけで、検出力は無い。
    expect(payItemsOf(null as unknown as string)).toEqual([]);
    expect(payItemsOf(undefined as unknown as string)).toEqual([]);
  });

  it("数値や配列が紛れ込んでも落ちない（Webhook の JSON が想定と違う型で来ることがある）", () => {
    expect(() => payItemsOf(0 as unknown as string)).not.toThrow();
    expect(payItemsOf(0 as unknown as string)).toEqual([]);
    expect(() => payItemsOf(["VIS本体"] as unknown as string)).not.toThrow();
  });

  it("非常に長い商品名でも落ちず、含まれる品目を返す（UTAGE の連結名は際限なく伸びる）", () => {
    const long = "あ".repeat(5000) + "VIS本体" + "い".repeat(5000);
    expect(payItemsOf(long)).toEqual(["body"]);
  });
});

/* ══════════════════ 戻り値の性質 ══════════════════ */

describe("payItemsOf — 戻り値の性質", () => {
  it("並び順は商品名の登場順によらず body → op1 → op2 → padYearly に正規化される", () => {
    const name = "追加パッド ／ OP② ／ OP① ／ VIS本体";
    expect(payItemsOf(name)).toEqual(["body", "op1", "op2", "padYearly"]);
  });

  it("同じ品目が2回出てきても1つにまとまる（台数ぶんの二重計上をしない）", () => {
    expect(payItemsOf("VIS本体 ／ VIS本体 ／ OP① ／ ジェルパッド1年分")).toEqual(["body", "op1"]);
  });

  it("違う表記が同じ品目を指していても1つにまとまる（延長保証と3年保証）", () => {
    expect(payItemsOf("VIS本体 ／ 延長保証 ／ 3年保証セット")).toEqual(["body", "op2"]);
  });

  it("返る値はすべて PAY_ITEMS に含まれる品目である", () => {
    const items: PayItem[] = payItemsOf(
      "VIS本体 ／ 事務手数料 ／ OP①ジェルパッド1年分 ／ 延長保証 ／ 定期パッド配送",
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(PAY_ITEMS).toContain(item);
  });
});

/* ══════════════════ モジュール間の食い違い ══════════════════ */

/*
 * この機能の金銭リスクの本体は「同じ商品名を、モジュールごとに別解釈すること」。
 * 各モジュールを別々にテストしていると食い違いはどこにも現れないので、
 * ここで横断の不変条件として書く。
 *
 * yamato-csv.itemNameFor は「パッドだけの発送か」を商品名から判定して
 * 送り状の品名を出し分ける（/パッド|パット/ かつ 本体を含まない → パッド扱い）。
 * 送り状にパッドと印字して発送する以上、支払側もパッド系の品目を1つは
 * 数えていないと、発送はしたのに支払額が0円という状態になる。
 */
const 送り状設定 = {
  invoiceCode: "093456789012",
  invoiceCodeExt: "001",
  invoiceFreightNo: "01",
  shipper: {
    name: "目のトレーニング株式会社",
    zip: "104-0061",
    address: "東京都中央区銀座1-2-3",
    tel: "03-9999-8888",
  },
  itemName: "眼筋トレーニングマシンVIS",
  printerType: "1",
} as ShipperConfig;

/** 送り状に「ジェルパッド1年分」と印字される＝パッドだけの発送と判定された。 */
const 送り状はパッド扱い = (name: string) => itemNameFor(送り状設定, name) === "ジェルパッド1年分";

describe("モジュール間の食い違い（yamato-csv とのつき合わせ）", () => {
  it.each([
    "単体／追加パッド(１年分)",
    "ジェルパッド1年分 先行購入（OP①・13,200円）",
    "定期パッド配送",
    "OP① ジェルパッド1年分を追加する（通常17,500円 → 13,200円）",
  ])("送り状がパッド発送と判定する「%s」は、支払側も OP①か1年後定期を数える", (name) => {
    expect(送り状はパッド扱い(name)).toBe(true);
    const items = payItemsOf(name);
    expect(items.some((i) => i === "op1" || i === "padYearly")).toBe(true);
  });

  it.each(商品マスタ実データ.filter((p) => p.expected.includes("body")).map((p) => p.name))(
    "支払側が本体を数える「%s」を、送り状はパッド発送と判定しない",
    (name) => {
      expect(payItemsOf(name)).toContain("body");
      expect(送り状はパッド扱い(name)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  /* ── 取り逃がし（支払額が0円になる向き） ── */

  it("【欠陥】「追加パット」（ト）を1年後定期として拾わず、単体購入の支払額が0円で確定する", () => {
    // 本来は ["padYearly"] を返すべき。
    // 同じリポジトリの pad-subscription.ts:47 は /単体|追加パッド|追加パット/、
    // yamato-csv.ts:57 は /パッド|パット/ と、ト表記を前提に書かれている。
    // 影響: pay-defaults.ts payoutForOrder は items が空だと null ではなく 0 を返し、
    //       rewards/notice/page.tsx:177 は行そのものを作らないので、
    //       支払通知書からその受注が「—」も出さずに黙って消える。
    expect(payItemsOf("単体／追加パット(１年分)")).toEqual([]);
  });

  it("【欠陥】送り状はパッド発送と印字するのに、支払側は「追加パット」を1品目も数えない", () => {
    // 上と同じ原因を、モジュール横断の不変条件の側から記録したもの。
    // 本来は「送り状がパッド扱い ⇒ 支払も op1 か padYearly を数える」が常に成り立つべき。
    const name = "単体／追加パット(１年分)";
    expect(送り状はパッド扱い(name)).toBe(true);
    expect(payItemsOf(name)).toEqual([]);
  });

  it("【欠陥】OP① の全角「ジェルパッド１年分」を拾わない（OP② は半角/全角の両方を持つのに非対称）", () => {
    // 本来は ["op1"] を返すべき。OP② は 3年保証／３年保証 の両方を持つ。
    // 到達条件: 名前に「OP①」も「ジェルパット」も含まれず、かつ全角の１ を使うこと。
    //          実在する OP① 系のマスタ名はいずれも「OP①」を含むため、
    //          現在の実データでは到達しない（＝表記統一の問題であって、いま漏れてはいない）。
    expect(payItemsOf("ジェルパッド１年分")).toEqual([]);
  });

  it("【欠陥】正しい表記「ジェルパッド」単独を拾わず、誤記の「ジェルパット」単独は拾う（逆転している）", () => {
    // 本来はどちらも ["op1"]。正しい表記だけが落ちるのは、あとから見て理由が説明できない。
    // 到達条件: 名前に「OP①」も「1年分」も含まれないこと。実データ上の経路は未確認。
    // 2行目は欠陥ではなく、1行目との対比のために置いている
    // （「ジェルパット」が拾えること自体は表記ゆれ節と同じく正しい挙動）。
    expect(payItemsOf("ジェルパッド")).toEqual([]);
    expect(payItemsOf("ジェルパット")).toEqual(["op1"]);
  });

  it("【欠陥】「２年目ジェルパッド」（ド）を OP① として拾わない", () => {
    // 本来は ["body", "op1"]。実装が見ているのは「ジェルパット」（ト）だけ。
    // 到達条件: 「OP①」を含まないこと。実在するマスタ名は
    //          「VIS本体／事務手数料／OP①(２年目ジェルパット)」で OP① を含むため、
    //          現在の実データでは到達しない（人工的な入力での再現）。
    expect(payItemsOf("VIS本体／事務手数料／(２年目ジェルパッド)")).toEqual(["body"]);
  });

  it.each([
    ["VIS 本体 ／ 事務手数料", "半角スペース"],
    ["VIS　本体 ／ 事務手数料", "全角スペース"],
    ["ＶＩＳ本体 ／ 事務手数料", "全角英字"],
    ["ＯＰ① ／ 事務手数料", "全角の OP"],
  ])("【欠陥】「%s」を取り逃がす（%s の正規化をしていない）", (name) => {
    // 本来は空白や全角英字を落としてから照合すべき。
    // 同じリポジトリの product-match.ts:101 keyOf は【】と [\s　]+ を除いてから
    // 突き合わせている。前処理ゼロの pay-items 側とで基準が2か所にずれている。
    expect(payItemsOf(name)).toEqual([]);
  });

  it("【欠陥】「本体」単独を body と見なさない（pad-subscription.ts は同じ名前を本体受注と見なす）", () => {
    // 本来はどちらかに統一すべき。pad-subscription.ts:44 の isMainUnitOrder は
    // /本体/ だけで本体受注と判定するので、この名前だと
    // 「1年後の定期パッド配送は仕込まれるのに、本体ぶんの支払は0円」が原理上ありうる。
    // ※「本体」単独が実データに存在する証拠は未確認（潜在的な基準ずれの記録）。
    expect(payItemsOf("本体 ／ 事務手数料")).toEqual([]);
  });

  /* ── 拾いすぎ（過払いになる向き） ── */

  it("【欠陥】本体名に保証の説明が入っただけで OP② を数える（過払い・誰も気づかない）", () => {
    // 本来は ["body"]。3年保証が標準で付くという説明であって、OP② を買ってはいない。
    expect(payItemsOf("VIS本体（3年保証標準付帯） ／ 事務手数料")).toEqual(["body", "op2"]);
  });

  it("【欠陥】「延長保証は付けません」と書いてあっても OP② を数える（否定形を読まない）", () => {
    // 本来は ["body"]。
    expect(payItemsOf("眼筋トレーニングマシンVIS本体 ／ 延長保証は付けません")).toEqual([
      "body",
      "op2",
    ]);
  });

  it("【欠陥】「OP①キャンセル」でも OP① を数える（取り消しを読まない）", () => {
    // 本来は []。返金された受注に対して支払が立つ。
    expect(payItemsOf("OP①キャンセル ／ 返金")).toEqual(["op1"]);
  });

  it("【欠陥】「OP②延長保証（キャンセル）」でも OP② を数える", () => {
    // 本来は ["body"]。
    expect(payItemsOf("VIS本体 ／ 事務手数料 ／ OP②延長保証（キャンセル）")).toEqual([
      "body",
      "op2",
    ]);
  });

  /* ── そのほか ── */

  it("【欠陥】PAY_ITEMS は凍結されていない共有配列（読み込んだ側から書き換えられる）", () => {
    // 本来は `as const` か Object.freeze で不変にすべき。
    // いまは PayUnitCell.tsx が map するだけなので実害は出ていない。
    // ここでは実際に壊さず、凍結されていないことだけを記録する。
    expect(Object.isFrozen(PAY_ITEMS)).toBe(false);
  });
});
