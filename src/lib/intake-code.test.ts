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
  // 本物と同じく in.(…) の形を返す（問い合わせ文字列を見て応答を変えるため）
  inList: (values: string[]) => `in.(${values.join(",")})`,
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

import { ZEROTH_CODE, normalizeCode, resolveAttribution, resolveParent } from "./intake";
import { select, selectOne } from "./db";
import type { Mock } from "vitest";
import { beforeEach } from "vitest";

const dbSelect = select as unknown as Mock;
const dbSelectOne = selectOne as unknown as Mock;

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

/*
 * 改名 SQL を流す「前」と「後」のどちらの DB でも、旧コード RIM で届いた受注・申込が
 * 正しい相手に付くこと。配備と SQL は同時にできないので、この両立が無いと
 * その間の受注が「付け先 RIMI（DB に無い）・ゼロ次なし・報酬なし」で残り、SQL でも直らない。
 */
describe("改名の前後どちらの DB でも旧コードで引ける", () => {
  const before = { code: "RIM", code_kind: "00", rank: "総販売代理店", parent_code: null, zeroth_code: "RIM" };
  const after = { code: "RIMI", code_kind: "00", rank: "総販売代理店", parent_code: null, zeroth_code: "RIMI" };

  /** DB にある行だけを返す select の差し替え。新旧両方の綴りを1回で問い合わせていることも確かめる。 */
  function dbHas(rows: Record<string, unknown>[]) {
    dbSelect.mockImplementation(async (path: string) => {
      expect(path).toContain("code=in.(RIMI,RIM)");
      return rows;
    });
    dbSelectOne.mockResolvedValue(null);
  }

  beforeEach(() => {
    dbSelect.mockReset();
    dbSelectOne.mockReset();
  });

  it("SQL 前（DB は RIM）: 受注の付け先は DB の綴り RIM、ゼロ次も RIM", async () => {
    dbHas([before]);
    const out = await resolveAttribution("RIM");
    expect(out.agencyCode).toBe("RIM");
    expect(out.zerothCode).toBe("RIM");
  });

  it("SQL 後（DB は RIMI）: 旧コード RIM で届いても付け先は RIMI", async () => {
    dbHas([after]);
    const out = await resolveAttribution("RIM");
    expect(out.agencyCode).toBe("RIMI");
    expect(out.zerothCode).toBe("RIMI");
  });

  it("新コード RIMI で届いたときも同じ", async () => {
    dbHas([before]);
    expect((await resolveAttribution("RIMI")).agencyCode).toBe("RIM");
    dbHas([after]);
    expect((await resolveAttribution("RIMI")).agencyCode).toBe("RIMI");
  });

  it("どちらも無ければ付け先は読み替え後の文字のまま（従来どおり）", async () => {
    dbHas([]);
    const out = await resolveAttribution("RIM");
    expect(out.agencyCode).toBe("RIMI");
    expect(out.zerothCode).toBe("");
  });

  it("招待コード RIM の上位解決も、DB の綴りの行を返す", async () => {
    dbHas([before]);
    expect((await resolveParent("RIM"))?.code).toBe("RIM");
    dbHas([after]);
    expect((await resolveParent("rim"))?.code).toBe("RIMI");
  });

  it("改名と無関係なコードは従来どおり1件引き（code=eq.）", async () => {
    dbSelectOne.mockResolvedValue({ code: "MENO", code_kind: "00", rank: "2次代理店", zeroth_code: "RIMI" });
    const out = await resolveAttribution("MENO");
    expect(dbSelectOne.mock.calls[0][0]).toContain("code=eq.MENO");
    expect(out.agencyCode).toBe("MENO");
    expect(out.nijiCode).toBe("MENO");
    expect(out.zerothCode).toBe("RIMI");
  });
});
