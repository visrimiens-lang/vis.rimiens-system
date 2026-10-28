import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import { itemNameFor, buildB2Csv, parseTracking, type CsvOrder } from "./yamato-csv";
import type { ShipperConfig } from "./yamato";

/**
 * yamato-csv のテスト。
 *
 * ■ このテストが保証していること
 *
 * いまの実装が出す42列の並びと中身が、今後の変更で黙って変わらないこと。
 * つまりリグレッションの固定であって、それ以上ではない。
 *
 * ■ このテストが保証していないこと（読む人が誤解しないように）
 *
 * 「42列という数と並びが、B2クラウドの基本レイアウトの正解と一致すること」は
 * 一切保証していない。ここに書いた列名は実装の行末コメント（// 11 お届け先郵便番号 など）
 * を写したもので、外部の正解と突き合わせていない。つまりオラクルが実装自身なので、
 * 並びが最初から間違っていても42列ぶん全部緑になる。
 *
 * しかもプロジェクト側の記録は、実装の前提と食い違っている:
 *   ・~/workspace/notes/mem0-export/目トレ.md:202
 *     公式PDFの送り状発行データレイアウトは「全97項目」（42ではない）
 *   ・同 :208
 *     「取込みパターンは必ず『新規レイアウト』。『基本レイアウト』は列を位置で
 *      固定割当てするため誤マッピングになる（出荷予定日欄に電話番号が入るのを実機確認）」
 *   ・notes/ヤマト送り状発行_操作マニュアル_運用担当者向け.md:128-130
 *     いまも「新規レイアウト」「取込み開始行=2」「CSVの見出しはB2の項目名にそろえてある」と指示
 *   ・notes/yamato-b2cloud-取込サンプル.csv
 *     見出し付き16列。42列・見出し無しの実データサンプルはリポジトリに無い
 *
 * 実装は逆に「基本レイアウト・見出し無し」を選んでいる（yamato-csv.ts:23-31）。
 * どちらが正しいかはB2クラウドの実機でしか決められないので、テストでは判定しない。
 * 少なくとも、見出し無しのCSVをマニュアル通り「取込み開始行=2」で取り込むと
 * 1件目の受注が黙って落ちる。実機確認とマニュアル更新が要る。
 */

/** 送り主・請求先の設定。個々のテストで一部だけ上書きして使う。 */
function 設定(over: Partial<ShipperConfig> = {}): ShipperConfig {
  return {
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
    ...over,
  };
}

/** 受注1件ぶんの出荷データ。 */
function 注文(over: Partial<CsvOrder> = {}): CsvOrder {
  return {
    orderId: "124",
    name: "山田太郎",
    zip: "150-0001",
    address: "東京都渋谷区神宮前1-1-1",
    phone: "090-1111-2222",
    quantity: 1,
    productName: "眼筋トレーニングマシンVIS本体",
    ...over,
  };
}

/** Shift_JISのBufferを文字列に戻す。 */
function 復号(buf: Buffer): string {
  return iconv.decode(buf, "Shift_JIS");
}

/** CRLFで区切って行にする（末尾の空行は落とす）。 */
function 行たち(buf: Buffer): string[] {
  const t = 復号(buf);
  const lines = t.split("\r\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * CSVの1行を列に分ける。引用符で囲まれた中のカンマでは切らず、
 * 二重の引用符は1つに戻す（= Excel/B2 が読むときと同じ扱い）。
 */
function 列に分ける(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let 引用符の中 = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (引用符の中) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          引用符の中 = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      引用符の中 = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 1件だけ渡して、その1行を列に分けたものを返す。 */
function 一行の列(
  o: Partial<CsvOrder> = {},
  cfg: ShipperConfig = 設定(),
  shipDate = "2026-09-10",
): string[] {
  const buf = buildB2Csv(cfg, [注文(o)], shipDate);
  return 列に分ける(行たち(buf)[0]);
}

/** 列の並びを固定するテストで使う、全項目が埋まった受注。 */
const 見本の受注: Partial<CsvOrder> = {
  orderId: "1024",
  name: "鈴木花子",
  zip: "150-0002",
  address: "東京都渋谷区渋谷2-2-2",
  phone: "090-3333-4444",
  building: "渋谷ハイツ305",
  quantity: 2,
  productName: "眼筋トレーニングマシンVIS本体",
};

/* ══════════════════ itemNameFor ══════════════════ */

describe("itemNameFor（送り状に印字する品名の出し分け）", () => {
  describe("パッドだけの買い足しかどうかの判定", () => {
    it("「パッド」を含み「本体」を含まない商品名は「ジェルパッド1年分」になる", () => {
      expect(itemNameFor(設定(), "ジェルパッド1年分（消耗品）")).toBe("ジェルパッド1年分");
    });

    it("「パット」の表記ゆれでも「ジェルパッド1年分」になる", () => {
      expect(itemNameFor(設定(), "ジェルパット 追加購入")).toBe("ジェルパッド1年分");
    });

    it("「本体」を含むとパッドの語があっても設定の品名になる（セット販売）", () => {
      expect(itemNameFor(設定(), "VIS本体＋ジェルパッド1年分セット")).toBe(
        "眼筋トレーニングマシンVIS",
      );
    });

    it("パッドと無関係な商品名は設定の品名になる", () => {
      expect(itemNameFor(設定(), "眼筋トレーニングマシンVIS本体")).toBe(
        "眼筋トレーニングマシンVIS",
      );
    });

    it("商品名が空文字なら設定の品名になる", () => {
      expect(itemNameFor(設定(), "")).toBe("眼筋トレーニングマシンVIS");
    });

    it("商品名が未定義でも落ちず、設定の品名になる", () => {
      expect(itemNameFor(設定(), undefined as unknown as string)).toBe(
        "眼筋トレーニングマシンVIS",
      );
    });
  });

  describe("25文字での切り詰め", () => {
    it("設定の品名が35文字あると先頭25文字だけになる", () => {
      const cfg = 設定({ itemName: "眼筋トレーニングマシンVIS本体一式スタンド保証書ジェル付き特別セット" });
      expect(itemNameFor(cfg, "VIS本体")).toBe("眼筋トレーニングマシンVIS本体一式スタンド保証書");
    });

    it("ちょうど25文字の品名はそのまま返る", () => {
      const 二十五文字 = "あ".repeat(25);
      expect(itemNameFor(設定({ itemName: 二十五文字 }), "VIS本体")).toBe(二十五文字);
    });

    it("26文字だと最後の1文字だけが落ちる（切る位置の境界）", () => {
      expect(itemNameFor(設定({ itemName: "あ".repeat(26) }), "VIS本体")).toBe("あ".repeat(25));
    });
  });
});

/* ══════════════════ buildB2Csv：列の並び ══════════════════ */

describe("buildB2Csv（B2基本レイアウトの列の並び）", () => {
  it("1件の受注が42列になる", () => {
    expect(一行の列()).toHaveLength(42);
  });

  it("見出し行を付けず、データ行だけを書き出す", () => {
    // 注意: 運用マニュアル（notes/ヤマト送り状発行_操作マニュアル_運用担当者向け.md:128-130）は
    // 「見出しあり・取込み開始行=2」を指示したままで、この実装と矛盾している。
    // マニュアル通りに取り込むと1件目の受注が黙って発送されない。
    const lines = 行たち(buildB2Csv(設定(), [注文()], "2026-09-10"));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("124,")).toBe(true);
  });

  it("42列すべての中身を1件ぶん固定する（列がひとつでもずれたら落ちる）", () => {
    // 列名は実装の行末コメントの写しで、B2の正解と突き合わせたものではない（冒頭の注記を参照）。
    //
    // 検出できないケース（ミューテーション検証で確認済み）:
    // 空の列どうしの入れ替え（例 34 コレクト代金引換額 ⇔ 35 内消費税額等）は
    // 出力バイト列がまったく同じになるため、CSVを見るどんなテストでも検出できない。
    // 42列のうち23列が空なので、その範囲の並べ替えは素通りする。
    // ここを塞ぐには実装側が列名を持つ必要がある（現状は行末コメントにしか無い）。
    expect(一行の列(見本の受注)).toEqual([
      "1024", //                      1 お客様管理番号
      "0", //                         2 送り状種類（発払い）
      "0", //                         3 クール区分（なし）
      "", //                          4 伝票番号（B2が採番）
      "2026/09/10", //                5 出荷予定日
      "", //                          6 お届け予定日
      "", //                          7 配達時間帯
      "", //                          8 お届け先コード
      "090-3333-4444", //             9 お届け先電話番号
      "", //                         10 電話番号枝番
      "1500002", //                  11 お届け先郵便番号
      "東京都渋谷区渋谷2-2-2", //    12 お届け先住所
      "渋谷ハイツ305", //            13 お届け先アパートマンション名
      "", //                         14 会社・部門1
      "", //                         15 会社・部門2
      "鈴木花子", //                 16 お届け先名
      "", //                         17 お届け先名(カナ)
      "様", //                       18 敬称
      "", //                         19 ご依頼主コード
      "03-9999-8888", //             20 ご依頼主電話番号
      "", //                         21 電話番号枝番
      "1040061", //                  22 ご依頼主郵便番号
      "東京都中央区銀座1-2-3", //    23 ご依頼主住所
      "", //                         24 ご依頼主アパートマンション名
      "目のトレーニング株式会社", // 25 ご依頼主名
      "", //                         26 ご依頼主名(カナ)
      "", //                         27 品名コード1
      "眼筋トレーニングマシンVIS", //28 品名1
      "", //                         29 品名コード2
      "", //                         30 品名2
      "", //                         31 荷扱い1
      "", //                         32 荷扱い2
      "", //                         33 記事
      "", //                         34 コレクト代金引換額
      "", //                         35 内消費税額等
      "", //                         36 止置き
      "", //                         37 止置き営業所コード
      "2", //                        38 発行枚数
      "", //                         39 個数口表示フラグ
      "093456789012", //             40 請求先顧客コード
      "001", //                      41 請求先分類コード
      "01", //                       42 運賃管理番号
    ]);
  });

  describe("値をそのまま流さず加工している列", () => {
    it("11列目=お届け先郵便番号はハイフンや〒を外した数字だけになる", () => {
      expect(一行の列({ zip: "〒150-0002" })[10]).toBe("1500002");
    });

    it("9列目=お届け先電話番号はハイフンを外さない（郵便番号と扱いが違う）", () => {
      expect(一行の列({ phone: "090-3333-4444" })[8]).toBe("090-3333-4444");
    });

    it("22列目=ご依頼主郵便番号もハイフンを外す", () => {
      expect(一行の列({}, 設定({ shipper: { ...設定().shipper, zip: "104-0061" } }))[21]).toBe(
        "1040061",
      );
    });

    it("22列目=ご依頼主郵便番号は〒もハイフンも全部落とす（置換は1文字目だけではない）", () => {
      // 数字以外が2つ以上あっても全部落とすこと。gフラグを外すと "104-0061" のまま出て、
      // B2が郵便番号を読めずに取込エラーになる。
      expect(
        一行の列({}, 設定({ shipper: { ...設定().shipper, zip: "〒104-0061" } }))[21],
      ).toBe("1040061");
    });

    it("20列目=ご依頼主電話番号は設定のまま出る", () => {
      expect(一行の列()[19]).toBe("03-9999-8888");
    });

    it("13列目=建物名は住所（12列目）と別の列に入る", () => {
      const col = 一行の列({ address: "東京都渋谷区渋谷2-2-2", building: "渋谷ハイツ305" });
      expect(col[11]).toBe("東京都渋谷区渋谷2-2-2");
      expect(col[12]).toBe("渋谷ハイツ305");
    });

    it("建物名を渡さないと13列目は空になる（undefinedのまま出さない）", () => {
      expect(一行の列({ building: undefined })[12]).toBe("");
    });

    it("18列目=敬称は受注に関係なく「様」固定", () => {
      expect(一行の列({ name: "鈴木花子" })[17]).toBe("様");
    });

    it("28列目=品名はitemNameForを通した結果になる（パッドのみなら差し替わる）", () => {
      expect(一行の列({ productName: "眼筋トレーニングマシンVIS本体" })[27]).toBe(
        "眼筋トレーニングマシンVIS",
      );
      expect(一行の列({ productName: "ジェルパッド1年分" })[27]).toBe("ジェルパッド1年分");
    });

    it("40〜42列目=請求先の3項目は設定の値がそのまま並ぶ", () => {
      const col = 一行の列(
        {},
        設定({ invoiceCode: "080715915541", invoiceCodeExt: "002", invoiceFreightNo: "03" }),
      );
      expect(col.slice(39, 42)).toEqual(["080715915541", "002", "03"]);
    });
  });
});

/* ══════════════════ buildB2Csv：出荷予定日 ══════════════════ */

describe("buildB2Csv（出荷予定日の整形）", () => {
  it("YYYY-MM-DD は YYYY/MM/DD になる", () => {
    expect(一行の列({}, 設定(), "2026-09-10")[4]).toBe("2026/09/10");
  });

  it("YYYYMMDD は YYYY/MM/DD になる（本番の呼び出し元はこの形）", () => {
    expect(一行の列({}, 設定(), "20261225")[4]).toBe("2026/12/25");
  });

  it("すでに YYYY/MM/DD ならそのまま", () => {
    expect(一行の列({}, 設定(), "2026/12/25")[4]).toBe("2026/12/25");
  });
});

/* ══════════════════ buildB2Csv：発行枚数 ══════════════════ */

describe("buildB2Csv（38列目=発行枚数）", () => {
  it("3台なら3", () => expect(一行の列({ quantity: 3 })[37]).toBe("3"));

  it("0なら1に読み替える（送り状が0枚だと出荷できないため）", () =>
    expect(一行の列({ quantity: 0 })[37]).toBe("1"));

  it("マイナスでも1に読み替える", () =>
    expect(一行の列({ quantity: -2 })[37]).toBe("1"));

  it("NaNは1に読み替える", () =>
    expect(一行の列({ quantity: Number.NaN })[37]).toBe("1"));
});

/* ══════════════════ buildB2Csv：エスケープ ══════════════════ */

describe("buildB2Csv（カンマ・引用符・改行のエスケープ）", () => {
  it("カンマを含む住所は引用符で囲まれ、列がずれない", () => {
    const buf = buildB2Csv(設定(), [注文({ address: "東京都渋谷区1-2-3, ハイツ101" })], "2026-09-10");
    const raw = 行たち(buf)[0];
    expect(raw).toContain('"東京都渋谷区1-2-3, ハイツ101"');
    const col = 列に分ける(raw);
    expect(col).toHaveLength(42);
    expect(col[11]).toBe("東京都渋谷区1-2-3, ハイツ101");
  });

  it("引用符を含む名前は引用符を2つに増やして囲む", () => {
    const buf = buildB2Csv(設定(), [注文({ name: '山田"太郎"' })], "2026-09-10");
    const raw = 行たち(buf)[0];
    expect(raw).toContain('"山田""太郎"""');
    expect(列に分ける(raw)[15]).toBe('山田"太郎"');
  });

  it("カンマと引用符の両方が入っていても1マスに収まる", () => {
    const col = 一行の列({ address: '渋谷区1-2-3,"別館"' });
    expect(col).toHaveLength(42);
    expect(col[11]).toBe('渋谷区1-2-3,"別館"');
  });

  it("改行（LF・CRLF）は半角スペースに置き換わり、行が増えない", () => {
    const buf = buildB2Csv(
      設定(),
      [注文({ building: "ハイツ101\n2階", address: "渋谷区1-1\r\n神宮前" })],
      "2026-09-10",
    );
    const lines = 行たち(buf);
    expect(lines).toHaveLength(1);
    const col = 列に分ける(lines[0]);
    expect(col[12]).toBe("ハイツ101 2階");
    expect(col[11]).toBe("渋谷区1-1 神宮前");
  });

  it("1マスに改行が2つあっても全部スペースになる（1つ目だけ置換しない）", () => {
    // 置換のgフラグを外すと2つ目以降の改行が残り、CSVの1行が途中で割れる。
    // 割れた先はB2が別のデータ行として読むので、全列が1つずつずれた送り状が出る。
    const buf = buildB2Csv(設定(), [注文({ building: "ハイツ101\n2階\n奥" })], "2026-09-10");
    const lines = 行たち(buf);
    expect(lines).toHaveLength(1);
    expect(列に分ける(lines[0])[12]).toBe("ハイツ101 2階 奥");
  });

  it("改行を置き換えただけの値は引用符で囲まれない（カンマも引用符も無いため）", () => {
    const raw = 行たち(buildB2Csv(設定(), [注文({ building: "ハイツ101\n2階" })], "2026-09-10"))[0];
    expect(raw).toContain(",ハイツ101 2階,");
    expect(raw).not.toContain('"ハイツ101 2階"');
  });

  it("受注IDにカンマが入っても囲まれるので、後段の突き合わせ列は保たれる", () => {
    const col = 一行の列({ orderId: "124,125" });
    expect(col[0]).toBe("124,125");
    expect(col).toHaveLength(42);
  });
});

/* ══════════════════ buildB2Csv：文字コードと行末 ══════════════════ */

describe("buildB2Csv（Shift_JIS・CRLF）", () => {
  it("Shift_JISで書き出す（「東京」は 93 8c 8b 9e の4バイト）", () => {
    const buf = buildB2Csv(設定(), [注文({ address: "東京" })], "2026-09-10");
    expect([...buf].map((b) => b.toString(16)).join(" ")).toContain("93 8c 8b 9e");
    // UTF-8なら1文字3バイト（e6 9d b1 e4 ba ac）なので、Shift_JISでないと成立しない
    expect(buf.includes(Buffer.from("東京", "utf8"))).toBe(false);
  });

  it("敬称の「様」もShift_JISの2バイト（97 6c）で入る", () => {
    const buf = buildB2Csv(設定(), [注文()], "2026-09-10");
    expect(buf.includes(Buffer.from([0x97, 0x6c]))).toBe(true);
  });

  it("行末はCRLFで、最終行のあとにもCRLFが付く", () => {
    const t = 復号(buildB2Csv(設定(), [注文({ orderId: "1" }), 注文({ orderId: "2" })], "2026-09-10"));
    expect(t.endsWith("\r\n")).toBe(true);
    expect(t).not.toContain("\n\n");
  });

  it("受注が複数あると件数ぶんの行になり、順番も保たれる", () => {
    const lines = 行たち(
      buildB2Csv(
        設定(),
        [注文({ orderId: "101" }), 注文({ orderId: "102" }), 注文({ orderId: "103" })],
        "2026-09-10",
      ),
    );
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => 列に分ける(l)[0])).toEqual(["101", "102", "103"]);
  });

  it("受注ごとに宛先が入れ替わらない（2件目の住所が1件目に混ざらない）", () => {
    const lines = 行たち(
      buildB2Csv(
        設定(),
        [
          注文({ orderId: "101", name: "山田太郎", address: "東京都渋谷区1-1-1" }),
          注文({ orderId: "102", name: "鈴木花子", address: "大阪府大阪市北区2-2-2" }),
        ],
        "2026-09-10",
      ),
    );
    expect(lines.map((l) => 列に分ける(l).slice(11, 12).concat(列に分ける(l)[15]))).toEqual([
      ["東京都渋谷区1-1-1", "山田太郎"],
      ["大阪府大阪市北区2-2-2", "鈴木花子"],
    ]);
  });
});

/* ══════════════════ parseTracking ══════════════════ */

describe("parseTracking（発行結果から受注IDと伝票番号を拾う）", () => {
  describe("基本の読み取り", () => {
    it("「受注ID,伝票番号」の2列だけを貼った形を読める", () => {
      expect(parseTracking("124,123456789012")).toEqual({
        pairs: [{ orderId: "124", trackingNo: "123456789012" }],
        skipped: [],
      });
    });

    it("タブ区切りでも読める（画面からのコピー貼り付け）", () => {
      expect(parseTracking("124\t123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("タブとカンマが混ざった行でも読める", () => {
      expect(parseTracking("124\t123456789012,山田太郎").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("各セルが引用符で囲まれていても読める", () => {
      expect(parseTracking('"124","123456789012"').pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("伝票番号にハイフンが入っていても外して読む", () => {
      expect(parseTracking("124,1234-5678-9012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("桁合わせの0が付いた受注ID（0000000124）は0を外して124にする", () => {
      expect(parseTracking("0000000124,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("受注IDと伝票番号が逆の順で並んでいても読める", () => {
      expect(parseTracking("123456789012,124").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("複数行をまとめて読める", () => {
      expect(parseTracking("124,123456789012\n125,123456789013").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "125", trackingNo: "123456789013" },
      ]);
    });

    it("CRLF区切りでも読める", () => {
      expect(parseTracking("124,123456789012\r\n125,123456789013").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "125", trackingNo: "123456789013" },
      ]);
    });

    it("前後の空白や空行は無視され、skippedにも入らない", () => {
      const r = parseTracking("\n\n   \n  124,123456789012  \n\n");
      expect(r.pairs).toEqual([{ orderId: "124", trackingNo: "123456789012" }]);
      expect(r.skipped).toEqual([]);
    });
  });

  describe("伝票番号の桁数の見分け", () => {
    it("同じ行に12桁と10桁があれば12桁を伝票番号にする（10桁を先に拾わない）", () => {
      expect(parseTracking("124,1234567890,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("11桁で先頭が0でなければ伝票番号として拾う", () => {
      expect(parseTracking("124,12345678901").pairs).toEqual([
        { orderId: "124", trackingNo: "12345678901" },
      ]);
    });

    it("10桁で先頭が0でなければ伝票番号として拾う", () => {
      expect(parseTracking("124,1234567890").pairs).toEqual([
        { orderId: "124", trackingNo: "1234567890" },
      ]);
    });

    it("先頭が0の10桁は伝票番号にしない（桁合わせの受注IDとの取り違え防止）", () => {
      const r = parseTracking("124,0123456789");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["124,0123456789"]);
    });

    it("13桁は伝票番号として認めず、その行を飛ばす", () => {
      const r = parseTracking("124,1234567890123");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["124,1234567890123"]);
    });

    it("9桁しかない行は伝票番号が見つからず飛ばす", () => {
      expect(parseTracking("124,123456789").pairs).toEqual([]);
    });
  });

  describe("受注IDの見分け", () => {
    it("10桁以上の数字は受注IDにしない（伝票番号しか読めず行を飛ばす）", () => {
      const r = parseTracking("1234567890,123456789012");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["1234567890,123456789012"]);
    });

    it("9桁ちょうどは受注IDとして拾う（10桁との境界）", () => {
      expect(parseTracking("123456789,123456789012").pairs).toEqual([
        { orderId: "123456789", trackingNo: "123456789012" },
      ]);
    });

    it("受注IDと伝票番号が同じ数字だと、両方が除外されて行を飛ばす", () => {
      const r = parseTracking("123456789012,123456789012");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["123456789012,123456789012"]);
    });

    it("0だけの受注IDは0を外すと空になるので採用されず、行を飛ばす", () => {
      const r = parseTracking("00000,123456789012");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["00000,123456789012"]);
    });

    it("0だけの列が受注IDより前にあっても、その後ろの正しい受注IDを拾う", () => {
      // 0を外すと空になる列は「見つからなかった」として読み飛ばし、探索を続ける。
      // 空文字ガードを外すと、この行は空の受注IDを掴んだまま丸ごとskippedに落ちる。
      const r = parseTracking("00000,124,123456789012");
      expect(r.pairs).toEqual([{ orderId: "124", trackingNo: "123456789012" }]);
      expect(r.skipped).toEqual([]);
    });

    it("伝票番号そのものは受注IDに使い回さない（同じ数字の二重取り）", () => {
      // 桁合わせの0が付いた12桁（000000000124）は、0を外すと124という短い数字になる。
      // 「伝票番号ではない数字」の除外を外すと、同じ1つの数字が伝票番号と受注IDの
      // 両方に化けて、実在する受注124に無関係の送り状番号が書き込まれる。
      const r = parseTracking("000000000124");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["000000000124"]);
    });

    it("携帯番号（11桁）は0を外しても10桁なので受注IDに拾われない", () => {
      expect(parseTracking("090-1111-2222,124,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("日付列が受注IDより後ろなら、受注IDが正しく拾われる", () => {
      expect(parseTracking("124,123456789012,2026/09/10").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });
  });

  describe("見出し行の扱い", () => {
    it("「お客様管理番号,伝票番号」の見出し行は飛ばし、skippedにも入れない", () => {
      expect(parseTracking("お客様管理番号,伝票番号,お届け先名")).toEqual({
        pairs: [],
        skipped: [],
      });
    });

    it("「送り状番号」「受注」を含む見出し行も飛ばす", () => {
      expect(parseTracking("受注ID\t送り状番号").skipped).toEqual([]);
    });

    // 見出し語は4つ（お客様管理番号 / 伝票番号 / 送り状番号 / 受注）。
    // 上のテストは1行に2語以上を含むため、語どうしが互いをマスクして
    // 「1語だけ消しても緑」になってしまう。1語ずつ単独で固定しておく。
    it("「伝票番号」の1語だけでも見出し行として飛ばす", () => {
      expect(parseTracking("伝票番号,お届け先名")).toEqual({ pairs: [], skipped: [] });
    });

    it("「お客様管理番号」の1語だけでも見出し行として飛ばす", () => {
      expect(parseTracking("お客様管理番号,お届け先名")).toEqual({ pairs: [], skipped: [] });
    });

    it("「送り状番号」の1語だけでも見出し行として飛ばす", () => {
      expect(parseTracking("送り状番号,お届け先名")).toEqual({ pairs: [], skipped: [] });
    });

    it("「受注」の1語だけでも見出し行として飛ばす", () => {
      expect(parseTracking("受注ID,お届け先名")).toEqual({ pairs: [], skipped: [] });
    });

    it("見出し行のあとのデータ行はちゃんと読める", () => {
      expect(parseTracking("お客様管理番号,伝票番号\n124,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("見出し語があっても9桁までしか数字が無ければ見出し行として飛ばす（10桁の境界・下）", () => {
      // データ行と見なす条件は「10桁の数字がある」。9桁で見出し扱いをやめると、
      // 伝票番号が読めない行がskippedに積まれて、担当者に無駄な確認をさせる。
      expect(parseTracking("受注,123456789")).toEqual({ pairs: [], skipped: [] });
    });

    it("見出し語があっても10桁ちょうどの伝票番号があればデータ行として読む（10桁の境界・上）", () => {
      // 条件を11桁に上げると、10桁の伝票番号が付いた行が見出しと誤判定され、
      // pairsにもskippedにも残らないまま無言で消える（取り込み漏れに気づけない）。
      expect(parseTracking("受注,124,1234567890").pairs).toEqual([
        { orderId: "124", trackingNo: "1234567890" },
      ]);
    });

    it("見出しの語を含んでいても10桁の数字があればデータ行として読む", () => {
      expect(parseTracking("受注,0000000124,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });
  });

  describe("読めない行の扱い", () => {
    it("読めない行はskippedに入り、pairsには入らない", () => {
      const r = parseTracking("124,123456789012\nこの行は数字が無い\n125,123456789013");
      expect(r.pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "125", trackingNo: "123456789013" },
      ]);
      expect(r.skipped).toEqual(["この行は数字が無い"]);
    });

    it("skippedに記録する行は前後の空白を落としたもの（生の行ではない）", () => {
      expect(parseTracking("  だめな行  ").skipped).toEqual(["だめな行"]);
    });

    it("skippedに入る行は先頭60文字までに切り詰められる", () => {
      const 長い行 = "メ".repeat(70);
      expect(parseTracking(長い行).skipped).toEqual(["メ".repeat(60)]);
    });

    it("同じ読めない行が2回あれば、skippedにも2回残る（重複除去はpairsだけ）", () => {
      expect(parseTracking("だめな行\nだめな行").skipped).toEqual(["だめな行", "だめな行"]);
    });

    it("全角数字は数字として拾われないので、その行は読めずskippedに残る", () => {
      const r = parseTracking("１２４,１２３４５６７８９０１２");
      expect(r.pairs).toEqual([]);
      expect(r.skipped).toEqual(["１２４,１２３４５６７８９０１２"]);
    });
  });

  describe("重複の除去", () => {
    it("まったく同じ組が2回出てきても1組にまとめ、skippedにも入れない", () => {
      const r = parseTracking("124,123456789012\n124,123456789012");
      expect(r.pairs).toEqual([{ orderId: "124", trackingNo: "123456789012" }]);
      expect(r.skipped).toEqual([]);
    });

    it("桁合わせの0の有無が違っても、同じ組と見なして1組にまとまる", () => {
      expect(parseTracking("0000000124,123456789012\n124,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
      ]);
    });

    it("同じ受注IDでも伝票番号が違えば別の組として両方残る", () => {
      expect(parseTracking("124,123456789012\n124,123456789013").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "124", trackingNo: "123456789013" },
      ]);
    });

    it("同じ伝票番号でも受注IDが違えば別の組として両方残る", () => {
      // 重複判定のキーは「受注ID:伝票番号」の両方で作る。伝票番号だけをキーにすると、
      // 同じ伝票番号に別の受注IDが付いた行（受注ID誤判定が起きている行そのもの）が
      // 2件目以降だけ無言で消え、pairsにもskippedにも残らず担当者が気づけなくなる。
      expect(parseTracking("124,123456789012\n125,123456789012").pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "125", trackingNo: "123456789012" },
      ]);
    });
  });

  describe("入力が空のとき", () => {
    it("空文字なら何も返さない", () => {
      expect(parseTracking("")).toEqual({ pairs: [], skipped: [] });
    });

    it("undefinedを渡しても落ちずに空で返る", () => {
      expect(parseTracking(undefined as unknown as string)).toEqual({
        pairs: [],
        skipped: [],
      });
    });
  });

  describe("受注IDより前に長い数字が無い形（B2出力の一部を貼った想定）", () => {
    // 注意: 実際のB2発行結果CSVのサンプルはリポジトリに無い（notes/yamato-b2cloud-取込サンプル.csv は
    // 取込用の16列で、発行結果ではない）。ここで確かめているのは「受注IDより前に長い数字が無い」
    // 都合のよい形だけで、本物の発行結果でこの前提が成り立つかは未確認。
    // 前提が崩れたときに何が起きるかは、末尾の「既知の欠陥」ブロックを参照。
    it("列が多くても、受注IDより前に長い数字が無ければ読める", () => {
      const b2出力 =
        'お客様管理番号,伝票番号,お届け先名\n' +
        '"0000000124","123456789012","山田太郎"\n' +
        '"0000000125","123456789013","鈴木花子"';
      const r = parseTracking(b2出力);
      expect(r.pairs).toEqual([
        { orderId: "124", trackingNo: "123456789012" },
        { orderId: "125", trackingNo: "123456789013" },
      ]);
      expect(r.skipped).toEqual([]);
    });
  });
});

/* ─────────────────────────────────────────────────────────────
   既知の欠陥（仕様ではない）
   ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
   通っていることは正しさを意味しない。
   ───────────────────────────────────────────────────────────── */

describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  describe("itemNameFor", () => {
    it("【欠陥】「本体は含みません」と否定していても本体扱いになり、パッドに本体の品名が印字される", () => {
      // 本来は「本体が同梱されているか」で判定すべき。/本体/ の部分一致なので否定文を読み分けられない。
      // 中身と違う品名が送り状に出る＝この関数のコメントが掲げる目的そのものが崩れている。
      expect(itemNameFor(設定(), "交換用ジェルパッド（本体は含みません）")).toBe(
        "眼筋トレーニングマシンVIS",
      );
    });

    it("【欠陥】半角36文字の品名が25文字で切れる（ヤマトの決まりは全角25＝半角50文字）", () => {
      // 本来は全角換算（半角0.5文字）で数えて50バイト相当まで通すべき。実装は code unit 数で切っている。
      const cfg = 設定({ itemName: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
      expect(itemNameFor(cfg, "VIS本体")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXY");
    });

    it("【欠陥】サロゲートペアの途中で切れて、壊れた半分の文字が末尾に残る", () => {
      // 本来は文字単位（[...name].slice(0,25)）で切るべき。25 code unit で切るため絵文字が割れる。
      // Shift_JIS変換で "?" になるので送り状の見た目の実害は小さいが、切り方としては壊れている。
      const 結果 = itemNameFor(設定({ itemName: "🚀".repeat(20) }), "VIS本体");
      expect(結果).toHaveLength(25);
      const 末尾 = 結果.charCodeAt(24);
      expect(末尾 >= 0xd800 && 末尾 <= 0xdbff).toBe(true); // 対になる下位サロゲートが無い
    });

    it("【欠陥】設定の品名が空文字だと、品名列が空のまま送り状が出る", () => {
      // 本来は空の品名を弾くか、既定の品名にフォールバックすべき（品名はB2の必須項目）。
      expect(一行の列({}, 設定({ itemName: "" }))[27]).toBe("");
    });

    it("【欠陥】設定の品名がundefinedだとTypeErrorで落ちる（CSV全体が出せなくなる）", () => {
      // 本来は空扱いにするか、設定読み込みの時点で弾くべき。name.slice(0,25) が undefined に当たる。
      expect(() =>
        itemNameFor(設定({ itemName: undefined as unknown as string }), "VIS本体"),
      ).toThrow(TypeError);
    });
  });

  describe("buildB2Csv：出荷予定日の桁数を検査していない", () => {
    // 本来は「数字がちょうど8桁か」を確かめ、違えばエラーにすべき。
    // 実装は数字を抜き出して位置で切るだけなので、8桁でない入力が黙って壊れた日付になる。
    // 現在の唯一の呼び出し元（api/yamato/csv/route.ts:76）は必ず8桁を渡すため実運用では起きないが、
    // B2は「本日〜30日後」以外を弾くので、壊れた日付は取込エラーとして現場に出る。

    it("【欠陥】1桁の月日が混じる「2026年9月10日」が 2026/91/0 になる", () => {
      expect(一行の列({}, 設定(), "2026年9月10日")[4]).toBe("2026/91/0");
    });

    it("【欠陥】ハイフン区切りでも0詰めが無い「2026-9-1」は 2026/91/ になる", () => {
      expect(一行の列({}, 設定(), "2026-9-1")[4]).toBe("2026/91/");
    });

    it("【欠陥】空文字を渡すと「//」だけの列になる", () => {
      expect(一行の列({}, 設定(), "")[4]).toBe("//");
    });

    it("【欠陥】数字が1つも無い「abc」でも例外にならず「//」になる", () => {
      expect(一行の列({}, 設定(), "abc")[4]).toBe("//");
    });

    it("【欠陥】14桁の日時を渡すと、余りが黙って捨てられて先頭8桁だけになる", () => {
      expect(一行の列({}, 設定(), "20260910123456")[4]).toBe("2026/09/10");
    });
  });

  describe("buildB2Csv：発行枚数を整数に丸めていない", () => {
    // 本来は整数に丸める（または弾く）べき。String() をそのまま通しているため、
    // 送り状の枚数欄に整数でない文字列が出る。
    // 呼び出し元は Number(o.quantity ?? 1) || 1 とDBのinteger制約で守られているので、
    // 現状は到達しない防御漏れ。

    it("【欠陥】小数はそのまま「2.5」と出る", () => {
      expect(一行の列({ quantity: 2.5 })[37]).toBe("2.5");
    });

    it("【欠陥】0より大きく1未満の 0.5 も、1に読み替えられず「0.5」と出る", () => {
      // 判定は「0より大きいか」であって「1以上か」ではない。
      // 本来は1未満を1に読み替えるべき（送り状を0.5枚は発行できない）。
      // ここは条件の境界も固定している: > 0 を >= 1 に変えると 0.5 が "1" になり落ちる。
      expect(一行の列({ quantity: 0.5 })[37]).toBe("0.5");
    });

    it("【欠陥】Infinityは「Infinity」という文字列になる（呼び出し元の ||1 も通り抜ける）", () => {
      expect(一行の列({ quantity: Number.POSITIVE_INFINITY })[37]).toBe("Infinity");
    });
  });

  describe("buildB2Csv：文字の取りこぼし", () => {
    it("【欠陥】LFを伴わない単独のCRが置換されず、引用符も付かないまま出力される", () => {
      // 本来は /[\r\n]/ で置き換えるべき。CR単独でも行を割る読み手だと1行が3行に化ける。
      const buf = buildB2Csv(設定(), [注文({ building: "ハイツ101\r2階" })], "2026-09-10");
      expect(復号(buf)).toContain("ハイツ101\r2階");
    });

    it("【欠陥】Shift_JISに無い文字（絵文字）が黙って「?」になり、氏名・住所が壊れる", () => {
      // 本来は変換できない文字を検出して、担当者に知らせるべき。
      // 外部フォーム経由の入力があるため実際に起こりうる。
      const buf = buildB2Csv(設定(), [注文({ name: "山田🚀太郎" })], "2026-09-10");
      expect(列に分ける(行たち(buf)[0])[15]).toBe("山田?太郎");
    });

    it("【欠陥】受注0件でも空にならず、改行だけの2バイトが返る", () => {
      // 本来は0件なら空のBufferを返すべき（B2に空行1行のファイルを渡すことになる）。
      // 唯一の呼び出し元が0件を400で弾いているため、現状は到達しない。
      const buf = buildB2Csv(設定(), [], "2026-09-10");
      expect(buf).toHaveLength(2);
      expect(復号(buf)).toBe("\r\n");
    });
  });

  describe("parseTracking：受注IDの取り違え（実害が最も大きい）", () => {
    // 本来は「どの列が受注IDでどの列が伝票番号か」を決めて読むべき。
    // 実装は「同じ行にある9桁以下の数字」を受注IDにするため、受注IDより前に
    // 小さい数字の列があると、そちらを受注IDとして採用してしまう。
    // 存在しない番号なら yamato-actions.ts が「この番号の受注がありません」と出すが、
    // 実在する番号だと同 344-352行 が別の受注に tracking_no を書き込み、
    // ship_status を「出荷手配中」に変え、customers にも写す。
    // → 無関係のお客様のマイページに他人の送り状番号が出る。

    it("【欠陥】行番号や個口などの小さい数字が先頭にあると、それが受注IDになる（最悪ケース）", () => {
      // 受注ID "1" は実在する可能性が高く、そのまま別の受注が上書きされる。
      expect(parseTracking("1,124,123456789012").pairs).toEqual([
        { orderId: "1", trackingNo: "123456789012" },
      ]);
    });

    it("【欠陥】郵便番号が受注IDより前にあると、郵便番号が受注IDになる", () => {
      expect(parseTracking("150-0001,124,123456789012").pairs).toEqual([
        { orderId: "1500001", trackingNo: "123456789012" },
      ]);
    });

    it("【欠陥】固定電話が受注IDより前にあると、電話番号が受注IDになる", () => {
      // 0312345678 → 先頭の0が外れて 312345678（9桁）。実在しない番号なので実害は取り込み漏れで済む。
      expect(parseTracking("03-1234-5678,124,123456789012").pairs).toEqual([
        { orderId: "312345678", trackingNo: "123456789012" },
      ]);
    });

    it("【欠陥】日付列が受注IDより前にあると、日付が受注IDになる", () => {
      // 20260910（8桁）が受注IDの条件に当たる。これも実在しない番号なので取り込み漏れで済む。
      expect(parseTracking("2026/09/10,124,123456789012,山田太郎").pairs).toEqual([
        { orderId: "20260910", trackingNo: "123456789012" },
      ]);
    });
  });

  describe("parseTracking：伝票番号の取り違え", () => {
    it("【欠陥】12桁が1行に2つあると、先頭の12桁が無言で伝票番号になる", () => {
      // 本来は12桁が複数あれば曖昧として飛ばす（skippedに残す）べき。
      // 請求先顧客コードは12桁（本番 080715915541）なので、B2の発行結果で
      // 請求先顧客コード列が送り状番号より前にあると、顧客コードが伝票番号として保存される。
      expect(parseTracking("080715915541,123456789012,124").pairs).toEqual([
        { orderId: "124", trackingNo: "080715915541" },
      ]);
    });
  });

  describe("parseTracking：見出し行の判定で正当なデータ行が消える", () => {
    // 本来は「1行目だけ見出しとして扱う」「数字の組が読めるなら見出しではない」など、
    // データ行を落とさない判定にすべき。かつ、落とすなら skipped に残して画面に出すべき
    // （skipped は yamato-actions.ts:311,313 で担当者に見せる前提の返り値）。
    // 現状は pairs にも skipped にも入らないので、担当者は取り込み漏れに気づけない。

    it("【欠陥】伝票番号にハイフンが入った行に見出し語が混ざると、丸ごと無言で消える", () => {
      // 「受注」を含み、かつハイフンで10桁連続が途切れるため見出し行と判定される。
      // ハイフン付き伝票番号は 基本の読み取り のテストが示すとおり本来は読める形。
      expect(parseTracking("受注124,1234-5678-9012")).toEqual({ pairs: [], skipped: [] });
    });
  });
});
