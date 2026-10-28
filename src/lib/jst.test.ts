import { describe, it, expect, afterEach, vi } from "vitest";
import { todayInJapan, thisMonthInJapan, jpDateTime } from "@/lib/jst";

/**
 * 日本時間（JST = UTC+9、サマータイムなし）の扱いを固定する。
 *
 * Vercel のサーバーは UTC で動くため、日本の 0〜9 時に日付が前日にずれる事故が
 * 実際に起きている。ここでは「UTC の何時が日本の何日になるか」を
 * 手計算した値でハードコードして固定する。
 *
 * 変換の基準（すべて UTC+9）:
 *   UTC 2026-08-25T15:00:00Z = JST 2026-08-26 00:00（日付が変わる瞬間）
 *   UTC 2026-08-25T14:59:59Z = JST 2026-08-25 23:59（まだ前日）
 *   UTC 2026-08-28T00:00:00Z = JST 2026-08-28 09:00（UTC の深夜は日本の朝）
 *
 * 実行時のローカルタイムゾーンは vitest.config.ts で TZ="UTC" に固定してある。
 * 本番（Vercel）と同じ条件。ここを Asia/Tokyo にすると
 * 「Asia/Tokyo に変換している」と「たまたま実行環境が JST だった」が区別できなくなり、
 * このモジュールが存在する唯一の理由（UTC 環境での日付ずれ）を検出できなくなる。
 * TZ を書き換えてテストを通す、という直し方は禁止。
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("todayInJapan（日本時間での今日の日付）", () => {
  it("UTC 15:00 ちょうどで、日本の日付は翌日に変わる", () => {
    expect(todayInJapan(new Date("2026-08-25T15:00:00Z"))).toBe("2026-08-26");
  });

  it("UTC 14:59:59.999 は、日本ではまだ同じ日（2026-08-25 の 23:59）", () => {
    expect(todayInJapan(new Date("2026-08-25T14:59:59.999Z"))).toBe("2026-08-25");
  });

  it("UTC の深夜 0 時は、日本では同じ日の午前 9 時なので日付は変わらない", () => {
    expect(todayInJapan(new Date("2026-08-28T00:00:00Z"))).toBe("2026-08-28");
  });

  it("UTC 23:00（日本は翌日の朝 8 時）は翌日の日付になる", () => {
    expect(todayInJapan(new Date("2026-08-28T23:00:00Z"))).toBe("2026-08-29");
  });

  it("実行環境の日付（UTC）をそのまま切り出した値とは、UTC 15 時以降で必ず食い違う", () => {
    // 事故の再現。toISOString().slice(0,10) 相当の素朴な実装に差し替えられたら
    // ここが落ちる（実行環境が UTC 固定なので、両者が一致したら変換していない証拠）。
    const now = new Date("2026-08-25T15:30:00Z");
    expect(todayInJapan(now)).toBe("2026-08-26");
    expect(todayInJapan(now)).not.toBe(now.toISOString().slice(0, 10));
  });

  it("月をまたぐ境界（UTC 8/31 15:00 = JST 9/1 0:00）で月が繰り上がる", () => {
    expect(todayInJapan(new Date("2026-08-31T15:00:00Z"))).toBe("2026-09-01");
    expect(todayInJapan(new Date("2026-08-31T14:59:59Z"))).toBe("2026-08-31");
  });

  it("年をまたぐ境界（UTC 2025/12/31 15:00 = JST 2026/1/1 0:00）で年が繰り上がる", () => {
    expect(todayInJapan(new Date("2025-12-31T15:00:00Z"))).toBe("2026-01-01");
    expect(todayInJapan(new Date("2025-12-31T14:59:59Z"))).toBe("2025-12-31");
  });

  it("月・日が 1 桁でもゼロ埋めされた YYYY-MM-DD で返る", () => {
    expect(todayInJapan(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
    expect(todayInJapan(new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02");
  });

  it("現実的な日付では必ず YYYY-MM-DD の 10 文字になる（区切りはハイフン）", () => {
    for (const iso of [
      "2026-01-01T00:00:00Z",
      "2026-06-15T12:00:00Z",
      "2026-12-31T23:59:59Z",
      "1999-09-09T09:09:09Z",
    ]) {
      const result = todayInJapan(new Date(iso));
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("エポック 0（UTC 1970-01-01 0:00 = JST 同日 9:00）は 1970-01-01", () => {
    expect(todayInJapan(new Date(0))).toBe("1970-01-01");
  });

  it("引数を省略すると、そのときの現在時刻を日本時間で解釈する", () => {
    vi.useFakeTimers();
    // UTC では 2026-08-25。日本時間ではすでに 2026-08-26 の 3:00。
    vi.setSystemTime(new Date("2026-08-25T18:00:00Z"));
    expect(todayInJapan()).toBe("2026-08-26");
  });

  it("不正な Date を渡すと RangeError を投げる（フォールバックしない）", () => {
    expect(() => todayInJapan(new Date("これは日付ではない"))).toThrow(RangeError);
  });

  it("扱える範囲を超えた Date（8.64e15 + 1）も RangeError を投げる", () => {
    expect(() => todayInJapan(new Date(8.64e15 + 1))).toThrow(RangeError);
  });
});

describe("thisMonthInJapan（日本時間での今月）", () => {
  it("YYYY-MM の形で返る", () => {
    expect(thisMonthInJapan(new Date("2026-08-28T10:08:00Z"))).toBe("2026-08");
  });

  it("UTC 8/31 15:00（JST 9/1 0:00）で翌月になる", () => {
    expect(thisMonthInJapan(new Date("2026-08-31T15:00:00Z"))).toBe("2026-09");
  });

  it("UTC 8/31 14:59（JST 8/31 23:59）はまだ 8 月のまま", () => {
    expect(thisMonthInJapan(new Date("2026-08-31T14:59:59Z"))).toBe("2026-08");
  });

  it("UTC 2025/12/31 15:00（JST 2026/1/1 0:00）で年をまたいで 2026-01 になる", () => {
    expect(thisMonthInJapan(new Date("2025-12-31T15:00:00Z"))).toBe("2026-01");
  });

  it("UTC 2026/1/1 0:00（JST 同日 9:00）は 2026-01", () => {
    expect(thisMonthInJapan(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("引数を省略すると、そのときの現在時刻の月を返す", () => {
    vi.useFakeTimers();
    // UTC では 2026-09-30。日本時間ではすでに 2026-10-01 の 6:00。
    vi.setSystemTime(new Date("2026-09-30T21:00:00Z"));
    expect(thisMonthInJapan()).toBe("2026-10");
  });

  it("不正な Date を渡すと RangeError を投げる（todayInJapan と同じ挙動）", () => {
    expect(() => thisMonthInJapan(new Date("これは日付ではない"))).toThrow(RangeError);
  });
});

describe("jpDateTime（日時の表示用文字列）", () => {
  it("null を渡すと空文字を返す", () => {
    expect(jpDateTime(null)).toBe("");
  });

  it("undefined を渡すと空文字を返す", () => {
    expect(jpDateTime(undefined)).toBe("");
  });

  it("空文字・空白だけの文字列は空文字を返す", () => {
    expect(jpDateTime("")).toBe("");
    expect(jpDateTime("   ")).toBe("");
    expect(jpDateTime("\t\n ")).toBe("");
  });

  it("timestamptz の UTC 文字列を日本時間に直して表示する（+9 時間）", () => {
    expect(jpDateTime("2026-08-28T10:08:00Z")).toBe("2026-08-28 19:08");
  });

  it("オフセット表記（+00:00）でも同じ結果になる", () => {
    expect(jpDateTime("2026-08-28T10:08:00+00:00")).toBe("2026-08-28 19:08");
  });

  it("Postgres が返すマイクロ秒付きの値も扱える", () => {
    expect(jpDateTime("2026-08-28T10:08:00.123456+00:00")).toBe("2026-08-28 19:08");
  });

  it("UTC 以外のオフセットも日本時間に換算する（+09:00 はそのまま）", () => {
    expect(jpDateTime("2026-08-28T19:08:00+09:00")).toBe("2026-08-28 19:08");
  });

  it("マイナスのオフセット（-05:00）も日本時間に換算する", () => {
    // -05:00 の 05:08 = UTC 10:08 = JST 19:08
    expect(jpDateTime("2026-08-28T05:08:00-05:00")).toBe("2026-08-28 19:08");
  });

  it("同じ瞬間を指す表記なら、オフセットが違っても同じ文字列になる", () => {
    const utc = jpDateTime("2026-08-28T10:08:00Z");
    expect(jpDateTime("2026-08-28T19:08:00+09:00")).toBe(utc);
    expect(jpDateTime("2026-08-28T05:08:00-05:00")).toBe(utc);
  });

  it("UTC の深夜 0 時は、日本時間の朝 9 時として表示される", () => {
    expect(jpDateTime("2026-08-28T00:00:00Z")).toBe("2026-08-28 09:00");
  });

  it("UTC 15:00 ちょうどで、表示上の日付が翌日 00:00 に変わる", () => {
    expect(jpDateTime("2026-08-28T15:00:00Z")).toBe("2026-08-29 00:00");
    expect(jpDateTime("2026-08-28T14:59:00Z")).toBe("2026-08-28 23:59");
  });

  it("先頭 16 文字を切り出す旧実装とは 9 時間ずれる（事故の再現）", () => {
    // 旧実装の見た目は 2026-08-28 02:30。実際の日本時間は 11:30。
    const raw = "2026-08-28T02:30:00Z";
    expect(jpDateTime(raw)).toBe("2026-08-28 11:30");
    expect(jpDateTime(raw)).not.toBe(raw.slice(0, 16).replace("T", " "));
  });

  it("年をまたぐ値も正しく繰り上がる", () => {
    expect(jpDateTime("2025-12-31T15:00:00Z")).toBe("2026-01-01 00:00");
  });

  it("秒は表示されない（切り捨てられる）", () => {
    expect(jpDateTime("2026-08-28T10:08:59Z")).toBe("2026-08-28 19:08");
  });

  it("前後の空白は無視して解釈する", () => {
    expect(jpDateTime("  2026-08-28T10:08:00Z  ")).toBe("2026-08-28 19:08");
  });

  it("日付として読めない文字列は、画面を壊さないようそのまま返す", () => {
    expect(jpDateTime("未定")).toBe("未定");
    expect(jpDateTime("not a date")).toBe("not a date");
  });

  it("エポックミリ秒の数値文字列は解釈できず、そのまま返る", () => {
    expect(jpDateTime("1735689600000")).toBe("1735689600000");
  });

  it("月が範囲外（13 月）の値は解釈できず、そのまま返る", () => {
    expect(jpDateTime("2026-13-01T00:00:00Z")).toBe("2026-13-01T00:00:00Z");
  });

  it("日が範囲外（32 日）の値は解釈できず、そのまま返る", () => {
    expect(jpDateTime("2026-08-32T00:00:00Z")).toBe("2026-08-32T00:00:00Z");
  });

  it("エポック 0 は 1970-01-01 09:00（JST）になる", () => {
    expect(jpDateTime("1970-01-01T00:00:00Z")).toBe("1970-01-01 09:00");
  });
});

describe("todayInJapan / thisMonthInJapan / jpDateTime の整合性", () => {
  const moments = [
    "2026-08-25T15:00:00Z",
    "2026-08-25T14:59:59Z",
    "2026-08-28T00:00:00Z",
    "2026-08-31T15:00:00Z",
    "2025-12-31T15:00:00Z",
    "1970-01-01T00:00:00Z",
  ];

  it("同じ瞬間なら jpDateTime の日付部分は todayInJapan と一致する", () => {
    // 片方だけ壊す変更（一方のフォーマッタから timeZone を落とす等）を検出する。
    for (const iso of moments) {
      expect(jpDateTime(iso).slice(0, 10)).toBe(todayInJapan(new Date(iso)));
    }
  });

  it("thisMonthInJapan は todayInJapan の先頭 7 文字と一致する", () => {
    for (const iso of moments) {
      expect(thisMonthInJapan(new Date(iso))).toBe(todayInJapan(new Date(iso)).slice(0, 7));
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 時間帯が「Asia/Tokyo」であることの固定。
//
// ここまでのテストは「UTC+9 になっていること」しか見ていない。
// timeZone を "Asia/Seoul" に書き換えても、"Etc/GMT-9" に書き換えても、
// あるいは jst.ts の doc が退けた「＋9時間して ISO を切り出す」実装に戻しても、
// 現代の日時では出力が1文字も変わらないため全部素通りしてしまう。
//
// 韓国は 1988 年（ソウル五輪）に夏時間 UTC+10 を使い、日本は 1888 年に
// 標準時を採用するまで東京の地方時 UTC+9:18:59 だった。
// この2つの時期の値を1件ずつ置いておくと、「たまたま +9 時間ずれる何か」と
// 「本当に Asia/Tokyo」とを区別できる。
// 落ちたら、まず jst.ts の timeZone 指定が書き換わっていないかを疑うこと。
// ─────────────────────────────────────────────────────────────
describe("時間帯が Asia/Tokyo であること（UTC+9 なだけでは足りない）", () => {
  it("1988 年夏（韓国は夏時間 UTC+10）の日付は、韓国時間と1日ずれる", () => {
    // JST 1988-08-01 23:30。同じ瞬間の韓国（KDT = UTC+10）は 1988-08-02 00:30。
    expect(todayInJapan(new Date("1988-08-01T14:30:00Z"))).toBe("1988-08-01");
  });

  it("1988 年夏の月境界も、韓国時間なら翌月に繰り上がるところで 7 月のまま", () => {
    // JST 1988-07-31 23:30 / KDT 1988-08-01 00:30。
    expect(thisMonthInJapan(new Date("1988-07-31T14:30:00Z"))).toBe("1988-07");
  });

  it("1988 年夏の日時表示は、韓国時間より 1 時間早い", () => {
    // JST 09:00 / KDT 10:00。jpDateTime 側のフォーマッタの時間帯を固定する。
    expect(jpDateTime("1988-08-01T00:00:00Z")).toBe("1988-08-01 09:00");
  });

  it("標準時採用前（1887 年）は、固定オフセット +9:00 ではなく東京の地方時 +9:18:59 になる", () => {
    // 「＋9時間する」実装や timeZone: "Etc/GMT-9" なら 1887-06-15 09:00 になる。
    expect(jpDateTime("1887-06-15T00:00:00Z")).toBe("1887-06-15 09:18");
  });

  it("標準時採用前の日付境界も、固定オフセット +9:00 とは 1 日ずれる", () => {
    // 東京の地方時では 1887-06-15 00:08。固定 +9:00 なら 1887-06-14 23:50 のまま。
    expect(todayInJapan(new Date("1887-06-14T14:50:00Z"))).toBe("1887-06-15");
  });
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
//
// 根本原因はほぼ一つ: jpDateTime が入力を素朴な new Date(v) に渡していること。
// タイムゾーンなしの文字列は「実行環境のローカル時刻」として解釈され、
// 範囲外の日付は黙って繰り上がり、日付だけの値には存在しない時刻が付く。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】タイムゾーンなしの日時が実行環境（UTC）のローカル時刻として解釈され、9 時間ずれる", () => {
    // 本来は「日本時間の 19:08」として 2026-08-28 19:08 と表示すべき。
    // 本番（Vercel = UTC）では UTC の 19:08 とみなされ、JST 換算で +9 時間ずれる。
    expect(jpDateTime("2026-08-28T19:08:00")).toBe("2026-08-29 04:08");
    expect(jpDateTime("2026-08-28 19:08")).toBe("2026-08-29 04:08");
  });

  it("【欠陥】同じ壁時計の値でも、オフセットの有無だけで結果が変わる", () => {
    // 本来はどちらも同じ「2026-08-28 19:08」になるべき。
    // ローカル TZ 依存であること自体を、値ではなく関係として固定する。
    expect(jpDateTime("2026-08-28T19:08:00")).not.toBe(jpDateTime("2026-08-28T19:08:00+09:00"));
  });

  it("【欠陥】Postgres の timestamp without time zone（スペース区切り＋マイクロ秒）も同じくローカル解釈される", () => {
    // 本来は保存されている値をそのまま 2026-08-28 10:08 と表示すべき。
    // tz なし文字列なので実行環境依存になり、UTC 環境では +9 時間ずれる。
    expect(jpDateTime("2026-08-28 10:08:00.123456")).toBe("2026-08-28 19:08");
    expect(jpDateTime("2026-08-28 10:08:00")).toBe("2026-08-28 19:08");
  });

  it("【欠陥】日付だけの文字列に、存在しない時刻 09:00 が付いて表示される", () => {
    // 本来は「2026-08-28」のまま返すか、時刻なしで表示すべき。
    // ISO の日付だけの形は UTC 0 時とみなされ、JST 換算で 9:00 になる。
    expect(jpDateTime("2026-08-28")).toBe("2026-08-28 09:00");
  });

  it("【欠陥】存在しない日付（2026-02-29）がエラーにならず 3 月 1 日に繰り上がる", () => {
    // 本来は読めない値として "2026-02-29T00:00:00Z" をそのまま返すべき。
    // 範囲外の月（13 月）や日（32 日）はそのまま返るのに、2/29 型だけ黙って化ける。
    expect(jpDateTime("2026-02-29T00:00:00Z")).toBe("2026-03-01 09:00");
  });

  it("【欠陥】短い数字だけの文字列が年号とみなされ、日付に化ける", () => {
    // 本来は日付として読めない値なので、そのまま返すべき（"1735689600000" と同じ扱い）。
    expect(jpDateTime("2026")).toBe("2026-01-01 09:00");
    expect(jpDateTime("12345")).toBe("12345-01-01 09:00");
  });

  it("【欠陥】読めない文字列が、原文そのままではなく前後の空白を落とした形で返る", () => {
    // 本来は jst.ts の doc が約束する「そのまま返して画面を壊さない」どおり、
    // 受け取った "  未定  " をそのまま返すべき（あるいは doc 側を「trim して返す」に直すべき）。
    // 契約文言と実装が食い違っているだけで実害は無いが、仕様として固定はしない。
    expect(jpDateTime("  未定  ")).toBe("未定");
  });

  it("【欠陥】文字列以外を渡すと TypeError で画面ごと落ちる", () => {
    // 本来は「読めない値が来たら、そのまま返して画面を壊さない」という
    // jst.ts の文書化された契約どおり、空文字か文字列化した値を返すべき。
    // `value ?? ""` は null / undefined しか守っていない。
    expect(() => jpDateTime(new Date("2026-08-28T10:08:00Z") as unknown as string)).toThrow(TypeError);
    expect(() => jpDateTime(0 as unknown as string)).toThrow(TypeError);
    expect(() => jpDateTime(Number.NaN as unknown as string)).toThrow(TypeError);
  });

  it("【欠陥】西暦 4 桁未満の年がゼロ埋めされず、YYYY-MM-DD の形が崩れる", () => {
    // 本来は "0099-06-15" / "0099-06" を返すべき。
    // year:"numeric" はゼロ埋めしないため、固定長前提の slice(0, 7) が一緒に壊れる。
    const day = todayInJapan(new Date("0099-06-15T00:00:00Z"));
    expect(day).toBe("99-06-15");
    expect(day).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(thisMonthInJapan(new Date("0099-06-15T00:00:00Z"))).toBe("99-06-1");
  });
});
