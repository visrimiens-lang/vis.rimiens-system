import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

/**
 * agencies.ts のテスト。
 *
 * ★★ slotLimitsOf は現在どこからも呼ばれていない（デッドコード）★★
 *   2026-09-10 時点、src 配下の参照は
 *     ・src/actions/agency-actions.ts:5 の import 行（同ファイル内に呼び出しは無い）
 *     ・このテストファイル
 *   の2つだけで、本番の実行経路は存在しない。
 *   つまり slotLimitsOf のテストが守っている production 挙動はゼロなので、
 *   ここは最小限（「入っている値はそのまま返す」の1本）にとどめる。
 *   欠陥の記録は末尾の「既知の欠陥」ブロックに寄せてある。
 *
 *   厚みを置くのは、実際に画面から呼ばれている側:
 *     ・findAgencyByCode / listAllAgencies（＝行の読み替え toAgency）
 *     ・listDescendants（customers / rewards / leads / demo-machines）
 *     ・buildOrgTree・getSlotSummary・listDirectChildren（organization / dashboard）
 *
 * 保存先（./db）は丸ごと差し替える。agencies.ts が触る外部接点は
 * selectAll / selectOne / update の3本だけなので、差し替えれば
 * 「どんな問い合わせを投げたか」まで確かめられる。
 *
 * 時刻は UTC で動かす（vitest.config.ts の TZ=UTC。本番の Vercel と同じ）。
 * このファイルには日時の計算は無いため、TZ による期待値の差は生じない。
 *
 * ★ ファイル末尾に「既知の欠陥」ブロックがある。
 *   そこに書いてあるものは仕様ではなく、いま現在こう動いてしまうという記録。
 */

/*
 * agencies.ts は "server-only" を読み込むが、この依存はテスト環境には実体が無い。
 * （vitest.config.ts の alias でも解決されるが、意図を明示するために置いている）
 */
vi.mock("server-only", () => ({}));

vi.mock("./db", () => ({
  select: vi.fn(),
  selectAll: vi.fn(),
  selectOne: vi.fn(),
  update: vi.fn(),
  val: (v: string) => v,
}));

import { selectAll, selectOne, update } from "./db";
import {
  approveSlotIncrease,
  buildOrgTree,
  findAgencyByCode,
  getSlotSummary,
  listAllAgencies,
  listDescendants,
  listDirectChildren,
  listPendingSlotRequests,
  rejectSlotIncrease,
  requestSlotIncrease,
  slotLimitsOf,
} from "./agencies";
import { DEFAULT_STAFF_LIMIT } from "./slots";
import type { Agency } from "./types";

type Row = Record<string, unknown>;

const dbSelectAll = selectAll as unknown as Mock<(q: string) => Promise<Row[]>>;
const dbSelectOne = selectOne as unknown as Mock<(q: string) => Promise<Row | null>>;
const dbUpdate = update as unknown as Mock<(q: string, patch: Row) => Promise<Row[]>>;

beforeEach(() => {
  dbSelectAll.mockReset();
  dbSelectOne.mockReset();
  dbUpdate.mockReset();
  dbSelectAll.mockResolvedValue([]);
  dbSelectOne.mockResolvedValue(null);
  dbUpdate.mockResolvedValue([]);
});

/* ───────────────────────── テスト用の材料 ───────────────────────── */

/**
 * DB の1行。列が無いときは undefined で来るので、指定した列だけを置く。
 * （s_ / n_ が「無い列」をどう倒すかも合わせて見たいため、既定値は入れない）
 */
const dbRow = (over: Row): Row => ({ ...over });

/** 画面が使う形の代理店。枠の計算に関わる項目だけ差し替えて使う。 */
const BASE: Agency = {
  recordId: "rec-1",
  code: "MENO",
  name: "メノトレ商事",
  representative: "山田太郎",
  rank: "2次代理店",
  channel: "販売代理店",
  codeKind: "00",
  orgCode: "MENO",
  parentCode: "RIM",
  parentName: "リム",
  companyName: "",
  staffType: "",
  area: "関東",
  email: "meno@example.com",
  phone: "03-0000-0000",
  zip: "100-0001",
  address: "東京都千代田区1-1",
  invoiceNo: "T1234567890123",
  bankName: "みずほ銀行",
  bankBranch: "本店",
  accountType: "普通",
  accountNo: "1234567",
  accountHolder: "メノトレシヨウジ",
  status: "稼働中",
  staffLimit: DEFAULT_STAFF_LIMIT,
  slotLimits: {
    販売代理店枠上限: 10,
    サロン代理店枠上限: 30,
    個人代理店枠上限: 30,
    取次店枠上限: 30,
  },
  slotUsed: 0,
  slotRequestStatus: "",
  specialSlot: false,
  registeredVia: "フォーム",
  createdAt: "2026-08-01T00:00:00+09:00",
  qr1Url: "",
  qr2Status: "",
  qr2RejectedNote: "",
  trainingStatus: "",
  qr2Url: "",
  payUnit: null,
  payUnitOp1: null,
  payUnitOp2: null,
  payUnitPadYearly: null,
  payUnitNote: "",
};

const agency = (over: Partial<Agency> = {}): Agency => ({ ...BASE, ...over });

/* ═══════════════ 行の読み替え（toAgency）— 全画面が通る入口 ═══════════════ */

describe("DB の行を画面の形に直す（listAllAgencies / findAgencyByCode 経由）", () => {
  it("limit_staff の列が無い・null の行は既定の100名になり、0 はそのまま残る", async () => {
    // 0 は「上限なし」の意味で使われている（slots.ts の breakdownSlots が 0 を無制限に倒す）。
    // ここで 0 を既定値に戻すと、本部が外した上限が黙って復活する。
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A" }), // 列そのものが無い
      dbRow({ code: "B", limit_staff: null }),
      dbRow({ code: "C", limit_staff: 0 }),
      dbRow({ code: "D", limit_staff: 5 }),
    ]);

    const got = await listAllAgencies();

    expect(got.map((a) => a.staffLimit)).toEqual([100, 100, 0, 5]);
    expect(DEFAULT_STAFF_LIMIT).toBe(100); // 上の 100 が既定値であることの裏づけ
  });

  it("エリアは area_class を優先し、空・列なしのときだけ area を使う", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A", area_class: "関東", area: "中部" }),
      dbRow({ code: "B", area: "中部" }),
      dbRow({ code: "C", area_class: "", area: "九州+沖縄" }),
      dbRow({ code: "D" }),
    ]);

    const got = await listAllAgencies();

    expect(got.map((a) => a.area)).toEqual(["関東", "中部", "九州+沖縄", ""]);
  });

  it("特別枠は special_slot が真の true のときだけ立つ（文字列の \"true\" や 1 では立たない）", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A", special_slot: true }),
      dbRow({ code: "B", special_slot: "true" }),
      dbRow({ code: "C", special_slot: 1 }),
      dbRow({ code: "D", special_slot: false }),
      dbRow({ code: "E" }),
    ]);

    const got = await listAllAgencies();

    expect(got.map((a) => a.specialSlot)).toEqual([true, false, false, false, false]);
  });

  it("pay_unit は列が無ければ null（既定単価を使う）、わざと 0 にした行は 0 のまま", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A" }),
      dbRow({ code: "B", pay_unit: null }),
      dbRow({ code: "C", pay_unit: 0 }),
      dbRow({ code: "D", pay_unit: 12000 }),
    ]);

    const got = await listAllAgencies();

    expect(got.map((a) => a.payUnit)).toEqual([null, null, 0, 12000]);
  });

  it("本体以外の単価は空文字・数値でない値を null に倒し、0 は「払わない額 0」として残す", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A", pay_unit_op1: "" }),
      dbRow({ code: "B", pay_unit_op1: "abc" }),
      dbRow({ code: "C", pay_unit_op1: 0 }),
      dbRow({ code: "D", pay_unit_op1: "3300" }),
      dbRow({ code: "E" }),
    ]);

    const got = await listAllAgencies();

    expect(got.map((a) => a.payUnitOp1)).toEqual([null, null, 0, 3300, null]);
  });

  it("文字も数字も、無い列は空文字に倒れる（画面に undefined を出さない）", async () => {
    dbSelectOne.mockResolvedValue(dbRow({ code: "MENO" }));

    const got = await findAgencyByCode("MENO");

    expect(got?.name).toBe("");
    expect(got?.status).toBe("");
    expect(got?.slotLimits).toEqual({
      販売代理店枠上限: 0,
      サロン代理店枠上限: 0,
      個人代理店枠上限: 0,
      取次店枠上限: 0,
    });
  });

  it("全件取得は 1000件で切られない取り方（selectAll）で、並び順を必ず指定する", async () => {
    // 途中で切られると枠の残数を数え違えるが、画面には何も出ないため気づけない。
    await listAllAgencies();

    expect(dbSelectAll).toHaveBeenCalledTimes(1);
    expect(dbSelectAll).toHaveBeenCalledWith("agencies?select=*&order=code.asc");
  });
});

describe("findAgencyByCode（代理店コードで1件引く）", () => {
  it("空文字・空白だけのコードでは DB を呼ばずに null を返す", async () => {
    expect(await findAgencyByCode("")).toBeNull();
    expect(await findAgencyByCode("   ")).toBeNull();
    expect(dbSelectOne).not.toHaveBeenCalled();
  });

  it("前後の空白は落としてから問い合わせる", async () => {
    await findAgencyByCode("  MENO  ");

    expect(dbSelectOne).toHaveBeenCalledWith("agencies?select=*&code=eq.MENO");
  });

  it("コードは URL エンコードして渡す（& などで問い合わせが壊れない）", async () => {
    await findAgencyByCode("A&B");

    expect(dbSelectOne).toHaveBeenCalledWith("agencies?select=*&code=eq.A%26B");
  });

  it("該当する行が無ければ null を返す", async () => {
    dbSelectOne.mockResolvedValue(null);

    expect(await findAgencyByCode("NOPE")).toBeNull();
  });
});

/* ═══════════════════════ 配下をたどる ═══════════════════════ */

describe("listDescendants（配下を階層ごとたどって集める）", () => {
  it("孫・ひ孫まで集め、自分自身と無関係な枝は含まない", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "RIM" }),
      dbRow({ code: "MENO", parent_code: "RIM" }),
      dbRow({ code: "MENO0001", parent_code: "MENO" }),
      dbRow({ code: "MENO0002", parent_code: "MENO0001" }),
      dbRow({ code: "OTHER", parent_code: "XXX" }),
      dbRow({ code: "TOP" }), // parent_code の列が無い＝どこにも属さない
    ]);

    const got = await listDescendants("RIM");

    expect(got.map((a) => a.code)).toEqual(["MENO", "MENO0001", "MENO0002"]);
  });

  it("配下がいなければ空を返す（存在しないコードでも同じ）", async () => {
    dbSelectAll.mockResolvedValue([dbRow({ code: "RIM" }), dbRow({ code: "MENO", parent_code: "RIM" })]);

    expect(await listDescendants("NOPE")).toEqual([]);
  });

  it("循環参照（A→B→A）があっても止まり、起点は結果に入らない", async () => {
    // 「循環参照があっても無限ループしない」は関数の docstring が約束している性質。
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A", parent_code: "B" }),
      dbRow({ code: "B", parent_code: "A" }),
    ]);

    const got = await listDescendants("A");

    expect(got.map((a) => a.code)).toEqual(["B"]);
  });

  it("自分が自分の親になっている行があっても、二度数えない", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A" }),
      dbRow({ code: "B", parent_code: "A" }),
      dbRow({ code: "B2", parent_code: "B2" }), // 自己ループ
      dbRow({ code: "C", parent_code: "B" }),
    ]);

    const got = await listDescendants("A");

    expect(got.map((a) => a.code)).toEqual(["B", "C"]);
  });

  it("枝分かれした木は幅優先で並ぶ（子の代を出しきってから孫の代に降りる）", async () => {
    /*
     * 直下（B・C）→ その子（B1・C1）の順。深さ優先にすると
     * ["B","C","C1","B1"] のように後ろの枝から先に出る。
     * 現在の呼び出し側（customers / rewards / leads / demo-machines）は
     * コードを Set/Map に畳んでから並べ直すため表示は変わらないが、
     * 「返す順は決まっている」ことをここで固定しておく。
     */
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A" }),
      dbRow({ code: "B", parent_code: "A" }),
      dbRow({ code: "C", parent_code: "A" }),
      dbRow({ code: "B1", parent_code: "B" }),
      dbRow({ code: "C1", parent_code: "C" }),
    ]);

    const got = await listDescendants("A");

    expect(got.map((a) => a.code)).toEqual(["B", "C", "B1", "C1"]);
  });
});

describe("buildOrgTree（配下を組織図の形で返す）", () => {
  it("起点の代理店が見つからなければ null", async () => {
    dbSelectAll.mockResolvedValue([dbRow({ code: "RIM" })]);

    expect(await buildOrgTree("NOPE")).toBeNull();
  });

  it("子はコード順に並ぶ（DB の並びや登録順ではない）", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "RIM" }),
      dbRow({ code: "ZZZZ", parent_code: "RIM" }),
      dbRow({ code: "AAAA", parent_code: "RIM" }),
      dbRow({ code: "MMMM", parent_code: "RIM" }),
    ]);

    const tree = await buildOrgTree("RIM");

    expect(tree?.children.map((c) => c.agency.code)).toEqual(["AAAA", "MMMM", "ZZZZ"]);
  });

  it("孫は子の下にぶら下がる", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "RIM" }),
      dbRow({ code: "MENO", parent_code: "RIM" }),
      dbRow({ code: "MENO0001", parent_code: "MENO" }),
    ]);

    const tree = await buildOrgTree("RIM");

    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0].children.map((c) => c.agency.code)).toEqual(["MENO0001"]);
  });

  it("自分を親に指している行は自分の子にしない（無限に潜らない）", async () => {
    dbSelectAll.mockResolvedValue([dbRow({ code: "RIM", parent_code: "RIM" })]);

    const tree = await buildOrgTree("RIM");

    expect(tree?.children).toEqual([]);
  });

  it("循環参照があっても、同じ枝を二度たどらない", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "A", parent_code: "B" }),
      dbRow({ code: "B", parent_code: "A" }),
    ]);

    const tree = await buildOrgTree("A");

    expect(tree?.agency.code).toBe("A");
    expect(tree?.children.map((c) => c.agency.code)).toEqual(["B"]);
    expect(tree?.children[0].children).toEqual([]);
  });
});

describe("listDirectChildren（直下1階層だけ）", () => {
  it("孫は含めず、自分が自分の親になっている行も返さない", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "MENO", parent_code: "MENO" }), // 自己ループ
      dbRow({ code: "MENO0001", parent_code: "MENO" }),
      dbRow({ code: "MENO0002", parent_code: "MENO0001" }), // 孫
    ]);

    const got = await listDirectChildren("MENO");

    expect(got.map((a) => a.code)).toEqual(["MENO0001"]);
  });
});

/* ═══════════════════════ 枠の使用状況 ═══════════════════════ */

describe("getSlotSummary（直下のスタッフ枠の使用状況）", () => {
  const children = (...rows: Row[]) => dbSelectAll.mockResolvedValue(rows);

  it("直下の稼働中だけを数え、残りは 上限 − 使用数", async () => {
    children(
      dbRow({ code: "MENO0001", parent_code: "MENO", status: "稼働中" }),
      dbRow({ code: "MENO0002", parent_code: "MENO", status: "稼働中" }),
      dbRow({ code: "MENO0003", parent_code: "MENO", status: "停止・解約" }),
      dbRow({ code: "OTHER0001", parent_code: "OTHER", status: "稼働中" }), // 別の親
      dbRow({ code: "MENO000A", parent_code: "MENO0001", status: "稼働中" }), // 孫
    );

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 5 }));

    expect(got.limit).toBe(5);
    expect(got.used).toBe(2);
    expect(got.remaining).toBe(3);
    expect(got.isOver).toBe(false);
    expect(got.members.map((a) => a.code)).toEqual(["MENO0001", "MENO0002"]);
  });

  it("使用数が上限に届いた時点でいっぱい（超過ではなく同数から止まる）", async () => {
    children(
      dbRow({ code: "S1", parent_code: "MENO", status: "稼働中" }),
      dbRow({ code: "S2", parent_code: "MENO", status: "稼働中" }),
    );

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 2 }));

    expect(got.used).toBe(2);
    expect(got.remaining).toBe(0);
    expect(got.isOver).toBe(true);
  });

  it("上限0 は「上限なし」— 残りは無限で、何人いてもいっぱいにならない", async () => {
    // 画面（admin/agencies/[code]）も 0 を「上限なし」と表示しており、そこと揃っている。
    children(
      dbRow({ code: "S1", parent_code: "MENO", status: "稼働中" }),
      dbRow({ code: "S2", parent_code: "MENO", status: "稼働中" }),
    );

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 0 }));

    expect(got.limit).toBe(0);
    expect(got.used).toBe(2);
    expect(got.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(got.isOver).toBe(false);
  });

  it("特別枠が立っていれば、上限が入っていても「上限なし」になる", async () => {
    children(dbRow({ code: "S1", parent_code: "MENO", status: "稼働中" }));

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 1, specialSlot: true }));

    expect(got.limit).toBe(0);
    expect(got.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(got.isOver).toBe(false);
  });

  it("others に入るのは停止・解約の直下だけ（稼働中は区分にかかわらず members 側）", async () => {
    /*
     * 型コメント（agencies.ts:196）は others を「枠を消費しない直下（取次・スタッフ）」と
     * 書いているが、2026-08-22 に「区分にかかわらず1人ぶん枠を使う」へ変わったため、
     * 枠を消費しないのは停止・解約の行だけ。実装（211行）は正しく、コメントが古い。
     */
    children(
      dbRow({ code: "T1", parent_code: "MENO", code_kind: "01", status: "稼働中" }), // 取次
      dbRow({ code: "S1", parent_code: "MENO", code_kind: "02", status: "稼働中" }), // スタッフ
      dbRow({ code: "X1", parent_code: "MENO", code_kind: "02", status: "停止・解約" }),
    );

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 100 }));

    expect(got.used).toBe(2);
    expect(got.members.map((a) => a.code)).toEqual(["T1", "S1"]);
    expect(got.others.map((a) => a.code)).toEqual(["X1"]);
  });

  it("新規登録直後の「未稼働」も枠を使う側に数える（others に入るのは停止・解約だけ）", async () => {
    /*
     * schema.sql:36-37 の status は ('未稼働','稼働中','停止・解約') の3値で、
     * 列の既定値は 未稼働。つまり登録した直後の代理店はこの状態で入ってくる。
     * 枠を消費しないのは slots.ts の isActive が外す 停止・解約 だけなので、
     * 未稼働 は members 側（＝枠を1つ使う）に入り、others には出ない。
     * ここを「稼働中でないもの」に広げると、未稼働の1件が members と others の
     * 両方に並び、画面上で二重に見えるうえ、使用数と一覧の件数が食い違う。
     */
    children(
      dbRow({ code: "N1", parent_code: "MENO", status: "未稼働" }),
      dbRow({ code: "A1", parent_code: "MENO", status: "稼働中" }),
      dbRow({ code: "X1", parent_code: "MENO", status: "停止・解約" }),
      dbRow({ code: "E1", parent_code: "MENO" }), // status の列そのものが無い行
    );

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 10 }));

    expect(got.used).toBe(3);
    expect(got.members.map((a) => a.code)).toEqual(["N1", "A1", "E1"]);
    expect(got.others.map((a) => a.code)).toEqual(["X1"]);
    expect(got.remaining).toBe(7);
  });

  it("増枠の申請状態は代理店の値をそのまま渡す", async () => {
    children();

    const got = await getSlotSummary(agency({ code: "MENO", slotRequestStatus: "申請中" }));

    expect(got.requestStatus).toBe("申請中");
  });
});

/* ═════════════ 増枠の申請・承認・却下・一覧（書き込み経路） ═════════════ */

describe("増枠の申請・承認・却下（画面から実際に呼ばれる書き込み）", () => {
  it("申請は slot_request を「申請中」にするだけ（枠の上限は動かさない）", async () => {
    // src/actions/slot-actions.ts:47 から呼ばれる。ここが別の値を書くと、
    // 本部の承認待ち一覧（slot_request=eq.申請中）に載らず、申請が消える。
    await requestSlotIncrease("rec-1");

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate).toHaveBeenCalledWith("agencies?id=eq.rec-1", { slot_request: "申請中" });
  });

  it("申請の対象は id が一致する1行だけで、id は URL エンコードして渡す", async () => {
    await requestSlotIncrease("a&b c");

    expect(dbUpdate).toHaveBeenCalledWith("agencies?id=eq.a%26b%20c", { slot_request: "申請中" });
  });

  it("承認は limit_staff を新しい上限にし、同時に「承認済」にする（旧4列は触らない）", async () => {
    /*
     * src/actions/admin-slot-actions.ts:109 から呼ばれる。
     * 2026-08-22 に枠はスタッフ1本になったので、増えるのは limit_staff だけ。
     * 旧4列（limit_hanbai ほか）を書くと、画面が読む上限（agencies.ts:60-63）が
     * 増えないまま「承認済」だけが立ち、承認が空振りする。
     */
    await approveSlotIncrease("rec-1", 150);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate).toHaveBeenCalledWith("agencies?id=eq.rec-1", {
      limit_staff: 150,
      slot_request: "承認済",
    });
  });

  it("承認は渡された数値をそのまま書く（0 も上書きする値として通る）", async () => {
    await approveSlotIncrease("rec-9", 0);

    expect(dbUpdate).toHaveBeenCalledWith("agencies?id=eq.rec-9", {
      limit_staff: 0,
      slot_request: "承認済",
    });
  });

  it("却下は上限を変えず、slot_request を「却下」にするだけ", async () => {
    await rejectSlotIncrease("rec-1");

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate).toHaveBeenCalledWith("agencies?id=eq.rec-1", { slot_request: "却下" });
  });
});

describe("listPendingSlotRequests（本部の承認待ち一覧）", () => {
  it("「申請中」の行だけを、申請の古い順で取る", async () => {
    /*
     * src/app/(app)/admin/requests/page.tsx:188 の中身そのもの。
     * 絞り込みが別の状態に変わると、承認済み・却下済みが承認待ちとして並び、
     * 本部が同じ申請を二度承認できてしまう。
     * %E7%94%B3%E8%AB%8B%E4%B8%AD は encodeURIComponent("申請中")。
     */
    await listPendingSlotRequests();

    expect(dbSelectAll).toHaveBeenCalledTimes(1);
    expect(dbSelectAll).toHaveBeenCalledWith(
      "agencies?select=*&slot_request=eq.%E7%94%B3%E8%AB%8B%E4%B8%AD&order=updated_at.asc",
    );
    expect(encodeURIComponent("申請中")).toBe("%E7%94%B3%E8%AB%8B%E4%B8%AD"); // 上の裏づけ
  });

  it("取れた行は画面の形（Agency）に直して返す", async () => {
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "MENO", slot_request: "申請中", limit_staff: 3 }),
    ]);

    const got = await listPendingSlotRequests();

    expect(got.map((a) => [a.code, a.slotRequestStatus, a.staffLimit])).toEqual([
      ["MENO", "申請中", 3],
    ]);
  });
});

/* ═════════════ 旧・販路種別ごとの枠上限（デッドコード） ═════════════ */

describe("slotLimitsOf（旧4本立ての枠上限／現在どこからも呼ばれていない）", () => {
  it("入っている値はそのまま返す（1 でも既定値には戻らない）", () => {
    const got = slotLimitsOf(
      agency({
        slotLimits: {
          販売代理店枠上限: 1,
          サロン代理店枠上限: 12,
          個人代理店枠上限: 7,
          取次店枠上限: 25,
        },
      }),
    );

    expect(got).toEqual({
      販売代理店枠上限: 1,
      サロン代理店枠上限: 12,
      個人代理店枠上限: 7,
      取次店枠上限: 25,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 既知の欠陥（仕様ではない）
// ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
// 通っていることは正しさを意味しない。
// ─────────────────────────────────────────────────────────────
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】0（＝上限なし）が既定値 10/30/30/30 に置き換わり、外した上限が復活する", () => {
    /*
     * 本来は 0 をそのまま返し、呼び出し側が「上限なし」として扱うべき。
     * 根拠:
     *   ・supabase/schema.sql:49-52 で4列は integer not null default 10/30/30/30。
     *     つまり 0 は「未設定」ではあり得ず、必ず本部が意図して入れた値。
     *   ・supabase/migrations/2026-08-24_staff_slot.sql:22-29 は
     *     「どれか1つでも 0（＝上限なしの意味で使われている）なら合計も 0」と扱っている。
     *   ・src/app/(app)/admin/agencies/[code]/page.tsx:204-206 の limitText() は
     *     同じ4列の 0 を画面に「上限なし」と描画している。
     * この関数だけが 0 を「未入力」と読み替えており、本部の操作記録を書き換えてしまう。
     * （現在は呼び出し 0 件のため実害は出ていない）
     */
    expect(
      slotLimitsOf(
        agency({
          slotLimits: {
            販売代理店枠上限: 0,
            サロン代理店枠上限: 0,
            個人代理店枠上限: 0,
            取次店枠上限: 0,
          },
        }),
      ),
    ).toEqual({
      販売代理店枠上限: 10,
      サロン代理店枠上限: 30,
      個人代理店枠上限: 30,
      取次店枠上限: 30,
    });

    // 0 の種別だけが化け、値が入っている種別はそのまま残る。
    expect(
      slotLimitsOf(
        agency({
          slotLimits: {
            販売代理店枠上限: 0,
            サロン代理店枠上限: 5,
            個人代理店枠上限: 0,
            取次店枠上限: 1,
          },
        }),
      ),
    ).toEqual({
      販売代理店枠上限: 10,
      サロン代理店枠上限: 5,
      個人代理店枠上限: 30,
      取次店枠上限: 1,
    });
  });

  it("【欠陥】負の数はそのまま枠上限として返る（上限として使えない値が素通りする）", () => {
    /*
     * 本来は不正値として弾く（または既定値に倒す）べき。
     * `||` は負数を truthy と見なすため、入っていればそのまま枠上限として返る。
     * supabase/schema.sql:49-52 の4列に CHECK 制約が無いので、DB 側でも止まらない。
     * ただし「管理画面から負の値を入れられる」わけではない。この4列を書く画面は現在無く、
     *   ・src/actions/agency-actions.ts:337「いまは書き換えないが、過去の操作記録を読むために残す」
     *     （下の LABELS は変更履歴の項目名に使うだけで、更新の対象ではない）
     *   ・src/app/(app)/admin/agencies/[code]/page.tsx:359 も読むだけ
     * 入りうるのは移行 SQL や DB への直接更新の経路。
     */
    expect(
      slotLimitsOf(
        agency({
          slotLimits: {
            販売代理店枠上限: -1,
            サロン代理店枠上限: -30,
            個人代理店枠上限: -5,
            取次店枠上限: -100,
          },
        }),
      ),
    ).toEqual({
      販売代理店枠上限: -1,
      サロン代理店枠上限: -30,
      個人代理店枠上限: -5,
      取次店枠上限: -100,
    });
  });

  it("【欠陥】自分を親に指した行が、getSlotSummary では自分の直下として枠を1つ食う", async () => {
    /*
     * 同じ「直下」なのに、同一ファイル内で定義が2つある。
     *   ・listDirectChildren（agencies.ts:254）… a.code !== code で自己ループを外す
     *   ・getSlotSummary  （agencies.ts:202）… 親コードが一致するかだけ見る（外さない）
     * buildOrgTree（160行）も自己ループを外す側なので、外さないのは getSlotSummary だけ。
     * その結果、parent_code に自分のコードが入った行があると、その代理店自身が
     * 自分の配下として数えられ、枠の残りが実際より1つ少なく見える。
     * 本来は listDirectChildren と同じく除外すべき（＝ここは仕様ではない）。
     */
    dbSelectAll.mockResolvedValue([
      dbRow({ code: "MENO", parent_code: "MENO", status: "稼働中" }), // 自己ループ
      dbRow({ code: "MENO0001", parent_code: "MENO", status: "稼働中" }),
    ]);

    const got = await getSlotSummary(agency({ code: "MENO", staffLimit: 10 }));

    expect(got.used).toBe(2); // 本来は 1
    expect(got.members.map((a) => a.code)).toEqual(["MENO", "MENO0001"]);
    expect(got.remaining).toBe(8); // 本来は 9

    // 同じ行を渡しても、こちらは自分を外す（＝2つの「直下」が食い違っている）
    expect((await listDirectChildren("MENO")).map((a) => a.code)).toEqual(["MENO0001"]);
  });
});
