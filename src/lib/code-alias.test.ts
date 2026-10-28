import { describe, expect, it } from "vitest";
import { LEGACY_CODE_ALIASES, canonicalCode, isLegacyCode } from "./code-alias";

/**
 * code-alias.ts のテスト。
 *
 * 2026-10-29 の RIM → RIMI 改名で、旧コードが外の世界（QR・ログインID・Cookie・
 * 申込フォーム）から届き続ける。ここが壊れると、旧 QR からの購入の付け先が空になる。
 */
describe("canonicalCode", () => {
  it("旧コード RIM は RIMI に読み替える", () => {
    expect(canonicalCode("RIM")).toBe("RIMI");
  });

  it("大文字小文字は無視して突き合わせる", () => {
    expect(canonicalCode("rim")).toBe("RIMI");
    expect(canonicalCode("Rim")).toBe("RIMI");
  });

  it("新コード RIMI はそのまま", () => {
    expect(canonicalCode("RIMI")).toBe("RIMI");
  });

  it("旧コードで始まる別のコードには触らない（部分一致しない）", () => {
    expect(canonicalCode("RIM0001")).toBe("RIM0001");
    expect(canonicalCode("RIMI0001")).toBe("RIMI0001");
    expect(canonicalCode("RIMX")).toBe("RIMX");
  });

  it("表に無いコードと空文字はそのまま返す", () => {
    expect(canonicalCode("MENO")).toBe("MENO");
    expect(canonicalCode("meno")).toBe("meno");
    expect(canonicalCode("")).toBe("");
  });

  it("表は旧→新の向きで、両方とも大文字", () => {
    for (const [from, to] of Object.entries(LEGACY_CODE_ALIASES)) {
      expect(from).toBe(from.toUpperCase());
      expect(to).toBe(to.toUpperCase());
      expect(from).not.toBe(to);
      // 新コードがさらに別のコードへ読み替えられる（連鎖）ことは無い
      expect(LEGACY_CODE_ALIASES[to]).toBeUndefined();
    }
  });
});

describe("isLegacyCode", () => {
  it("旧コードだけ true", () => {
    expect(isLegacyCode("RIM")).toBe(true);
    expect(isLegacyCode("rim")).toBe(true);
    expect(isLegacyCode("RIMI")).toBe(false);
    expect(isLegacyCode("RIM0001")).toBe(false);
    expect(isLegacyCode("")).toBe(false);
  });
});
