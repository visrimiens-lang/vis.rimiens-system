import { describe, expect, it, vi } from "vitest";

/**
 * intake.ts のコード正規化のテスト。
 *
 * intake.ts は保存先（./db）とメール（./mail）を読み込むが、
 * ここで確かめるのは文字の扱いだけなので、どちらも空の差し替えにする。
 */
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({
  audit: vi.fn(),
  count: vi.fn(),
  insert: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
  selectOne: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./mail", () => ({
  HQ_MAIL: "",
  PORTAL_URL: "",
  acquisitionMail: vi.fn(),
  approvalMail: vi.fn(),
  licenseTestMail: vi.fn(),
  sendMail: vi.fn(),
}));

import { ZEROTH_CODE, normalizeCode } from "./intake";

describe("normalizeCode", () => {
  it("全角・小文字・空白をそろえる", () => {
    expect(normalizeCode("ｍｅｎｏ")).toBe("MENO");
    expect(normalizeCode(" meno 0001 ")).toBe("MENO0001");
    expect(normalizeCode("")).toBe("");
  });

  /*
   * 2026-10-29 の改名。旧 QR（?ref=RIM）・ログインID・Cookie・招待コード欄から
   * 届く RIM は、全部 RIMI として扱う。ここが落ちると旧 QR の購入が付け先なしになる。
   */
  it("改名前の旧コード RIM は RIMI に読み替える（全角・小文字でも）", () => {
    expect(normalizeCode("RIM")).toBe("RIMI");
    expect(normalizeCode("rim")).toBe("RIMI");
    expect(normalizeCode("ＲＩＭ")).toBe("RIMI");
    expect(normalizeCode(" R I M ")).toBe("RIMI");
  });

  it("旧コードで始まる別のコードには触らない", () => {
    expect(normalizeCode("RIM0001")).toBe("RIM0001");
    expect(normalizeCode("rimi0001")).toBe("RIMI0001");
  });
});

describe("ZEROTH_CODE", () => {
  it("総販売代理店のコードは RIMI（2026-10-29 に RIM から改名）", () => {
    expect(ZEROTH_CODE).toBe("RIMI");
    // 旧コードを通しても同じ相手に行き着く
    expect(normalizeCode("RIM")).toBe(ZEROTH_CODE);
  });
});
