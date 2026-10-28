import { describe, expect, it } from "vitest";

import {
  PAYMENT_STATUSES,
  aplusUrlPending,
  initialPaymentStatus,
  isLoanMethod,
  isManualPaymentMethod,
  paymentMethodLabel,
  paymentStatusLabel,
  paymentStatusOf,
  reviewStatusLabel,
} from "./payment-status";

/*
 * payment-status.ts のテスト。
 *
 * このファイルは2つに分かれている。
 *   ・前半 … 仕様として守りたい挙動。赤くなったら実装の後退を疑う。
 *   ・末尾「既知の欠陥」… 「現在こう動いてしまう」ことの記録。仕様ではない。
 *     実装を直したらブロックごと更新する。通っていることは正しさを意味しない。
 *
 * DB に入りうる値（supabase/migrations 由来）
 *   orders.payment_method    … 九州信販 / アプラス / ライフカード / Stripe / スクエア / 代引き / 振込 / null
 *                              （2026-08-19_agency_pay_unit.sql:47-51 の CHECK。これ以外は INSERT が落ちる）
 *   orders.payment_status    … CHECK は無い（2026-08-27_order_payment_status.sql:6-7）。
 *                              許す値はアプリ側（PAYMENT_STATUSES と order-actions.ts:643 の検証）が持つ
 *   customers.payment_status … 未決済 / 審査中 / 着金待ち / 決済完了 / 否決・キャンセル
 *                              （2026-08-27_order_payment_status.sql:15 の CHECK）
 *   orders.review_result     … 承認 / 否決 / 電話確認待ち / null
 *
 * 入力を選ぶときの前提（どの値が実際に届くか）
 *   受注の書き込みは webhook → registerOrder → intake.ts:1453 の
 *   normalizePaymentMethod を必ず通る。正規化表（intake.ts:1362-1373）は
 *   'stripe' も 'STRIPE' も 'Stripe' に、'銀行振込' は '振込' に直すため、
 *   orders.payment_method には表記ゆれは入らない。代わりに、表に無い言葉は
 *   すべて null になって届く（末尾の既知の欠陥を参照）。
 *   一方 customers.payment_method には CHECK が無い（supabase/part2.sql:21）ので、
 *   手作業や旧データで表記ゆれが入りうる。表示系の関数はそちらも受ける。
 */

/*
 * 実際に保存してよいお支払いの2値。
 * PAYMENT_STATUSES から取らずに手で書く。実装定数を期待値の出どころにすると、
 * 将来3つ目が足されたときにテストが黙って追随してしまい、
 * 「保存できる値が増えた」ことに気づけなくなる。
 * 出どころは 2026-08-27 の会議と 2026-08-27_order_payment_status.sql のコメント。
 */
const SAVABLE_PAYMENT_STATUSES = ["着金待ち", "決済完了"];

/*
 * この関数群に実際に届きうる決済方法を並べたもの。決済方法の定数リスト
 * （LOAN_METHODS / INSTANT_METHODS）に値が足された・混ざったときに、
 * どの関数が一緒に化けるかを一覧で押さえるために使う。
 *
 * 出どころは3つ。
 *   ・orders.payment_method の CHECK が許す7値
 *     （2026-08-19_agency_pay_unit.sql:47-51）
 *   ・intake.ts:1362-1373 の正規化表が受ける表記ゆれ（表に無い言葉は null になる）
 *   ・CHECK の無い customers.payment_method（supabase/part2.sql:21）に
 *     手作業・旧データで入りうる but 書き付きの値と大文字小文字の揺れ
 *
 * ここに無い値まで塞げるわけではないが、「実際に届く言葉のうち、どれが信販で
 * どれがその場決済か」は、リストに1つ足しただけで赤くなる状態にしておく。
 */
const METHOD_SAMPLES = [
  "アプラス",
  "九州信販",
  "ライフカード",
  "Stripe",
  "スクエア",
  "振込",
  "代引き",
  "銀行振込",
  "PayPay",
  "stripe",
  "STRIPE",
  "スクエアペイ",
  "Stripe決済",
  "Stripe（手数料込）",
  "振込手数料お客様負担",
  "銀行振込（手数料お客様負担）",
  "アプラス（ローン）",
  "アプラスローン",
  "ローン",
  "お振込み",
  "ゆうちょ振込",
];

/** 上の一覧のうち、信販として扱ってよい3つ。並び順は METHOD_SAMPLES に合わせる。 */
const LOAN_SAMPLES = ["アプラス", "九州信販", "ライフカード"];
/** 上の一覧のうち、その場で決済が終わる2つ。並び順は METHOD_SAMPLES に合わせる。 */
const INSTANT_SAMPLES = ["Stripe", "スクエア"];

describe("PAYMENT_STATUSES（保存してよいお支払いの値）", () => {
  it("保存値は 着金待ち と 決済完了 の2つだけ", () => {
    expect(PAYMENT_STATUSES).toEqual(["着金待ち", "決済完了"]);
  });

  it("画面用の言い換え語（着金完了・決済中）は保存値に含めない", () => {
    /*
     * order-actions.ts:643 は PAYMENT_STATUSES で入力を検証する。
     * paymentStatusLabel の戻り値をそのまま保存に回すと弾かれる、
     * という境界をここで固定しておく（label と value の取り違えよけ）。
     */
    expect(paymentStatusLabel("振込", "決済完了")).toBe("着金完了");
    expect(paymentStatusLabel("アプラス", "着金待ち")).toBe("決済中");
    expect(PAYMENT_STATUSES as readonly string[]).not.toContain("着金完了");
    expect(PAYMENT_STATUSES as readonly string[]).not.toContain("決済中");
  });
});

describe("isLoanMethod（審査がある信販かどうか）", () => {
  it("アプラス・九州信販・ライフカードは信販として true", () => {
    expect(isLoanMethod("アプラス")).toBe(true);
    expect(isLoanMethod("九州信販")).toBe(true);
    expect(isLoanMethod("ライフカード")).toBe(true);
  });

  it("クレジットカード・振込・代引きは信販ではない", () => {
    expect(isLoanMethod("Stripe")).toBe(false);
    expect(isLoanMethod("スクエア")).toBe(false);
    expect(isLoanMethod("振込")).toBe(false);
    expect(isLoanMethod("代引き")).toBe(false);
  });

  it("未記録（null / undefined / 空 / 空白だけ）は false", () => {
    expect(isLoanMethod(null)).toBe(false);
    expect(isLoanMethod(undefined)).toBe(false);
    expect(isLoanMethod("")).toBe(false);
    expect(isLoanMethod("   ")).toBe(false);
  });

  it("前後の空白は落として判定する（全角空白を含む）", () => {
    expect(isLoanMethod("  アプラス  ")).toBe(true);
    expect(isLoanMethod("\tライフカード\n")).toBe(true);
    // 日本語入力では全角空白が紛れ込みやすい。String#trim は U+3000 も落とす。
    expect(isLoanMethod("　九州信販　")).toBe(true);
  });

  it("完全一致でしか当たらない（表記ゆれは信販として扱われない）", () => {
    expect(isLoanMethod("アプラス（ローン）")).toBe(false);
    expect(isLoanMethod("アプラスローン")).toBe(false);
    expect(isLoanMethod("ローン")).toBe(false);
    // 部分一致にすると「アプラス以外」まで信販に化けるので、前方一致でも当たらないこと
    expect(isLoanMethod("アプ")).toBe(false);
  });

  it("信販3社の一覧に無い決済方法は false（未知の決済手段・表示名の別名）", () => {
    /*
     * 新しい信販会社を LOAN_METHODS に足すのは今後ふつうに起きる変更で、
     * そのとき信販でない値を巻き込むと reviewStatusLabel と aplusUrlPending が
     * 一緒に化ける（下の2つの describe に対になるアサートを置いてある）。
     */
    expect(isLoanMethod("PayPay")).toBe(false);
    expect(isLoanMethod("銀行振込")).toBe(false);
  });

  it("実際に届きうる決済方法を並べても、信販になるのはこの3つだけ", () => {
    /*
     * 上の it は PayPay と銀行振込を名指しで塞いでいるが、名指しは足された値が
     * それだったときにしか効かない。LOAN_METHODS に「stripe」や
     * 「振込手数料お客様負担」のような別の値が混ざる変更は素通りしてしまう。
     * ここでは一覧全体を通し、true になる顔ぶれそのものを固定する。
     * 1つ足しただけで、足した値が余分に並ぶので赤くなる。
     */
    expect(METHOD_SAMPLES.filter((m) => isLoanMethod(m))).toEqual(LOAN_SAMPLES);
  });
});

describe("paymentMethodLabel（画面に出す決済方法の呼び名）", () => {
  it("決済サービス名はクレジットカードにまとめる", () => {
    expect(paymentMethodLabel("Stripe")).toBe("クレジットカード");
    expect(paymentMethodLabel("スクエア")).toBe("クレジットカード");
  });

  it("振込は銀行振込と表示する", () => {
    expect(paymentMethodLabel("振込")).toBe("銀行振込");
  });

  it("それ以外は保存値をそのまま出す", () => {
    expect(paymentMethodLabel("アプラス")).toBe("アプラス");
    expect(paymentMethodLabel("九州信販")).toBe("九州信販");
    expect(paymentMethodLabel("ライフカード")).toBe("ライフカード");
    expect(paymentMethodLabel("代引き")).toBe("代引き");
  });

  it("表示名をもう一度通しても変わらない（二重変換されない）", () => {
    /*
     * 画面から受け取った表示名がそのまま戻ってくる経路があるため、
     * 何度通しても同じ語に落ち着くこと（冪等）を保証する。
     * 「銀行振込」がそのまま通るだけでなく、「クレジットカード」も
     * 別の語に化けないことまで見る。
     */
    expect(paymentMethodLabel(paymentMethodLabel("振込"))).toBe("銀行振込");
    expect(paymentMethodLabel(paymentMethodLabel("Stripe"))).toBe("クレジットカード");
    expect(paymentMethodLabel(paymentMethodLabel("アプラス"))).toBe("アプラス");
  });

  it("未記録は空文字を返す（呼び出し側が「—」などに置き換える前提）", () => {
    // 表示は StatusBadge 経由で、ui.tsx:151 が空文字を「—」に置き換える。
    expect(paymentMethodLabel(null)).toBe("");
    expect(paymentMethodLabel(undefined)).toBe("");
    expect(paymentMethodLabel("")).toBe("");
    expect(paymentMethodLabel("   ")).toBe("");
  });

  it("言い換えるのは Stripe・スクエア・振込の完全一致だけ（前方一致では当たらない）", () => {
    /*
     * customers.payment_method には CHECK が無く（supabase/part2.sql:21）、
     * 「振込手数料お客様負担」のような but 書き付きの値が手作業で入りうる。
     * 判定を前方一致に緩めると、これらが別の決済方法の名前で表示される。
     */
    expect(paymentMethodLabel("Stripe決済")).toBe("Stripe決済");
    expect(paymentMethodLabel("スクエアペイ")).toBe("スクエアペイ");
    expect(paymentMethodLabel("振込手数料お客様負担")).toBe("振込手数料お客様負担");
    expect(paymentMethodLabel("アプラス（ローン）")).toBe("アプラス（ローン）");
  });

  it("前後の空白は落としてから判定・表示する", () => {
    expect(paymentMethodLabel("  Stripe ")).toBe("クレジットカード");
    expect(paymentMethodLabel(" 振込 ")).toBe("銀行振込");
    expect(paymentMethodLabel("　振込　")).toBe("銀行振込");
    expect(paymentMethodLabel("  代引き  ")).toBe("代引き");
  });
});

describe("paymentStatusLabel（決済方法ごとの言い換え）", () => {
  describe("銀行振込", () => {
    it("決済完了なら「着金完了」と言い換える", () => {
      expect(paymentStatusLabel("振込", "決済完了")).toBe("着金完了");
    });

    it("表示名の「銀行振込」も振込の別名として受ける", () => {
      /*
       * 通常の保存経路では intake.ts:1368 が「銀行振込」を「振込」に直すため
       * この別名は届かない。届くのは CHECK の無い customers.payment_method に
       * 手で入った場合か、呼び出し側が表示名を渡した場合。
       * 別名の吸収を正規化1か所に寄せるまでは、ここが受け皿になっている。
       */
      expect(paymentStatusLabel("銀行振込", "決済完了")).toBe("着金完了");
      expect(paymentStatusLabel("銀行振込", "着金待ち")).toBe("着金待ち");
    });

    it("着金待ちはそのまま「着金待ち」", () => {
      expect(paymentStatusLabel("振込", "着金待ち")).toBe("着金待ち");
    });

    it("状態が未記録でも「着金待ち」を出す（空文字にはならない）", () => {
      expect(paymentStatusLabel("振込", null)).toBe("着金待ち");
      expect(paymentStatusLabel("振込", undefined)).toBe("着金待ち");
      expect(paymentStatusLabel("振込", "")).toBe("着金待ち");
      expect(paymentStatusLabel("振込", "   ")).toBe("着金待ち");
    });

    it("決済方法・状態とも前後の空白を落としてから判定する", () => {
      expect(paymentStatusLabel(" 振込 ", " 決済完了 ")).toBe("着金完了");
    });

    it("振込として扱うのは「振込」「銀行振込」の完全一致だけ", () => {
      /*
       * 判定を前方一致に緩めると、but 書き付きの値まで振込の言い換え
       * （着金完了／着金待ち）に丸められ、保存値が読めなくなる。
       * これらは素通し（言い換えない）が正しい。
       */
      expect(paymentStatusLabel("振込手数料お客様負担", "決済完了")).toBe("決済完了");
      expect(paymentStatusLabel("銀行振込（手数料お客様負担）", "未決済")).toBe("未決済");
    });

    it("着金完了にするのは保存値「決済完了」の完全一致だけ（未着金を着金済みに見せない）", () => {
      /*
       * ここが本文で一番危ないところ。判定を部分一致（includes）や
       * 前方一致（startsWith("決済")）に緩めると、まだ入金されていない受注が
       * 「着金完了」と表示され、本部の着金確認が空振りする。
       * 丸めた先の語そのもの（着金待ちに化ける件）は末尾の既知の欠陥を参照。
       */
      expect(paymentStatusLabel("振込", "決済完了取消")).not.toBe("着金完了");
      expect(paymentStatusLabel("振込", "決済中")).not.toBe("着金完了");
      expect(paymentStatusLabel("振込", "未決済")).not.toBe("着金完了");
    });
  });

  describe("信販（アプラスなど）", () => {
    it("決済完了はそのまま「決済完了」", () => {
      expect(paymentStatusLabel("アプラス", "決済完了")).toBe("決済完了");
      expect(paymentStatusLabel("九州信販", "決済完了")).toBe("決済完了");
      expect(paymentStatusLabel("ライフカード", "決済完了")).toBe("決済完了");
    });

    it("着金待ちは「決済中」と言い換える", () => {
      expect(paymentStatusLabel("アプラス", "着金待ち")).toBe("決済中");
      expect(paymentStatusLabel("ライフカード", "着金待ち")).toBe("決済中");
    });

    it("状態が未記録でも「決済中」を出す", () => {
      expect(paymentStatusLabel("アプラス", null)).toBe("決済中");
      expect(paymentStatusLabel("九州信販", "")).toBe("決済中");
    });

    it("決済完了と出すのは保存値「決済完了」の完全一致だけ", () => {
      // 振込側（上）と同じ理由。部分一致に緩めると取消済みが完了に化ける。
      expect(paymentStatusLabel("アプラス", "決済完了（取消）")).not.toBe("決済完了");
      expect(paymentStatusLabel("九州信販", "未決済完了")).not.toBe("決済完了");
    });
  });

  describe("クレジットカード・代引き・未記録", () => {
    it("言い換えず保存値をそのまま返す", () => {
      expect(paymentStatusLabel("Stripe", "決済完了")).toBe("決済完了");
      expect(paymentStatusLabel("Stripe", "着金待ち")).toBe("着金待ち");
      expect(paymentStatusLabel("スクエア", "決済完了")).toBe("決済完了");
      expect(paymentStatusLabel("代引き", "着金待ち")).toBe("着金待ち");
      expect(paymentStatusLabel(null, "決済完了")).toBe("決済完了");
    });

    it("見覚えのない決済方法も、保存値をそのまま返す", () => {
      // LOAN_METHODS に未知の値が混ざると、ここが「決済中」に化ける。
      expect(paymentStatusLabel("PayPay", "着金待ち")).toBe("着金待ち");
      expect(paymentStatusLabel("PayPay", "決済完了")).toBe("決済完了");
    });

    it("見覚えのない保存値も加工せず素通しする", () => {
      // 振込・信販だけが丸めてしまう（末尾の既知の欠陥）のと対になる挙動。
      expect(paymentStatusLabel("Stripe", "未決済")).toBe("未決済");
      expect(paymentStatusLabel("代引き", "否決・キャンセル")).toBe("否決・キャンセル");
      expect(paymentStatusLabel("代引き", "審査中")).toBe("審査中");
    });

    it("保存値の前後の空白は落として返す", () => {
      expect(paymentStatusLabel("Stripe", "  決済完了  ")).toBe("決済完了");
    });
  });
});

describe("initialPaymentStatus（受注が入った時点の初期値）", () => {
  it("クレジットカードは決済が済んでから通知が来るので決済完了", () => {
    expect(initialPaymentStatus("Stripe")).toBe("決済完了");
    expect(initialPaymentStatus("スクエア")).toBe("決済完了");
    expect(initialPaymentStatus("  Stripe  ")).toBe("決済完了");
  });

  it("振込・信販・代引きはお金が動いていないので着金待ち", () => {
    expect(initialPaymentStatus("振込")).toBe("着金待ち");
    expect(initialPaymentStatus("アプラス")).toBe("着金待ち");
    expect(initialPaymentStatus("九州信販")).toBe("着金待ち");
    expect(initialPaymentStatus("ライフカード")).toBe("着金待ち");
    expect(initialPaymentStatus("代引き")).toBe("着金待ち");
  });

  it("知らない決済方法は着金待ち（勝手に決済済みにはしない）", () => {
    expect(initialPaymentStatus("PayPay")).toBe("着金待ち");
    expect(initialPaymentStatus("銀行振込")).toBe("着金待ち");
  });

  it("その場決済として扱うのは Stripe・スクエアの完全一致だけ", () => {
    /*
     * 判定を前方一致に緩めると「Stripe決済」のような値が決済完了で登録され、
     * 入金前の受注が支払い済みとして一覧から消える。
     * ここは金額の回収に直結するので、完全一致であることを固定しておく。
     */
    expect(initialPaymentStatus("Stripe決済")).toBe("着金待ち");
    expect(initialPaymentStatus("スクエアペイ")).toBe("着金待ち");
    expect(initialPaymentStatus("Stripe（手数料込）")).toBe("着金待ち");
  });

  it("実際に届きうる決済方法を並べても、初期値が決済完了になるのはこの2つだけ", () => {
    /*
     * INSTANT_METHODS に値が1つ足されると、その決済方法の受注が入金前から
     * 「決済完了」で登録され、未回収のまま着金待ちの一覧から消える。
     * 名指しではなく顔ぶれごと固定して、足した瞬間に赤くする。
     * （決済方法が未記録のときも決済完了になるが、それは末尾の既知の欠陥。
     *   一覧には空文字を入れていないので、ここには出てこない）
     */
    expect(
      METHOD_SAMPLES.filter((m) => initialPaymentStatus(m) === "決済完了"),
    ).toEqual(INSTANT_SAMPLES);
    // 残りはすべて着金待ち。第3の値が出ないこともまとめて押さえる。
    expect([...new Set(METHOD_SAMPLES.map((m) => initialPaymentStatus(m)))].sort()).toEqual(
      [...SAVABLE_PAYMENT_STATUSES].sort(),
    );
  });

  it("戻り値は必ず DB に保存してよい2値のどちらか", () => {
    /*
     * 期待値は実装定数ではなく、上で手書きした SAVABLE_PAYMENT_STATUSES と照合する。
     * PAYMENT_STATUSES と突き合わせると、実装が3つ目を返すようになっても通ってしまう。
     */
    for (const m of ["Stripe", "スクエア", "振込", "アプラス", "九州信販", "ライフカード", "代引き", "PayPay"]) {
      expect(SAVABLE_PAYMENT_STATUSES).toContain(initialPaymentStatus(m));
    }
  });
});

describe("paymentStatusOf（保存値が無ければ初期値で埋める）", () => {
  it("保存値があればそれを使う。決済方法から見た初期値では上書きしない", () => {
    expect(paymentStatusOf("Stripe", "着金待ち")).toBe("着金待ち");
    expect(paymentStatusOf("振込", "決済完了")).toBe("決済完了");
    expect(paymentStatusOf("アプラス", "決済完了")).toBe("決済完了");
  });

  it("保存値が無ければ決済方法から初期値を作る", () => {
    expect(paymentStatusOf("振込", null)).toBe("着金待ち");
    expect(paymentStatusOf("アプラス", "")).toBe("着金待ち");
    expect(paymentStatusOf("アプラス", "   ")).toBe("着金待ち");
    expect(paymentStatusOf("代引き", null)).toBe("着金待ち");
    expect(paymentStatusOf("PayPay", null)).toBe("着金待ち");
    expect(paymentStatusOf("Stripe", null)).toBe("決済完了");
    expect(paymentStatusOf("スクエア", undefined)).toBe("決済完了");
  });

  it("決済方法の前後の空白も落としてから初期値を決める", () => {
    expect(paymentStatusOf("  Stripe  ", null)).toBe("決済完了");
    expect(paymentStatusOf(" アプラス ", null)).toBe("着金待ち");
  });

  it("保存値の前後の空白は落とす", () => {
    expect(paymentStatusOf("振込", "  決済完了  ")).toBe("決済完了");
  });

  it("保存値が2値の外（旧ステータス）でもそのまま返す", () => {
    // 顧客台帳側は CHECK が 5 値を許すため、旧値が保存値として流れてくる。
    expect(paymentStatusOf("代引き", "未決済")).toBe("未決済");
    expect(paymentStatusOf("振込", "否決・キャンセル")).toBe("否決・キャンセル");
    expect(paymentStatusOf("アプラス", "審査中")).toBe("審査中");
  });
});

describe("reviewStatusLabel（画面に出す審査ステータス）", () => {
  it("否決はどの決済方法でもそのまま否決", () => {
    expect(reviewStatusLabel("アプラス", "否決")).toBe("否決");
    expect(reviewStatusLabel("Stripe", "否決")).toBe("否決");
    expect(reviewStatusLabel(null, "否決")).toBe("否決");
  });

  it("承認は審査完了と言い換える", () => {
    expect(reviewStatusLabel("アプラス", "承認")).toBe("審査完了");
    expect(reviewStatusLabel("Stripe", "承認")).toBe("審査完了");
  });

  it("電話確認待ちは審査の途中なので審査中", () => {
    expect(reviewStatusLabel("アプラス", "電話確認待ち")).toBe("審査中");
    // 信販以外に結果が入っていても、結果のほうが優先される。
    expect(reviewStatusLabel("Stripe", "電話確認待ち")).toBe("審査中");
  });

  it("信販で結果がまだ無ければ審査中", () => {
    expect(reviewStatusLabel("アプラス", null)).toBe("審査中");
    expect(reviewStatusLabel("九州信販", "")).toBe("審査中");
    expect(reviewStatusLabel("ライフカード", "   ")).toBe("審査中");
  });

  it("信販以外で結果が無ければ、審査そのものが無いので審査完了", () => {
    expect(reviewStatusLabel("Stripe", null)).toBe("審査完了");
    expect(reviewStatusLabel("スクエア", "")).toBe("審査完了");
    expect(reviewStatusLabel("振込", null)).toBe("審査完了");
    expect(reviewStatusLabel("代引き", undefined)).toBe("審査完了");
  });

  it("決済方法・結果とも前後の空白を落としてから判定する", () => {
    expect(reviewStatusLabel("アプラス", " 承認 ")).toBe("審査完了");
    expect(reviewStatusLabel("アプラス", " 否決 ")).toBe("否決");
    expect(reviewStatusLabel("アプラス", " 電話確認待ち ")).toBe("審査中");
    // 決済方法側の空白は isLoanMethod が落とす（信販判定が空白で崩れない）。
    expect(reviewStatusLabel("  アプラス  ", null)).toBe("審査中");
  });

  it("見覚えのない結果は「結果が無い」のと同じ扱いになり、決済方法だけで決まる", () => {
    expect(reviewStatusLabel("アプラス", "保留")).toBe("審査中");
    expect(reviewStatusLabel("Stripe", "保留")).toBe("審査完了");
  });

  it("否決・承認・電話確認待ちは完全一致でだけ拾う（前方一致では当たらない）", () => {
    /*
     * 判定を前方一致に緩めると「否決（再申込可）」が確定した否決として出て、
     * 行がキャンセル扱いで赤くなる。「承認待ち」も審査完了に化ける。
     * どちらも見覚えのない結果なので、決済方法だけで決まるのが正しい。
     */
    expect(reviewStatusLabel("アプラス", "否決（再申込可）")).toBe("審査中");
    expect(reviewStatusLabel("アプラス", "承認待ち")).toBe("審査中");
    expect(reviewStatusLabel("Stripe", "電話確認待ちのため保留")).toBe("審査完了");
  });

  it("信販3社の一覧に無い決済方法は、結果が無ければ審査完了", () => {
    // LOAN_METHODS に未知値や別名を足すと、この2つが「審査中」に変わる。
    expect(reviewStatusLabel("PayPay", null)).toBe("審査完了");
    expect(reviewStatusLabel("銀行振込", null)).toBe("審査完了");
    expect(reviewStatusLabel("PayPay", "")).toBe("審査完了");
  });

  it("結果が無いときに審査中になるのは、実際に届きうる決済方法のうち信販3社だけ", () => {
    /*
     * isLoanMethod の顔ぶれがそのままここに出る（payment-status.ts:110）。
     * LOAN_METHODS に信販でない値が混ざると、審査そのものが無い受注が
     * 「審査中」で止まって見え、本部が終わらない審査を待つことになる。
     */
    expect(METHOD_SAMPLES.filter((m) => reviewStatusLabel(m, null) === "審査中")).toEqual(
      LOAN_SAMPLES,
    );
    // 残りはすべて審査完了。「審査中でないもの＝審査完了」まで見て、第3の語が出ないことも押さえる。
    expect([...new Set(METHOD_SAMPLES.map((m) => reviewStatusLabel(m, null)))].sort()).toEqual(
      ["審査中", "審査完了"].sort(),
    );
  });
});

describe("aplusUrlPending（申込URLが未送付か）", () => {
  it("信販で送付日時が無ければ未送付として true", () => {
    expect(aplusUrlPending("アプラス", null)).toBe(true);
    expect(aplusUrlPending("アプラス", undefined)).toBe(true);
    expect(aplusUrlPending("アプラス", "")).toBe(true);
    expect(aplusUrlPending("アプラス", "   ")).toBe(true);
  });

  it("送付日時が入っていれば false", () => {
    expect(aplusUrlPending("アプラス", "2026-08-28T09:00:00+09:00")).toBe(false);
    expect(aplusUrlPending("アプラス", "2026-08-28")).toBe(false);
  });

  it("信販3社すべてで目印が立つ（アプラス専用ではない）", () => {
    /*
     * 実装のコメント（payment-status.ts:119）と ShipForm.tsx:404 付近のコメントは
     * 「アプラス以外では出さない」と書いているが、判定は isLoanMethod なので
     * 九州信販・ライフカードでも立つ。欄の出し分け（ShipForm.tsx:407）も
     * 同じ isLoanMethod なので、動きとしてはこちらが正。直すならコメント2か所。
     */
    expect(aplusUrlPending("九州信販", null)).toBe(true);
    expect(aplusUrlPending("ライフカード", null)).toBe(true);
  });

  it("信販以外は、そもそも送るものが無いので常に false", () => {
    expect(aplusUrlPending("振込", null)).toBe(false);
    expect(aplusUrlPending("Stripe", null)).toBe(false);
    expect(aplusUrlPending("代引き", "")).toBe(false);
  });

  it("信販3社の一覧に無い決済方法では目印は立たない（未知値・別名を含む）", () => {
    /*
     * reviewStatusLabel と同じく isLoanMethod ひとつで決まるので、
     * LOAN_METHODS に信販でない値が混ざると、送るものが無い受注にまで
     * 「URL未送付」の目印が立って一覧が汚れる。
     */
    expect(aplusUrlPending("PayPay", null)).toBe(false);
    expect(aplusUrlPending("銀行振込", null)).toBe(false);
  });

  it("実際に届きうる決済方法を並べても、目印が立つのは信販3社だけ", () => {
    /*
     * reviewStatusLabel と同じ isLoanMethod ひとつで決まる（payment-status.ts:125）。
     * LOAN_METHODS に値が混ざると、送る申込URLが存在しない受注にまで
     * 「URL未送付」の目印が立ち、一覧の目印が信用できなくなる。
     */
    expect(METHOD_SAMPLES.filter((m) => aplusUrlPending(m, null))).toEqual(LOAN_SAMPLES);
  });

  it("決済方法の前後の空白は落として判定する", () => {
    expect(aplusUrlPending(" アプラス ", null)).toBe(true);
  });
});

describe("isManualPaymentMethod（お支払いを手で変えてよいか）", () => {
  it("クレジットカードは自動で決済完了になるので手では変えさせない", () => {
    expect(isManualPaymentMethod("Stripe")).toBe(false);
    expect(isManualPaymentMethod("スクエア")).toBe(false);
    expect(isManualPaymentMethod("  Stripe  ")).toBe(false);
  });

  it("振込・信販・代引きは本部が着金を確認して変えるので true", () => {
    expect(isManualPaymentMethod("振込")).toBe(true);
    expect(isManualPaymentMethod("アプラス")).toBe(true);
    expect(isManualPaymentMethod("九州信販")).toBe(true);
    expect(isManualPaymentMethod("ライフカード")).toBe(true);
    expect(isManualPaymentMethod("代引き")).toBe(true);
  });

  it("知らない決済方法も手で変えられる側に入る", () => {
    /*
     * Stripe・スクエア以外はすべて true になる作り。
     * 読み取れなかった受注（payment_method=null）が本部の手で決済完了にできる、
     * という経路とセットで効いてくるので、明示しておく。
     */
    expect(isManualPaymentMethod("PayPay")).toBe(true);
    expect(isManualPaymentMethod("銀行振込")).toBe(true);
  });

  it("手で変えさせないのは Stripe・スクエアの完全一致だけ", () => {
    /*
     * 判定を前方一致に緩めると「Stripe（手数料込）」のような値が
     * 変えられない側に落ち、本部がその受注のお支払いを直せなくなる。
     * それはこの関数の存在理由（記録が無い・読めない受注ほど手で直せるべき）と逆。
     */
    expect(isManualPaymentMethod("Stripe（手数料込）")).toBe(true);
    expect(isManualPaymentMethod("スクエアペイ")).toBe(true);
    expect(isManualPaymentMethod("Stripe決済")).toBe(true);
  });

  it("実際に届きうる決済方法を並べても、手で変えさせないのはこの2つだけ", () => {
    /*
     * initialPaymentStatus と同じ INSTANT_METHODS を見ている（payment-status.ts:143）。
     * ここに値が混ざると、本部がその決済方法の受注のお支払いを直せなくなる。
     * 変えられない側の顔ぶれを固定し、増えた瞬間に赤くする。
     */
    expect(METHOD_SAMPLES.filter((m) => !isManualPaymentMethod(m))).toEqual(INSTANT_SAMPLES);
  });

  it("決済方法が未記録でも変えられる側に入れる（古いお客様を本部が直せるように）", () => {
    expect(isManualPaymentMethod(null)).toBe(true);
    expect(isManualPaymentMethod(undefined)).toBe(true);
    expect(isManualPaymentMethod("")).toBe(true);
    expect(isManualPaymentMethod("   ")).toBe(true);
  });
});

describe("決済方法ごとの通し（このモジュール内の合成。他モジュールとの結合ではない）", () => {
  it("銀行振込: 着金待ちから始まり、本部が決済完了にすると画面は着金完了になる", () => {
    const before = paymentStatusOf("振込", null);
    expect(before).toBe("着金待ち");
    expect(paymentStatusLabel("振込", before)).toBe("着金待ち");

    const after = paymentStatusOf("振込", "決済完了");
    expect(after).toBe("決済完了");
    expect(paymentStatusLabel("振込", after)).toBe("着金完了");
  });

  it("アプラス: 着金待ちだが画面は決済中、審査中、URL未送付の目印が立つ", () => {
    const stored = paymentStatusOf("アプラス", null);
    expect(stored).toBe("着金待ち");
    expect(paymentStatusLabel("アプラス", stored)).toBe("決済中");
    expect(reviewStatusLabel("アプラス", null)).toBe("審査中");
    expect(aplusUrlPending("アプラス", null)).toBe(true);

    const done = paymentStatusOf("アプラス", "決済完了");
    expect(paymentStatusLabel("アプラス", done)).toBe("決済完了");
  });
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】振込では「否決・キャンセル」が「着金待ち」に化ける", () => {
    /*
     * 本来: 否決・キャンセルは、中止された受注として画面にもそのまま出すべき。
     *       少なくとも「まだ入金を待っている」ように見せてはいけない。
     * 現状: 決済完了「以外」をすべて着金待ちに丸めている（payment-status.ts:61-63）。
     * 到達経路: order-actions.ts:540（出荷キャンセル時）と :902（審査否決時）が
     *           customers.payment_status に「否決・キャンセル」を書く。
     *           CHECK（2026-08-27_order_payment_status.sql:15）も許している。
     *           出る場所は admin/customers/[id]/page.tsx:228 の「お支払い」タイルなど。
     */
    expect(paymentStatusLabel("振込", "否決・キャンセル")).toBe("着金待ち");
    expect(paymentStatusLabel("振込", "未決済")).toBe("着金待ち");
    expect(paymentStatusLabel("振込", "審査中")).toBe("着金待ち");
    // 言い換え後の語や but 書き付きの値も、同じ丸めで着金待ちになる。
    expect(paymentStatusLabel("振込", "決済中")).toBe("着金待ち");
    expect(paymentStatusLabel("振込", "決済完了取消")).toBe("着金待ち");
  });

  it("【欠陥】信販では「否決・キャンセル」が「決済中」に化ける", () => {
    /*
     * 本来: 同上。否決された受注が「決済中」＝手続きが進行中に見えるのは逆。
     * 現状: 決済完了「以外」をすべて決済中に丸めている（payment-status.ts:64-66）。
     */
    expect(paymentStatusLabel("アプラス", "否決・キャンセル")).toBe("決済中");
    expect(paymentStatusLabel("アプラス", "未決済")).toBe("決済中");
    expect(paymentStatusLabel("アプラス", "審査中")).toBe("決済中");
    expect(paymentStatusLabel("アプラス", "決済完了（取消）")).toBe("決済中");
  });

  it("【欠陥】カード・代引き・未記録だけ、状態が空のときに既定値で埋めない", () => {
    /*
     * 本来: paymentStatusLabel も内部で paymentStatusOf を通し、
     *       どの決済方法でも空文字を返さないようにすべき。
     * 現状: 振込・信販だけ既定値で埋め、それ以外は空文字（payment-status.ts:67）。
     * 実害: 表示自体は ui.tsx:151 が空文字を「—」にするので空白にはならないが、
     *       画面間でずれる。admin/customers/[id]/page.tsx:372 は paymentStatusOf を
     *       通していないため未設定のカード受注が「—」、
     *       admin/orders/page.tsx:1012 では「決済完了」と出る。
     */
    expect(paymentStatusLabel("Stripe", null)).toBe("");
    expect(paymentStatusLabel("代引き", "")).toBe("");
    expect(paymentStatusLabel(null, null)).toBe("");
    expect(paymentStatusLabel(undefined, undefined)).toBe("");
    // paymentStatusOf を挟めば埋まる、という差がそのまま画面間のずれになる。
    expect(paymentStatusLabel("Stripe", paymentStatusOf("Stripe", null))).toBe("決済完了");
  });

  it("【欠陥】読み取れなかった決済方法（null）の受注が、入金前でも決済完了・審査完了で登録される", () => {
    /*
     * 本来: 決済方法を読み取れなかった受注は着金待ちにして、本部が確認するまで
     *       「支払い済み」に見せてはいけない。備考に理由を残すだけでは足りない。
     * 現状: 空・null は決済完了（payment-status.ts:78 の `!m` 分岐）。
     * 到達経路: intake.ts:1453 は normalizePaymentMethod(...).value を保存し、
     *           正規化表（intake.ts:1362-1373）に無い言葉
     *           （「お振込み」「ゆうちょ振込」「銀行振込（手数料お客様負担）」
     *           「アプラス（ローン）」など）はすべて null になる。
     *           その null が intake.ts:1474 で initialPaymentStatus に渡るため、
     *           入金前の受注が決済完了で入る。審査完了にもなり、URL未送付の
     *           目印も立たないので、どの一覧にも引っかからない。
     *           webhook/route.ts:230-240 のコメントが防ごうとしていた事故が、
     *           正規化を挟んだことで裏口から復活している。
     */
    expect(initialPaymentStatus(null)).toBe("決済完了");
    expect(initialPaymentStatus(undefined)).toBe("決済完了");
    expect(initialPaymentStatus("")).toBe("決済完了");
    expect(initialPaymentStatus("   ")).toBe("決済完了");
    // 同じ受注を他の関数で見ても、止める材料が何も出ない。
    expect(paymentStatusOf(null, null)).toBe("決済完了");
    expect(reviewStatusLabel(null, null)).toBe("審査完了");
    expect(aplusUrlPending(null, null)).toBe(false);
  });

  it("【欠陥】決済サービス名の大文字小文字を区別するため、表記ゆれで扱いが逆になる", () => {
    /*
     * 本来: 決済サービス名は大文字小文字を無視して判定すべき
     *       （intake.ts:1372 の正規化表は toLowerCase して吸収している）。
     * 現状: 完全一致のため 'stripe' はカードとして扱われない。
     * 到達経路: orders.payment_method は正規化を通るので入らないが、
     *           CHECK の無い customers.payment_method（supabase/part2.sql:21）には
     *           手作業・旧データで入りうる。そのとき初期値が着金待ちになり、
     *           本部が手で決済完了に変えられる側にも入る。
     */
    expect(paymentMethodLabel("stripe")).toBe("stripe");
    expect(paymentMethodLabel("STRIPE")).toBe("STRIPE");
    expect(initialPaymentStatus("stripe")).toBe("着金待ち");
    expect(isManualPaymentMethod("stripe")).toBe(true);
  });

  it("【欠陥】言い換え後の語を渡し直すと、完了が待ちに戻る", () => {
    /*
     * 本来: 「着金完了」を渡されたら素通しするか、そもそも受け付けないべき。
     * 現状: 決済完了「以外」を丸める作りなので、完了が待ちに戻る。
     * 到達経路: CustomerForm.tsx:328-329 は option の label（paymentStatusLabel の
     *           戻り値）と value（保存値）を隣り合わせで扱っている。取り違えると起きる。
     */
    expect(paymentStatusLabel("振込", "着金完了")).toBe("着金待ち");
    // 信販側はたまたま同じ語に落ちるので、この事故が振込でだけ表に出る。
    expect(paymentStatusLabel("アプラス", "決済中")).toBe("決済中");
  });

  it("【欠陥】同じ振込の受注が、編集画面では「決済完了」、一覧では「着金完了」と表示される", () => {
    /*
     * 本来: 画面に出す語は必ず paymentStatusLabel を通し、どの画面でも同じにすべき。
     *       モジュール冒頭が掲げている存在意義そのもの（画面ごとに判定がずれない）。
     * 現状: ShipForm.tsx:383-390 は PAYMENT_STATUSES を生のまま <option> に出すため、
     *       振込の受注でも編集画面は「決済完了」と表示する。一方
     *       admin/orders/page.tsx:1010 と CustomerForm.tsx:328 は
     *       paymentStatusLabel を通すので「着金完了」と表示する。
     */
    const stored = "決済完了";
    expect(PAYMENT_STATUSES as readonly string[]).toContain(stored); // 編集画面が出す語
    expect(paymentStatusLabel("振込", stored)).toBe("着金完了"); // 一覧が出す語
    expect(paymentStatusLabel("振込", stored)).not.toBe(stored); // 同じ受注で語が割れる
  });
});
