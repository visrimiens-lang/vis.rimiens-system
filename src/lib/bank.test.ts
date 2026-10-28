import { describe, it, expect } from "vitest";
import {
  accountNoProblem,
  accountNoLooksReal,
  bankReady,
  missingBankFields,
  type BankFields,
} from "./bank";

/**
 * 期待値のメッセージは実装から import せず、文言そのものをここに書く。
 * 文言が黙って変わったらテストが落ちるようにするため。
 * （裏を返すと、実装側の文言そのものの誤り（全角括弧の混在など）は
 *   このテストでは検出できない。文言の正しさは目視でしか担保していない。）
 *
 * ファイル末尾に「既知の欠陥」ブロックがある。
 * そこは仕様ではなく現状の記録なので、通っていることは正しさを意味しない。
 */
const 桁数エラー = "口座番号（半角の数字4〜7桁で入力してください）";
const 同一数字エラー =
  "口座番号（0000000 のように同じ数字だけの番号は、実在しない口座とみなして登録できません）";

/** 4項目そろった正常な振込先。個々のテストで一部だけ上書きして使う。 */
function 振込先(over: Partial<BankFields> = {}): BankFields {
  return {
    bankName: "みずほ銀行",
    bankBranch: "渋谷支店",
    accountNo: "1234567",
    accountHolder: "ヤマダ タロウ",
    ...over,
  };
}

describe("accountNoProblem", () => {
  describe("桁数の判定（数字だけを数えて4〜7桁）", () => {
    it("7桁の数字は通る（空文字を返す）", () => {
      expect(accountNoProblem("1234567")).toBe("");
    });

    it("4桁の数字は通る（下限ちょうど）", () => {
      expect(accountNoProblem("1234")).toBe("");
    });

    it("6桁の数字も通る（下限と上限の間）", () => {
      expect(accountNoProblem("123456")).toBe("");
    });

    it("5桁の数字も通る（4〜7の内側をすべて埋める）", () => {
      expect(accountNoProblem("12345")).toBe("");
    });

    it("先頭0詰めの7桁（0012345）は通る", () => {
      expect(accountNoProblem("0012345")).toBe("");
    });

    it("3桁は短すぎるので桁数エラー", () => {
      expect(accountNoProblem("123")).toBe(桁数エラー);
    });

    it("8桁は長すぎるので桁数エラー", () => {
      expect(accountNoProblem("12345678")).toBe(桁数エラー);
    });

    it("11桁のダミー口座（00000000001）は、同一数字ではなく桁数エラーで止まる", () => {
      expect(accountNoProblem("00000000001")).toBe(桁数エラー);
    });

    it("空文字は桁数エラー", () => {
      expect(accountNoProblem("")).toBe(桁数エラー);
    });

    it("空白だけの入力は数字が0桁になり桁数エラー", () => {
      expect(accountNoProblem("   ")).toBe(桁数エラー);
    });
  });

  describe("同じ数字だけの番号", () => {
    it("0000000 は同一数字エラー（桁数は7桁で足りている）", () => {
      expect(accountNoProblem("0000000")).toBe(同一数字エラー);
    });

    it("1111 も同一数字エラー（4桁でも弾く）", () => {
      expect(accountNoProblem("1111")).toBe(同一数字エラー);
    });

    it("9999999 も同一数字エラー", () => {
      expect(accountNoProblem("9999999")).toBe(同一数字エラー);
    });

    it("5桁の 55555 も同一数字エラー（桁数は足りているので桁数エラーにはならない）", () => {
      expect(accountNoProblem("55555")).toBe(同一数字エラー);
    });

    it("000-0000 はハイフンを除くと 0000000 になるので同一数字エラー", () => {
      expect(accountNoProblem("000-0000")).toBe(同一数字エラー);
    });

    it("1111112 のように末尾が1文字違えば通る", () => {
      expect(accountNoProblem("1111112")).toBe("");
    });

    it("0000001 のように0が続いても最後が違えば通る", () => {
      expect(accountNoProblem("0000001")).toBe("");
    });

    it("桁数エラーと同一数字が両方当てはまる 000（3桁）は、桁数エラーが優先される", () => {
      expect(accountNoProblem("000")).toBe(桁数エラー);
    });

    it("同一数字の8桁（00000000）も、同一数字ではなく桁数エラーが優先される", () => {
      expect(accountNoProblem("00000000")).toBe(桁数エラー);
    });
  });

  describe("取り除かれる文字（ハイフン・空白）", () => {
    it("ハイフン入り 123-4567 は数字7桁とみなして通る", () => {
      expect(accountNoProblem("123-4567")).toBe("");
    });

    it("前後に空白がある ' 1234567 ' も通る", () => {
      expect(accountNoProblem(" 1234567 ")).toBe("");
    });

    it("改行を含む '1234\\n567' も数字7桁として通る", () => {
      expect(accountNoProblem("1234\n567")).toBe("");
    });

    it("英字だけの abcdefg は数字0桁で桁数エラー", () => {
      expect(accountNoProblem("abcdefg")).toBe(桁数エラー);
    });

    it("記号だけの ------- は数字0桁で桁数エラー", () => {
      expect(accountNoProblem("-------")).toBe(桁数エラー);
    });

    it("全角数字だけの １２３４５６７ は数字として数えられず桁数エラー", () => {
      expect(accountNoProblem("１２３４５６７")).toBe(桁数エラー);
    });
  });

  describe("null / undefined などの非文字列", () => {
    it("null は空文字として扱われ桁数エラー（例外は投げない）", () => {
      expect(accountNoProblem(null as unknown as string)).toBe(桁数エラー);
    });

    it("undefined も桁数エラー", () => {
      expect(accountNoProblem(undefined as unknown as string)).toBe(桁数エラー);
    });

    it("数値の 0 は falsy なので空文字に落ち、例外ではなく桁数エラーになる", () => {
      expect(accountNoProblem(0 as unknown as string)).toBe(桁数エラー);
    });
  });
});

describe("accountNoLooksReal", () => {
  it("通る番号（1234567）は true", () => {
    expect(accountNoLooksReal("1234567")).toBe(true);
  });

  it("桁数が足りない 123 は false", () => {
    expect(accountNoLooksReal("123")).toBe(false);
  });

  it("常に accountNoProblem が空かどうかと一致する（薄いラッパーであること）", () => {
    const 入力 = [
      "1234567",
      "1234",
      "123",
      "12345678",
      "0000000",
      "000-0000",
      "",
      "   ",
      "１２３４５６７",
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const v of 入力) {
      expect([v, accountNoLooksReal(v)]).toEqual([v, accountNoProblem(v) === ""]);
    }
  });
});

describe("bankReady", () => {
  it("4項目そろっていて口座番号も正しければ true", () => {
    expect(bankReady(振込先())).toBe(true);
  });

  it("null は false", () => {
    expect(bankReady(null)).toBe(false);
  });

  it("undefined も false（null と同じ扱い）", () => {
    expect(bankReady(undefined as unknown as BankFields | null)).toBe(false);
  });

  it("金融機関名が空なら false", () => {
    expect(bankReady(振込先({ bankName: "" }))).toBe(false);
  });

  it("支店名が空なら false", () => {
    expect(bankReady(振込先({ bankBranch: "" }))).toBe(false);
  });

  it("口座名義が空なら false", () => {
    expect(bankReady(振込先({ accountHolder: "" }))).toBe(false);
  });

  it("口座番号が空なら false", () => {
    expect(bankReady(振込先({ accountNo: "" }))).toBe(false);
  });

  it("口座番号が空白だけなら false（trim はしないが、数字0桁として弾かれる）", () => {
    expect(bankReady(振込先({ accountNo: "   " }))).toBe(false);
  });

  it("4項目そろっていても口座番号が8桁なら false", () => {
    expect(bankReady(振込先({ accountNo: "12345678" }))).toBe(false);
  });

  it("ダミー口座 00000000001 は false（この関数が防ぎたかったケース）", () => {
    expect(bankReady(振込先({ accountNo: "00000000001" }))).toBe(false);
  });

  it("0000000 も false", () => {
    expect(bankReady(振込先({ accountNo: "0000000" }))).toBe(false);
  });

  it("ハイフン入りの 123-4567 は true", () => {
    expect(bankReady(振込先({ accountNo: "123-4567" }))).toBe(true);
  });
});

describe("missingBankFields", () => {
  it("null なら4項目すべてを、金融機関名→支店名→口座番号→口座名義の順で返す", () => {
    expect(missingBankFields(null)).toEqual([
      "金融機関名",
      "支店名",
      "口座番号",
      "口座名義",
    ]);
  });

  it("undefined でも null と同じく4項目すべてを返す", () => {
    expect(
      missingBankFields(undefined as unknown as BankFields | null),
    ).toEqual(["金融機関名", "支店名", "口座番号", "口座名義"]);
  });

  it("すべて正しければ空配列", () => {
    expect(missingBankFields(振込先())).toEqual([]);
  });

  it("金融機関名だけ空なら ['金融機関名']", () => {
    expect(missingBankFields(振込先({ bankName: "" }))).toEqual(["金融機関名"]);
  });

  it("支店名だけ空なら ['支店名']", () => {
    expect(missingBankFields(振込先({ bankBranch: "" }))).toEqual(["支店名"]);
  });

  it("口座名義だけ空なら ['口座名義']", () => {
    expect(missingBankFields(振込先({ accountHolder: "" }))).toEqual([
      "口座名義",
    ]);
  });

  it("口座番号が空なら、桁数の説明ではなく項目名 '口座番号' を返す", () => {
    expect(missingBankFields(振込先({ accountNo: "" }))).toEqual(["口座番号"]);
  });

  it("口座番号が入っていて桁数が不正なら、項目名ではなく理由の文言を返す", () => {
    expect(missingBankFields(振込先({ accountNo: "12345678" }))).toEqual([
      桁数エラー,
    ]);
  });

  it("0000000 のときは同一数字の理由を返す", () => {
    expect(missingBankFields(振込先({ accountNo: "0000000" }))).toEqual([
      同一数字エラー,
    ]);
  });

  it("全角数字だけの口座番号は桁数エラーの文言になる", () => {
    expect(missingBankFields(振込先({ accountNo: "１２３４５６７" }))).toEqual([
      桁数エラー,
    ]);
  });

  it("複数欠けていても順番は 金融機関名→支店名→口座番号→口座名義 のまま", () => {
    expect(
      missingBankFields({
        bankName: "",
        bankBranch: "",
        accountNo: "",
        accountHolder: "",
      }),
    ).toEqual(["金融機関名", "支店名", "口座番号", "口座名義"]);
  });

  it("口座番号の理由は口座名義より前に入る", () => {
    expect(
      missingBankFields(振込先({ accountNo: "12", accountHolder: "" })),
    ).toEqual([桁数エラー, "口座名義"]);
  });
});

describe("bankReady と missingBankFields の整合", () => {
  it("bankReady が false なら missingBankFields は必ず1件以上返す", () => {
    const 落ちる振込先: (BankFields | null)[] = [
      null,
      振込先({ bankName: "" }),
      振込先({ bankBranch: "" }),
      振込先({ accountHolder: "" }),
      振込先({ accountNo: "" }),
      振込先({ accountNo: "   " }),
      振込先({ accountNo: "12345678" }),
      振込先({ accountNo: "00000000001" }),
      振込先({ accountNo: "0000000" }),
    ];
    for (const b of 落ちる振込先) {
      expect([b, bankReady(b)]).toEqual([b, false]);
      expect([b, missingBankFields(b).length > 0]).toEqual([b, true]);
    }
  });

  it("bankReady が true なら missingBankFields は空配列", () => {
    const 通る振込先 = [振込先(), 振込先({ accountNo: "123-4567" })];
    for (const b of 通る振込先) {
      expect([b, bankReady(b)]).toEqual([b, true]);
      expect([b, missingBankFields(b)]).toEqual([b, []]);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
//
// ただしブロックごと消さないこと。最後の1件（項目名と理由文の混在）だけは
// 口座番号の検証を正しく直しても残る別種の欠陥で、直すには戻り値の設計を変える必要がある。
//
// 原因はいずれも src/lib/bank.ts:34 の
//   const digits = (accountNo || "").replace(/[^0-9]/g, "");
// が「数字以外をすべて黙って捨てる」ことと、bankReady / missingBankFields が
// 文字列を trim せず truthy 判定だけで済ませていること。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥・最重要】全角数字が黙って除去され、8桁の口座番号が支払ゲートを通ってしまう", () => {
    // 本来は「8桁なので桁数エラー」を返すべき。
    // このモジュールの存在理由（7桁を超える番号を止める）そのものが破られている。
    // JotForm 経由の値は jotform-fields.ts:64 で trim されるだけで全角は残り、
    // intake.ts:984 が無検証で account_no に書き込むため実際に到達する。
    expect(accountNoProblem("1234567８")).toBe("");
    expect(accountNoLooksReal("1234567８")).toBe(true);
    expect(bankReady(振込先({ accountNo: "1234567８" }))).toBe(true);
    expect(missingBankFields(振込先({ accountNo: "1234567８" }))).toEqual([]);
  });

  it("【欠陥】全角1文字を含む8桁 0000000１ が、桁数エラーではなく同一数字エラーになる", () => {
    // 本来は「8桁なので桁数エラー」。全角の1が消えて 0000000（7桁）になった結果、
    // 誤った理由の文言が画面に出る。入力者は何を直せばよいのか分からない。
    expect(accountNoProblem("0000000１")).toBe(同一数字エラー);
  });

  it("【欠陥】半角と全角が混ざった 123４567 は、全角の4が消えて6桁扱いになり通ってしまう", () => {
    // 本来は「半角の数字4〜7桁で入力してください」と全角混入を弾くべき。
    expect(accountNoProblem("123４567")).toBe("");
  });

  it("【欠陥】英字混じりの abc1234xyz が、数字4桁あるというだけで通ってしまう", () => {
    // 本来は英字が混ざった時点で桁数エラー（メッセージは「半角の数字」と言っている）。
    expect(accountNoProblem("abc1234xyz")).toBe("");
  });

  it("【欠陥】記号・漢字混じりでも数字部分だけ見て通ってしまう", () => {
    // 本来、取り除いてよいのはハイフンと空白まで。
    // スラッシュや「普通」のような預金種目の書き込みは入力誤りとして弾くべき。
    expect(accountNoProblem("12/34/567")).toBe("");
    expect(accountNoProblem("普通1234567")).toBe("");
  });

  it("【欠陥】数値を渡すと replace で TypeError になる", () => {
    // 本来は String(accountNo ?? "") で正規化し、例外ではなく桁数エラーを返すべき。
    // 現行の呼び出し元（reward-actions.ts:51-55 / admin/rewards/page.tsx:163-166）は
    // String() 済みの値を渡しているため実運用では到達しないが、
    // 型を外れた値が1か所でも混ざれば画面が落ちる。
    expect(() => accountNoProblem(1234567 as unknown as string)).toThrow(
      TypeError,
    );
  });

  it("【欠陥】空白だけの金融機関名・支店名・口座名義が「入力あり」とみなされ bankReady が true になる", () => {
    // 本来は trim してから空判定すべき。空白だけの名義で支払済みにできてしまう。
    // 現在の書き込み経路（agency-actions.ts:112 の text() / jotform-fields.ts:64 の pick()）が
    // trim しているため実害は出ていないが、経路が1本増えた時点で穴になる。
    expect(bankReady(振込先({ bankName: " " }))).toBe(true);
    expect(bankReady(振込先({ bankBranch: "　" }))).toBe(true);
    expect(bankReady(振込先({ accountHolder: "　" }))).toBe(true);
  });

  it("【欠陥】空白だけの金融機関名が missingBankFields で「不足」として報告されない", () => {
    // 本来は ["金融機関名"] を返すべき。画面には何も出ないまま支払ボタンが押せる。
    expect(missingBankFields(振込先({ bankName: "   " }))).toEqual([]);
  });

  it("【欠陥】空白だけの口座番号が、項目名ではなく桁数の理由文で報告される", () => {
    // 本来は未入力なので ["口座番号"]（項目名）を返すべき。
    // 実装が accountNo を trim せず truthy 判定するため「入力あり」の枝に入ってしまう。
    expect(missingBankFields(振込先({ accountNo: "   " }))).toEqual([桁数エラー]);
  });

  it("【欠陥】項目名と理由文が同じ配列に混在し、画面の文が日本語として破綻する", () => {
    // 本来は「足りない項目名」と「入力内容の理由」を別々に返し、
    // 呼び出し側が別々の文にすべき。
    // admin/rewards/page.tsx の3か所（:553-558 の BankCell / :1017 / :1645）が join("・")
    // するため、実際の表示は下の assert の文字列そのものになる（「…がまだです」は :558）。
    // :1017 は「…をご登録ください。」、:1645 は「…をご登録のうえ、開き直してください。」。
    //
    // この1件だけは、口座番号の検証（bank.ts:34）を正しく直しても直らない。
    // 原因が値の検証ではなく戻り値の設計（項目名と理由文を同じ string[] に混ぜている）にあるため。
    const 実際 = missingBankFields(
      振込先({ bankName: "", accountNo: "12345678", accountHolder: "" }),
    );
    expect(実際).toEqual(["金融機関名", 桁数エラー, "口座名義"]);
    expect(実際.join("・") + "がまだです").toBe(
      "金融機関名・口座番号（半角の数字4〜7桁で入力してください）・口座名義がまだです",
    );
  });
});
