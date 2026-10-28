import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

/**
 * 報酬（rewards.ts）のテスト。
 *
 * この台帳で事故になるのは「二重に計上する」「二重にマイナスを立てる」の2つだけで、
 * どちらもそのまま支払額の誤りになる。そのため
 *   ・判断のもとになる rewardStanding（純関数）
 *   ・実際に金を動かす accrueRewards / confirmRewards / reverseRewardsDetailed /
 *     onReviewResultChanged / monthlyRewards
 * の両方を見る。
 *
 * 保存先（./db）は丸ごと差し替えてある。外部接点は
 * select / selectAll / selectOne / insert / update / audit の6本だけなので、
 * 差し替えれば「何を書き込んだか」「どの順番で書き込んだか」まで確かめられる。
 * 取消は書き込みの順番そのものが安全装置なので（マイナス → 支払済に印 → 未払に印）、
 * 順番も固定する。
 *
 * 時刻は UTC で動かす（vitest.config.ts の TZ=UTC。本番の Vercel と同じ）。
 * 「日本時間の今日」を使う場所は、UTC の日付とわざとずれる時刻
 * （2026-08-31 15:30 UTC ＝ 2026-09-01 00:30 JST）に固定して確かめている。
 *
 * ★ ファイル末尾に「既知の欠陥」ブロックがある。
 *   そこに書いてあるものは仕様ではなく、いま現在こう動いてしまうという記録。
 */

/*
 * rewards.ts は "server-only" を読み込むが、この依存はテスト環境には実体が無い。
 * 中身が空の印なので、読み込めるようにするためだけの差し替え。
 */
vi.mock("server-only", () => ({}));

vi.mock("./db", () => ({
  select: vi.fn(),
  selectAll: vi.fn(),
  selectOne: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  // 問い合わせ文字列の組み立てだけなので、本物と同じ形を返す。
  inList: (values: string[]) => `in.(${values.map((v) => `"${v}"`).join(",")})`,
}));

import { audit, insert, select, selectAll, selectOne, update } from "./db";
import {
  accrueRewards,
  confirmRewards,
  monthlyRewards,
  onReviewResultChanged,
  reverseRewards,
  reverseRewardsDetailed,
  rewardStanding,
} from "./rewards";

type Row = Record<string, unknown>;

const dbSelect = select as unknown as Mock<(q: string) => Promise<Row[]>>;
const dbSelectAll = selectAll as unknown as Mock<(q: string) => Promise<Row[]>>;
const dbSelectOne = selectOne as unknown as Mock<(q: string) => Promise<Row | null>>;
const dbInsert = insert as unknown as Mock<(table: string, rows: Row[]) => Promise<Row[]>>;
const dbUpdate = update as unknown as Mock<(q: string, patch: Row) => Promise<Row[]>>;
const dbAudit = audit as unknown as Mock<
  (actor: string, action: string, target: Row, detail: Row) => Promise<void>
>;

/* ═══════════════════ rewardStanding に渡す行（純関数のテスト用） ═══════════════════ */

/** 未払のまま計上されている報酬の行。 */
const pending = (amount: number): Row => ({
  amount,
  status: "未確定",
  cancel_reason: null,
});

/** 振込が済んでいる報酬の行。 */
const paid = (amount: number): Row => ({
  amount,
  status: "支払済",
  cancel_reason: null,
});

/** 未払のまま打ち切った行（status を「取消」にするだけ。マイナスは立てない）。 */
const cancelled = (amount: number): Row => ({
  amount,
  status: "取消",
  cancel_reason: "審査の否決",
});

/** 支払済のまま相殺した元の行（status は「支払済」のまま、理由だけ入る）。 */
const paidThenOffset = (amount: number): Row => ({
  amount,
  status: "支払済",
  cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）",
});

/** 相殺のために立てたマイナスの行（赤伝票）。 */
const negative = (amount: number): Row => ({
  amount: -Math.abs(amount),
  status: "確定",
  cancel_reason: "審査の否決",
});

describe("rewardStanding", () => {
  describe("報酬が1件も無いとき", () => {
    it("空の配列を渡すと、すべて 0 件・途中で止まっている疑いも無しになる", () => {
      expect(rewardStanding([])).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });
  });

  describe("計上したまま、まだ何も起きていないとき", () => {
    it("未確定の報酬2件は、生きている報酬2件として数える（支払済は0件）", () => {
      expect(rewardStanding([pending(77000), pending(63800)])).toEqual({
        live: 2,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("確定・支払済がまじっていても、打ち切りの印が無ければ全部が生きている報酬になる", () => {
      const rows: Row[] = [
        paid(77000),
        { amount: 63800, status: "確定", cancel_reason: null },
        pending(25000),
      ];
      expect(rewardStanding(rows)).toEqual({
        live: 3,
        livePaid: 1,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });
  });

  describe("打ち切りの印の読み方（status と cancel_reason の2通り）", () => {
    it("status が「取消」なら、cancel_reason が空でも打ち切り済みとして数える", () => {
      const rows: Row[] = [{ amount: 77000, status: "取消", cancel_reason: "" }];
      expect(rewardStanding(rows)).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 0,
        reversed: 1,
        halfDone: false,
      });
    });

    it("status が「支払済」のままでも、cancel_reason が入っていれば打ち切り済みとして数える", () => {
      expect(rewardStanding([paidThenOffset(77000)])).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 0,
        reversed: 1,
        halfDone: false,
      });
    });

    it("cancel_reason が null の行は、打ち切られていない扱いになる", () => {
      expect(rewardStanding([{ amount: 77000, status: "確定", cancel_reason: null }])).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("cancel_reason が空文字の行も、打ち切られていない扱いになる", () => {
      expect(rewardStanding([{ amount: 77000, status: "確定", cancel_reason: "" }])).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("cancel_reason 列そのものが無い（読み落とした）行も、打ち切られていない扱いになる", () => {
      expect(rewardStanding([{ amount: 77000, status: "確定" }])).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("livePaid は「生きている報酬のうちの支払済」だけを数え、相殺済みの支払済は数えない", () => {
      const rows: Row[] = [paidThenOffset(77000), paid(63800)];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 1,
        offsets: 0,
        reversed: 1,
        halfDone: false,
      });
    });
  });

  describe("取消が最後まで済んだあと", () => {
    it("未払のまま打ち切った受注は、マイナスが立たないので offsets 0・reversed 1 になる", () => {
      expect(rewardStanding([cancelled(77000), cancelled(63800)])).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 0,
        reversed: 2,
        halfDone: false,
      });
    });

    it("支払済を相殺した受注は、元の行1件とマイナス1件がつり合って halfDone にならない（境界: 1 対 1）", () => {
      const rows: Row[] = [paidThenOffset(77000), negative(77000)];
      expect(rewardStanding(rows)).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 1,
        reversed: 1,
        halfDone: false,
      });
    });

    it("否決→承認→否決と2周した受注でも、前の周回のぶんは疑いにしない", () => {
      // 1周目: 支払済を相殺（元の行 + マイナス）／2周目: 未払のまま取消
      const rows: Row[] = [paidThenOffset(77000), negative(77000), cancelled(77000)];
      expect(rewardStanding(rows)).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 1,
        reversed: 2,
        halfDone: false,
      });
    });

    it("生きている報酬・相殺済み・未払取消が混ざっていても、それぞれ数え分ける", () => {
      const rows: Row[] = [paidThenOffset(77000), negative(77000), pending(63800), cancelled(25000)];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 1,
        reversed: 2,
        halfDone: false,
      });
    });
  });

  describe("取消が途中で止まっている疑い（halfDone）", () => {
    it("マイナスだけ立って元の行に印が付いていないと halfDone になる", () => {
      const rows: Row[] = [paid(77000), negative(77000)];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 1,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });

    it("マイナスが打ち切った行より1件多いと halfDone になる（境界: 2 対 1）", () => {
      const rows: Row[] = [paidThenOffset(77000), negative(77000), negative(63800)];
      const standing = rewardStanding(rows);
      expect(standing.offsets).toBe(2);
      expect(standing.reversed).toBe(1);
      expect(standing.halfDone).toBe(true);
    });

    it("マイナスが打ち切った行より少ないぶんには halfDone にしない（境界: 1 対 2）", () => {
      const rows: Row[] = [paidThenOffset(77000), paidThenOffset(63800), negative(77000)];
      const standing = rewardStanding(rows);
      expect(standing.offsets).toBe(1);
      expect(standing.reversed).toBe(2);
      expect(standing.halfDone).toBe(false);
    });

    it("マイナスの行しか無いときも halfDone になる（0 件の打ち切りに対してマイナス1件）", () => {
      expect(rewardStanding([negative(77000)])).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });
  });

  describe("マイナスの数え方（打ち切りの印は見ない）", () => {
    /*
     * offsets は「金額がマイナスの行の数」だけで決まる。
     * マイナスの行に取消の印が付いているかどうかは見ない
     * （赤伝票は打ち切られる側ではなく、打ち切りの結果そのものなので）。
     * ここを isReversed で絞ってしまうと、印の無いマイナスが数から漏れて
     * 「取消が途中で止まっている」を見逃す。
     */
    it("cancel_reason の入っていないマイナスも相殺として数える", () => {
      const rows: Row[] = [paid(77000), { amount: -77000, status: "確定", cancel_reason: null }];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 1,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });

    it("status が「取消」のマイナスも相殺として数える（打ち切った行には数えない）", () => {
      const rows: Row[] = [paid(77000), { amount: -77000, status: "取消", cancel_reason: "審査の否決" }];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 1,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });
  });

  describe("金額の符号と境界値", () => {
    it("0 円の行は、生きている報酬にもマイナスにも打ち切りにも数えられない", () => {
      const rows: Row[] = [{ amount: 0, status: "未確定", cancel_reason: null }];
      expect(rewardStanding(rows)).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("0 円で status が「取消」の行も、reversed に数えられない", () => {
      const rows: Row[] = [{ amount: 0, status: "取消", cancel_reason: "審査の否決" }, pending(77000)];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 0,
        reversed: 0,
        halfDone: false,
      });
    });

    it("1 円でもプラスなら生きている報酬、-1 円でもマイナスなら相殺として数える", () => {
      const rows: Row[] = [
        { amount: 1, status: "未確定", cancel_reason: null },
        { amount: -1, status: "確定", cancel_reason: "審査の否決" },
      ];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 0,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });

    it("マイナスは件数だけを見るので、金額がつり合っていなくても1件と数える", () => {
      // -1 円のマイナスでも、77,000 円の相殺が済んだものとして扱われる
      const rows: Row[] = [paidThenOffset(77000), { amount: -1, status: "確定", cancel_reason: "審査の否決" }];
      expect(rewardStanding(rows)).toEqual({
        live: 0,
        livePaid: 0,
        offsets: 1,
        reversed: 1,
        halfDone: false,
      });
    });
  });

  describe("金額が数値以外で返ってきたとき", () => {
    it("文字列の金額（PostgREST の numeric）は数として読む", () => {
      const rows: Row[] = [
        { amount: "77000", status: "支払済", cancel_reason: null },
        { amount: "-77000", status: "確定", cancel_reason: "審査の否決" },
      ];
      expect(rewardStanding(rows)).toEqual({
        live: 1,
        livePaid: 1,
        offsets: 1,
        reversed: 0,
        halfDone: true,
      });
    });
  });
});

/* ══════════════════════════ ここから保存先を差し替えるテスト ══════════════════════════ */

/** 商品マスタの行（PRODUCT_COLUMNS で取る形）。 */
const BODY = "VIS本体　先行予約 ／ 事務手数料";
const OP1 = "ジェルパッド1年分 先行購入（OP①・13,200円）";
const BODY_OP1 = `${BODY} ／ ${OP1}`;

const PRODUCTS: Row[] = [
  {
    name: BODY,
    price_incl_tax: 188300,
    reward_target: "対象",
    amount_so: 77000,
    amount_niji: 62700,
    amount_hanbai: 55000,
    amount_toritsugi: 27500,
    active: true,
  },
  {
    name: OP1,
    price_incl_tax: 13200,
    reward_target: "対象",
    amount_so: 3300,
    amount_niji: 1100,
    amount_hanbai: 1100,
    amount_toritsugi: 0,
    active: true,
  },
];

/** 受注1件。 */
const order = (over: Row = {}): Row => ({
  id: 501,
  product_name: BODY,
  amount: 188300,
  quantity: 1,
  ordered_on: "2026-08-30",
  agency_code: "MET",
  niji_code: "",
  zeroth_code: "",
  referrer_code: "",
  ship_status: "出荷準備",
  ...over,
});

/** 代理店1社（agencies?select=code,rank,channel で返る形）。 */
const agency = (code: string, rank: string, channel = "未設定"): Row => ({ code, rank, channel });

/** rewards の行。取消は行番号で名指しするので、DB 経由のテストでは id が要る。 */
const reward = (over: Row = {}): Row => ({
  id: 1,
  order_id: 501,
  agency_code: "MET",
  agency_rank: "2次代理店",
  month: "2026-08",
  amount: 62700,
  kind: "販売報酬",
  status: "未確定",
  cancel_reason: null,
  ...over,
});

/** 差し替えた保存先が持っている中身。 */
type Fake = {
  order: Row | null;
  /** 受注が読めない（confirmRewards の「読めなくても確定は進める」を通す）。 */
  orderUnreadable: boolean;
  rewards: Row[];
  products: Row[];
  agencies: Row[];
  /** null なら agencies に pay_unit 系の列がまだ無い（問い合わせが失敗する）。 */
  payUnits: Row[] | null;
};

let fake: Fake;
/** 書き込みの順番。取消は順番そのものが安全装置なので、ここで固定する。 */
let writes: string[];
let nextId: number;

/**
 * 保存先の射影（select= に並べた列だけを返す）。
 *
 * PostgREST は select= に書いた列しか返さない。差し替えた保存先が行を丸ごと返すと、
 * 「どの列を読むか」の取り違え（amount・cancel_reason の読み落とし）が
 * テストに一切映らなくなる。このモジュールが自ら
 * 「問い合わせを1文字直しただけで金額が動く」と警告している経路そのものなので、
 * 保存先の側で本物と同じように列を落とす。
 */
function project(rows: Row[], query: string): Row[] {
  const m = /[?&]select=([^&]*)/.exec(query);
  const cols = (m ? m[1] : "").split(",").map((c) => c.trim()).filter(Boolean);
  if (cols.length === 0 || cols.includes("*")) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const out: Row = {};
    for (const c of cols) if (c in r) out[c] = r[c];
    return out;
  });
}

/** update の patch から、何をした書き込みかを名前にする。 */
function labelOfPatch(patch: Row): string {
  if (patch["status"] === "取消") return "未払に印";
  if (patch["status"] === "確定") return "確定にする";
  if (patch["cancel_reason"]) return "支払済に印";
  return `更新(${JSON.stringify(patch)})`;
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  nextId = 900;
  fake = {
    order: order(),
    orderUnreadable: false,
    rewards: [],
    products: PRODUCTS,
    agencies: [],
    payUnits: [],
  };

  dbSelectOne.mockImplementation(async (q) => {
    if (!q.startsWith("orders?")) throw new Error(`想定していない問い合わせ: ${q}`);
    if (fake.orderUnreadable) throw new Error("データベースへの読み込みに失敗しました。");
    if (!fake.order) return null;
    return project([fake.order], decodeURIComponent(q))[0];
  });

  dbSelectAll.mockImplementation(async (q) => {
    if (!q.startsWith("products?")) throw new Error(`想定していない問い合わせ: ${q}`);
    return fake.products;
  });

  dbSelect.mockImplementation(async (q) => {
    const query = decodeURIComponent(q);
    if (query.startsWith("rewards?")) {
      // 取消の候補だけは PostgREST 側で絞り込んでいるので、そこも再現する。
      if (query.includes("amount=gt.0")) {
        return project(
          fake.rewards.filter((r) => Number(r["amount"]) > 0 && r["status"] !== "取消"),
          query,
        );
      }
      return project(fake.rewards, query);
    }
    if (query.startsWith("agencies?select=code,rank,channel")) return project(fake.agencies, query);
    if (query.startsWith("agencies?select=code,pay_unit")) {
      if (fake.payUnits === null) {
        throw new Error("column agencies.pay_unit does not exist");
      }
      return project(fake.payUnits, query);
    }
    throw new Error(`想定していない問い合わせ: ${query}`);
  });

  dbInsert.mockImplementation(async (table, rows) => {
    writes.push(rows.some((r) => Number(r["amount"]) < 0) ? "マイナスを立てる" : "報酬を立てる");
    if (table === "rewards") {
      // 立てた行は、そのまま台帳に残る（続けて読む処理があるため）。
      for (const r of rows) fake.rewards.push({ id: nextId++, ...r });
    }
    return rows;
  });

  dbUpdate.mockImplementation(async (q, patch) => {
    const query = decodeURIComponent(q);
    let hit: Row[] = [];
    const ids = /id=in\.\(([^)]*)\)/.exec(query);
    if (ids) {
      const list = ids[1].split(",").filter(Boolean);
      hit = fake.rewards.filter((r) => list.includes(String(r["id"])));
    } else if (query.includes("status=eq.未確定")) {
      hit = fake.rewards.filter((r) => r["status"] === "未確定");
    }
    writes.push(labelOfPatch(patch));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  });

  dbAudit.mockResolvedValue(undefined);
});

describe("accrueRewards（報酬の計上）", () => {
  it("本部が払う相手（総販売代理店・2次代理店）に、税込の額で1行ずつ立てる", async () => {
    fake.order = order({ agency_code: "MET", zeroth_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];

    const count = await accrueRewards(501);

    expect(count).toBe(2);
    const rows = dbInsert.mock.calls[0][1];
    expect(dbInsert.mock.calls[0][0]).toBe("rewards");
    /*
     * 商品マスタは id 順で読む。同じ名前の行が2つ登録されていると、
     * 並び順が決まっていないままではどちらの単価が当たるか変わってしまう。
     */
    expect(dbSelectAll.mock.calls[0][0]).toContain("order=id");
    expect(rows).toEqual([
      {
        order_id: 501,
        agency_code: "MET",
        agency_rank: "2次代理店",
        month: "2026-08",
        amount: 62700, // 推奨額 57,000（税抜）→ 税込
        kind: "販売報酬",
        status: "未確定",
      },
      {
        order_id: 501,
        agency_code: "RIM",
        agency_rank: "総販売代理店",
        month: "2026-08",
        amount: 77000, // 推奨額 70,000（税抜）→ 税込
        kind: "販売報酬",
        status: "未確定",
      },
    ]);
  });

  it("OP①が付いた受注は、本体とOP①の推奨額を足した額で立てる", async () => {
    fake.order = order({ product_name: BODY_OP1, amount: 201500, zeroth_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];

    await accrueRewards(501);

    const rows = dbInsert.mock.calls[0][1];
    // 2次: 57,000 + 1,000 = 58,000（税抜）→ 63,800 ／ 総販: 70,000 + 3,000 → 80,300
    expect(rows.map((r) => r["amount"])).toEqual([63800, 80300]);
  });

  it("数量2台の受注は、1台ぶんの額を掛けた額で立てる", async () => {
    fake.order = order({ quantity: 2, agency_code: "RIM" });
    fake.agencies = [agency("RIM", "総販売代理店")];

    await accrueRewards(501);

    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(154000);
  });

  it("同じランクの相手が2社いても1行しか立てない（総販の下の総販で 154,000 円になった事故）", async () => {
    fake.order = order({ agency_code: "RIM", zeroth_code: "RIM0001" });
    fake.agencies = [agency("RIM", "総販売代理店"), agency("RIM0001", "総販売代理店")];

    const count = await accrueRewards(501);

    expect(count).toBe(1);
    // 残すのは「売った本人」。ゼロ次のほうではない。
    expect(dbInsert.mock.calls[0][1]).toEqual([
      expect.objectContaining({ agency_code: "RIM", amount: 77000 }),
    ]);
  });

  it("売った本人と2次が同じランクのときも、残すのは「売った本人」のほう", async () => {
    /*
     * 拾う順は「売った本人 → その2次 → ゼロ次 → 紹介した取次」で固定してある（rewards.ts:295-300）。
     * ここが入れ替わると、同じ 62,700 円がそのまま別の代理店に付く（払う先の取り違え）。
     */
    fake.order = order({ agency_code: "MET", niji_code: "MET0002" });
    fake.agencies = [agency("MET", "2次代理店"), agency("MET0002", "2次代理店")];

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1]).toEqual([
      expect.objectContaining({ agency_code: "MET", amount: 62700 }),
    ]);
  });

  it("保存先が別の順番で返しても、残るのは「売った本人」のほう", async () => {
    // データベースから返る順番は決まっていないので、受注の並び（売った本人 → 2次 → ゼロ次 → 紹介）に直す。
    fake.order = order({ agency_code: "RIM", zeroth_code: "RIM0001" });
    fake.agencies = [agency("RIM0001", "総販売代理店"), agency("RIM", "総販売代理店")];

    await accrueRewards(501);

    expect(dbInsert.mock.calls[0][1][0]["agency_code"]).toBe("RIM");
  });

  it("紹介した取次店のコードが総販売代理店だったときも、販売報酬と二重には立てない", async () => {
    fake.order = order({ agency_code: "RIM", referrer_code: "RIM0001" });
    fake.agencies = [agency("RIM", "総販売代理店"), agency("RIM0001", "総販売代理店")];

    expect(await accrueRewards(501)).toBe(1);
  });

  it("紹介元が別のランクなら、紹介報酬として立てる", async () => {
    fake.order = order({ agency_code: "MET", referrer_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];

    await accrueRewards(501);

    expect(dbInsert.mock.calls[0][1].map((r) => [r["agency_code"], r["kind"]])).toEqual([
      ["MET", "販売報酬"],
      ["RIM", "紹介報酬"],
    ]);
  });

  it("3次（販売代理店）・取次店には立てない（払うのは統括であって本部ではない）", async () => {
    fake.order = order({ agency_code: "MENO", niji_code: "MENO0001" });
    fake.agencies = [agency("MENO", "取次店"), agency("MENO0001", "販売代理店")];

    expect(await accrueRewards(501)).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("「ランク＝取次店 ＋ 販路種別＝販売代理店」は3次なので立てない", async () => {
    fake.order = order({ agency_code: "MENO" });
    fake.agencies = [agency("MENO", "取次店", "販売代理店")];

    expect(await accrueRewards(501)).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("「ランク＝2次代理店 ＋ 販路種別＝販売代理店」は2次のまま（3次の単価に落とさない）", async () => {
    // 販路種別だけを見て上書きすると、エリア統括代理店が3次の単価になり 7,700 円少なく計上される。
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店", "販売代理店")];

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1][0]).toEqual(
      expect.objectContaining({ agency_rank: "2次代理店", amount: 62700 }),
    );
  });

  it("個別に決めた単価（金額修正）は推奨額より優先し、税込にして立てる", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      { code: "MET", pay_unit: 60000, pay_unit_op1: null, pay_unit_op2: null, pay_unit_pad_yearly: null },
    ];

    await accrueRewards(501);

    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(66000);
    expect(dbAudit.mock.calls[0][3]).toEqual(
      expect.objectContaining({ 個別単価: { MET: { body: 60000 } } }),
    );
  });

  it("金額修正は品目ごとに効く：OP① の上書きも推奨額より優先する", async () => {
    /*
     * 2026-08-27 会議「本体だけ変えてもオプションの取り分は変わらない」の決定そのもの。
     * OP① の上書きを読み落とすと、本体 57,000 に推奨の OP① 1,000 が足されて 58,000 になり、
     * 個別契約の 62,000 との差 4,000（税込 4,400）だけ少なく計上される。
     */
    fake.order = order({ product_name: BODY_OP1, amount: 201500, agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      { code: "MET", pay_unit: null, pay_unit_op1: 5000, pay_unit_op2: null, pay_unit_pad_yearly: null },
    ];

    await accrueRewards(501);

    // 本体は推奨 57,000 のまま、OP① だけ 5,000 に差し替わる → 62,000（税抜）→ 68,200
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(68200);
    expect(dbAudit.mock.calls[0][3]).toEqual(
      expect.objectContaining({ 個別単価: { MET: { op1: 5000 } } }),
    );
  });

  it("金額修正は品目ごとに効く：1年後定期の上書きも推奨額より優先する", async () => {
    // 品目は本体・OP①・OP②・1年後定期の4つ。どれか1つでも上書きを落とすと支払額がずれる。
    const PAD = "単体／追加パッド(１年分)";
    fake.products = [
      ...PRODUCTS,
      {
        name: PAD,
        price_incl_tax: 16500,
        reward_target: "対象",
        amount_so: 3300,
        amount_niji: 1100,
        amount_hanbai: 1100,
        amount_toritsugi: 0,
        active: true,
      },
    ];
    fake.order = order({ product_name: `${BODY} ／ ${PAD}`, amount: 204800, agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      { code: "MET", pay_unit: null, pay_unit_op1: null, pay_unit_op2: null, pay_unit_pad_yearly: 4000 },
    ];

    await accrueRewards(501);

    // 本体は推奨 57,000 のまま、1年後定期だけ 4,000 に差し替わる → 61,000（税抜）→ 67,100
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(67100);
    expect(dbAudit.mock.calls[0][3]).toEqual(
      expect.objectContaining({ 個別単価: { MET: { padYearly: 4000 } } }),
    );
  });

  it("金額修正で 0 円にした相手には、報酬の行そのものを立てない", async () => {
    // 0 円の行を立てると、支払管理に「0 円の支払い待ち」が並んで実際の未払と見分けがつかなくなる。
    fake.order = order({ agency_code: "MET", zeroth_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];
    fake.payUnits = [
      { code: "MET", pay_unit: 0, pay_unit_op1: null, pay_unit_op2: null, pay_unit_pad_yearly: null },
    ];

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1]).toEqual([
      expect.objectContaining({ agency_code: "RIM", amount: 77000 }),
    ]);
  });

  it("pay_unit 系の列がまだ無くても、推奨額だけで計上を続ける", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = null; // 問い合わせが失敗する

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(62700);
    expect(dbAudit.mock.calls[0][3]).not.toHaveProperty("個別単価");
  });

  it("金額修正の欄が空文字なら「未設定」として読み、推奨額で立てる（0 円と混ぜない）", async () => {
    /*
     * 空文字を 0 円として読むと、金額修正を一度も入れていない相手の報酬行が
     * まるごと消える（paidExcl が 0 になって行を立てない）。
     * 「未設定」と「0円」を混ぜない読み方（rewards.ts:38-48）の契約。
     */
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      { code: "MET", pay_unit: "", pay_unit_op1: "", pay_unit_op2: "", pay_unit_pad_yearly: "" },
    ];

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(62700); // 推奨額 57,000 → 税込
    expect(dbAudit.mock.calls[0][3]).not.toHaveProperty("個別単価");
  });

  it("金額修正の欄が数として読めない値なら「未設定」として読む（NaN を台帳に入れない）", async () => {
    // ここを素通りさせると amount: NaN の行が insert され、金額列に NULL が入る。
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      {
        code: "MET",
        pay_unit: "六万円",
        pay_unit_op1: "—",
        pay_unit_op2: null,
        pay_unit_pad_yearly: null,
      },
    ];

    expect(await accrueRewards(501)).toBe(1);
    const amount = dbInsert.mock.calls[0][1][0]["amount"];
    expect(Number.isFinite(amount)).toBe(true);
    expect(amount).toBe(62700);
    expect(dbAudit.mock.calls[0][3]).not.toHaveProperty("個別単価");
  });

  it("金額修正の列はあるが、この相手の値が全部 null なら個別単価として記録しない", async () => {
    // 空の個別単価が監査ログに載ると、あとから「なぜこの額か」を追うときに嘘の根拠になる。
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.payUnits = [
      {
        code: "MET",
        pay_unit: null,
        pay_unit_op1: null,
        pay_unit_op2: null,
        pay_unit_pad_yearly: null,
      },
    ];

    expect(await accrueRewards(501)).toBe(1);
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(62700);
    expect(dbAudit.mock.calls[0][3]).not.toHaveProperty("個別単価");
  });

  it("受注日が空なら、対象月は日本時間の今日の月にする", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T15:30:00Z")); // JST では 2026-09-01 00:30
    try {
      fake.order = order({ ordered_on: "", agency_code: "MET" });
      fake.agencies = [agency("MET", "2次代理店")];

      await accrueRewards(501);

      expect(dbInsert.mock.calls[0][1][0]["month"]).toBe("2026-09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("報酬の行が1件でも残っていれば、何もしない（取消済みの行でも同じ）", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [reward({ status: "取消", cancel_reason: "審査の否決" })];

    expect(await accrueRewards(501)).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("計上し直し（redo）は、生きている報酬が無いときだけ立て直す", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [reward({ status: "取消", cancel_reason: "審査の否決" })];

    expect(await accrueRewards(501, { redo: true })).toBe(1);
    expect(dbAudit.mock.calls[0][1]).toBe("報酬の計上し直し");
  });

  it("計上し直しでも、生きている報酬が残っていれば立てない", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [reward({ status: "支払済" })];

    expect(await accrueRewards(501, { redo: true })).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("支払済のまま相殺した行しか残っていなければ、計上し直せる", async () => {
    // status は「支払済」のままなので、status だけで見ると二度と計上し直せない。
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [
      reward({ status: "支払済", cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）" }),
      reward({ id: 2, amount: -62700, status: "確定", kind: "取消", cancel_reason: "審査の否決" }),
    ];

    expect(await accrueRewards(501, { redo: true })).toBe(1);
  });

  it("計上し直し：0 円の行は「生きている報酬」に数えないので、立て直しを止めない", async () => {
    /*
     * isLive の境界（金額がプラスの行だけを生きているとみなす）。
     * ここを 0 円まで含めると、過去に 0 円で立った行が1件あるだけで
     * 否決の取り下げ後に二度と計上し直せなくなる。
     */
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [reward({ id: 11, amount: 0, status: "未確定", cancel_reason: null })];

    expect(await accrueRewards(501, { redo: true })).toBe(1);
    expect(dbInsert.mock.calls[0][1][0]["amount"]).toBe(62700);
  });

  it("計上の記録に、件数・合計・単価の決め方・根拠を残す（あとから検算するため）", async () => {
    fake.order = order({ agency_code: "MET", zeroth_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];

    await accrueRewards(501);

    expect(dbAudit).toHaveBeenCalledTimes(1);
    const [actor, action, target, detail] = dbAudit.mock.calls[0];
    expect(actor).toBe("system");
    expect(action).toBe("報酬計上");
    expect(target).toEqual({ type: "order", key: "501" });
    expect(detail).toEqual({
      件数: 2,
      合計: 139700, // 62,700 + 77,000。立てた行の額とつり合っていること
      単価の決め方: "商品名の完全一致",
      単価の根拠: [BODY],
    });
    // 記録の合計は、実際に立てた行の合計と必ず一致する
    const inserted = dbInsert.mock.calls[0][1];
    expect(detail["合計"]).toBe(inserted.reduce((t, r) => t + Number(r["amount"]), 0));
    expect(detail["件数"]).toBe(inserted.length);
  });

  it("分解で単価を決めたときは、拾った商品名をすべて記録に残す", async () => {
    fake.order = order({ product_name: BODY_OP1, amount: 201500, agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];

    await accrueRewards(501);

    const detail = dbAudit.mock.calls[0][3];
    expect(detail["単価の決め方"]).toBe("内訳への分解");
    // 並び順は引き当て側（./product-match）の都合なので、中身だけを見る
    expect(detail["単価の根拠"]).toHaveLength(2);
    expect(detail["単価の根拠"]).toEqual(expect.arrayContaining([BODY, OP1]));
    expect(detail["合計"]).toBe(63800);
  });

  it("報酬の読み取りには cancel_reason を必ず入れる（読み落とすと計上し直せなくなる）", async () => {
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];

    await accrueRewards(501);

    expect(dbSelect.mock.calls[0][0]).toContain("cancel_reason");
  });

  it("報酬の読み取りには amount を必ず入れる（読み落とすと 62,700 円が二重に立つ）", async () => {
    /*
     * 保存先は select= に並べた列しか返さない。amount を1語落とすと、
     * 生きている報酬の金額が読めず isLive が false になり、
     * 「まだ生きている報酬がある」受注に2行目が立って二重払いになる。
     */
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];
    fake.rewards = [reward({ id: 11, status: "支払済", amount: 62700, cancel_reason: null })];

    expect(await accrueRewards(501, { redo: true })).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
    // 台帳には支払済の1件だけが残る（2行目の 62,700 円が並ばない）
    expect(fake.rewards).toHaveLength(1);
  });

  it("既存の報酬を読む問い合わせは、4つの列をそろえたまま固定する", async () => {
    /*
     * この1本が「どの列を読むか」の契約。
     * amount を落とせば二重計上、cancel_reason を落とせば計上し直し不能になる。
     */
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];

    await accrueRewards(501);

    expect(dbSelect.mock.calls[0][0]).toBe(
      "rewards?select=id,status,amount,cancel_reason&order_id=eq.501",
    );
  });

  it("受注が見つからなければ、報酬は1件も読まない", async () => {
    fake.order = null;

    expect(await accrueRewards(999)).toBe(0);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("商品マスタに引き当てられない受注は立てない", async () => {
    fake.order = order({ product_name: "取扱いのない商品", amount: 1000 });
    fake.agencies = [agency("MET", "2次代理店")];

    expect(await accrueRewards(501)).toBe(0);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("商品名が空の受注は、商品マスタを読みにも行かない", async () => {
    // 引き当てようがないので、その手前で止める（無駄な問い合わせを出さない）。
    fake.order = order({ product_name: "" });
    fake.agencies = [agency("MET", "2次代理店")];

    expect(await accrueRewards(501)).toBe(0);
    expect(dbSelectAll).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("報酬の対象外の商品は立てない", async () => {
    fake.products = [{ ...PRODUCTS[0], reward_target: "対象外" }];
    fake.agencies = [agency("MET", "2次代理店")];

    expect(await accrueRewards(501)).toBe(0);
  });

  it("代理店コードが1つも入っていない受注は、代理店を読みにも行かない", async () => {
    fake.order = order({ agency_code: "", niji_code: "", zeroth_code: "", referrer_code: "" });

    expect(await accrueRewards(501)).toBe(0);
    // 読んだのは rewards（既存の行）だけ
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});

describe("confirmRewards（配送完了で確定）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T15:30:00Z")); // JST では 2026-09-01 00:30
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未確定を確定にし、対象月を配達完了の月へ付け替える。確定日は日本時間の今日", async () => {
    fake.order = { delivered_on: "2026-07-28" };
    fake.rewards = [reward({ month: "2026-06" }), reward({ id: 2, month: "2026-06" })];

    expect(await confirmRewards(501)).toBe(2);
    expect(dbUpdate.mock.calls[0][1]).toEqual({
      status: "確定",
      confirmed_on: "2026-09-01", // UTC では 2026-08-31。日本時間で決める
      month: "2026-07",
    });
  });

  it("配達完了日が空なら、対象月は受注月のまま動かさない", async () => {
    fake.order = { delivered_on: null };
    fake.rewards = [reward()];

    await confirmRewards(501);

    expect(dbUpdate.mock.calls[0][1]).toEqual({ status: "確定", confirmed_on: "2026-09-01" });
    expect(dbUpdate.mock.calls[0][1]).not.toHaveProperty("month");
    // 記録には「動かさなかった」と分かる形で残す（空欄だと読み落とす）
    expect(dbAudit.mock.calls[0][3]).toEqual({ 件数: 1, 対象月: "（受注月のまま）" });
  });

  it("受注が読めなくても、確定そのものは進める（月は受注月のまま）", async () => {
    fake.orderUnreadable = true;
    fake.rewards = [reward()];

    expect(await confirmRewards(501)).toBe(1);
    expect(dbUpdate.mock.calls[0][1]).not.toHaveProperty("month");
  });

  it("確定するものが無ければ、操作の記録も残さない", async () => {
    fake.order = { delivered_on: "2026-07-28" };
    fake.rewards = [reward({ status: "確定" })];

    expect(await confirmRewards(501)).toBe(0);
    expect(dbAudit).not.toHaveBeenCalled();
  });
});

describe("reverseRewardsDetailed（報酬の打ち切り）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T15:30:00Z")); // JST では 2026-09-01 00:30
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未払の報酬は「取消」にするだけで、マイナスは立てない", async () => {
    fake.rewards = [reward({ id: 11, status: "未確定" }), reward({ id: 12, status: "確定" })];

    const outcome = await reverseRewardsDetailed(501, "受注のキャンセル");

    expect(outcome).toEqual({ count: 2, paidCount: 0, paidAmount: 0, paidNote: "" });
    expect(dbInsert).not.toHaveBeenCalled();
    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0][0]).toContain("id=in.(11,12)");
    expect(dbUpdate.mock.calls[0][1]).toEqual({ status: "取消", cancel_reason: "受注のキャンセル" });
  });

  it("支払済は status を変えず、同額のマイナスを当月に立てる", async () => {
    fake.rewards = [reward({ id: 11, status: "支払済", amount: 77000, agency_rank: "総販売代理店", agency_code: "RIM" })];

    const outcome = await reverseRewardsDetailed(501, "審査の否決");

    expect(dbInsert.mock.calls[0][1]).toEqual([
      {
        order_id: 501,
        agency_code: "RIM",
        agency_rank: "総販売代理店",
        month: "2026-09", // 取消は日本時間の当月に立てる（UTC では 2026-08）
        amount: -77000,
        kind: "取消",
        status: "確定",
        confirmed_on: "2026-09-01",
        cancel_reason: "審査の否決",
      },
    ]);
    // 元の行は「支払済」のまま。理由だけを書き添える。
    expect(dbUpdate.mock.calls[0][1]).toEqual({
      cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）",
    });
    expect(dbUpdate.mock.calls[0][1]).not.toHaveProperty("status");
    expect(outcome.paidCount).toBe(1);
    expect(outcome.paidAmount).toBe(77000);
    expect(outcome.paidNote).toContain("支払済の報酬が 1 件（¥77,000）");
  });

  it("支払済と未払がまじっていても、マイナスを立てるのは支払済のぶんだけ", async () => {
    /*
     * 未払にまでマイナスを立てると、一度も払っていない額を次の振込から差し引くことになる
     * （8月に +1,000 を計上 → 同8月に否決 → 支払い待ちが 0 円ではなく −1,000 円になる、という取り違え）。
     */
    fake.rewards = [
      reward({ id: 11, status: "支払済", amount: 77000, agency_code: "RIM" }),
      reward({ id: 12, status: "未確定", amount: 62700, agency_code: "MET" }),
      reward({ id: 13, status: "確定", amount: 27500, agency_code: "MENO" }),
    ];

    const outcome = await reverseRewardsDetailed(501, "審査の否決");

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(dbInsert.mock.calls[0][1]).toEqual([
      expect.objectContaining({ agency_code: "RIM", amount: -77000 }),
    ]);
    expect(outcome).toEqual(
      expect.objectContaining({ count: 3, paidCount: 1, paidAmount: 77000 }),
    );
    // 未払の2件は「取消」にするだけ
    expect(dbUpdate.mock.calls[1][0]).toContain("id=in.(12,13)");
    expect(dbUpdate.mock.calls[1][1]).toEqual({ status: "取消", cancel_reason: "審査の否決" });
  });

  it("書き込む順番は「マイナス → 支払済に印 → 未払に印」で固定する", async () => {
    /*
     * 途中で止まったときに「マイナスの数 > 印のついた行の数」になり、
     * 呼んだ側の halfDone に引っかかって二重の取消が止まるようにするための順番。
     */
    fake.rewards = [
      reward({ id: 11, status: "支払済", amount: 77000 }),
      reward({ id: 12, status: "未確定", amount: 62700 }),
    ];

    await reverseRewardsDetailed(501, "審査の否決");

    expect(writes).toEqual(["マイナスを立てる", "支払済に印", "未払に印"]);
  });

  it("前回の取消で印を付けた行には、二度目のマイナスを立てない", async () => {
    fake.rewards = [
      // 前回の取消で相殺済み（status は「支払済」のまま残っている）
      reward({ id: 11, status: "支払済", amount: 77000, cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）" }),
      reward({ id: 12, status: "支払済", amount: 62700 }),
    ];

    const outcome = await reverseRewardsDetailed(501, "審査の否決");

    expect(outcome.paidCount).toBe(1);
    expect(dbInsert.mock.calls[0][1]).toEqual([expect.objectContaining({ amount: -62700 })]);
  });

  it("支払済が2件あれば、2件ぶんのマイナスを立てて2件と数える", async () => {
    /*
     * 件数は「実際に印を付けた行の数」。1回の書き込みで2行動いたのを 1 と数えると、
     * 本部への報告（paidNote）も監査ログの件数も実際より少なくなる。
     */
    fake.rewards = [
      reward({ id: 11, status: "支払済", amount: 77000, agency_code: "RIM", agency_rank: "総販売代理店" }),
      reward({ id: 12, status: "支払済", amount: 62700, agency_code: "MET" }),
    ];

    // 受注番号は文字列で渡されることもある（呼び出し口は string | number）。
    const outcome = await reverseRewardsDetailed("501", "審査の否決");

    expect(outcome.count).toBe(2);
    expect(outcome.paidCount).toBe(2);
    expect(outcome.paidAmount).toBe(139700);
    expect(outcome.paidNote).toContain("支払済の報酬が 2 件（¥139,700）");
    expect(dbInsert.mock.calls[0][1].map((r) => r["amount"])).toEqual([-77000, -62700]);
    // マイナスの受注番号は元の報酬の行から引き継ぐ（渡された文字列をそのまま入れない）
    expect(dbInsert.mock.calls[0][1].map((r) => r["order_id"])).toEqual([501, 501]);
    expect(dbAudit.mock.calls[0][3]["件数"]).toBe(2);
  });

  it("件数は、実際に書き換えられた行の数だけを数える（1件しか動かなかったとき）", async () => {
    /*
     * 呼んだ側はこの件数をそのまま本部に伝える。名指しした行の数で数えると、
     * 途中で止まった取消を「全部済んだ」と報告してしまう。
     */
    fake.rewards = [reward({ id: 11, status: "未確定" }), reward({ id: 12, status: "確定" })];
    // 保存先が1行しか書き換えられなかった（もう1行は先に消えていた）
    dbUpdate.mockImplementationOnce(async (_q, patch) => {
      writes.push(labelOfPatch(patch));
      const row = fake.rewards[0];
      Object.assign(row, patch);
      return [{ ...row }];
    });

    const outcome = await reverseRewardsDetailed(501, "審査の否決");

    expect(outcome.count).toBe(1);
    expect(dbAudit.mock.calls[0][3]["件数"]).toBe(1);
  });

  it("行番号に数字以外がまじっていても止める（名指ししていない行が巻き添えになるため）", async () => {
    /*
     * 行番号はそのまま `rewards?id=in.(…)` に並べる。数字だけであることを確かめずに通すと、
     * 「12,13」のような値ひとつで、名指ししていない 13 番まで取消になる。
     */
    fake.rewards = [reward({ id: 11, status: "支払済" }), reward({ id: "12,13", status: "未確定" })];

    await expect(reverseRewardsDetailed(501, "審査の否決")).rejects.toThrow(
      "行番号を読み取れなかった",
    );
    expect(writes).toEqual([]);
  });

  it("取消の記録に、件数・相殺した件数と金額・未払の件数・理由を残す", async () => {
    fake.rewards = [
      reward({ id: 11, status: "支払済", amount: 77000 }),
      reward({ id: 12, status: "未確定", amount: 62700 }),
      reward({ id: 13, status: "確定", amount: 27500 }),
    ];

    await reverseRewardsDetailed(501, "審査の否決（アプラス否決 12345）");

    expect(dbAudit).toHaveBeenCalledTimes(1);
    const [actor, action, target, detail] = dbAudit.mock.calls[0];
    expect(actor).toBe("system");
    expect(action).toBe("報酬の取消");
    expect(target).toEqual({ type: "order", key: "501" });
    expect(detail).toEqual({
      件数: 3, // 印を付けた行の数（支払済1 + 未払2）
      支払済のため相殺した件数: 1,
      支払済のため相殺した金額: 77000,
      未払のまま打ち切った件数: 2,
      理由: "審査の否決（アプラス否決 12345）",
    });
  });

  it("取消の記録の件数は、実際に印が付いた行の数だけを数える", async () => {
    // 前回の取消で印の付いた行（id=11）は対象外なので、件数は1件にとどまる。
    fake.rewards = [
      reward({
        id: 11,
        status: "支払済",
        amount: 77000,
        cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）",
      }),
      reward({ id: 12, status: "未確定", amount: 62700 }),
    ];

    const outcome = await reverseRewardsDetailed(501, "受注のキャンセル");

    expect(dbAudit.mock.calls[0][3]).toEqual({
      件数: 1,
      支払済のため相殺した件数: 0,
      支払済のため相殺した金額: 0,
      未払のまま打ち切った件数: 1,
      理由: "受注のキャンセル",
    });
    expect(dbAudit.mock.calls[0][3]["件数"]).toBe(outcome.count);
  });

  it("生きている報酬が無ければ、1件も書き込まない", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];

    expect(await reverseRewardsDetailed(501, "審査の否決")).toEqual({
      count: 0,
      paidCount: 0,
      paidAmount: 0,
      paidNote: "",
    });
    expect(writes).toEqual([]);
    // 空振りの取消を記録に残すと、あとから検算するときに実体の無い取消が並ぶ
    expect(dbAudit).not.toHaveBeenCalled();
  });

  it("行番号を読み取れない行があれば、1件も動かさずに止める", async () => {
    fake.rewards = [reward({ id: 11, status: "支払済" }), reward({ id: null, status: "未確定" })];

    await expect(reverseRewardsDetailed(501, "審査の否決")).rejects.toThrow("行番号を読み取れなかった");
    expect(writes).toEqual([]);
  });

  it("reverseRewards は打ち切った件数だけを返す", async () => {
    fake.rewards = [reward({ id: 11 }), reward({ id: 12 })];

    expect(await reverseRewards(501, "帰属の入れ直しのため")).toBe(2);
  });
});

describe("onReviewResultChanged（審査結果が変わったとき）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T15:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("結果がまだ出ていない（電話確認待ち）ときは、報酬を読みにも行かない", async () => {
    expect(await onReviewResultChanged(501, "電話確認待ち")).toEqual({
      action: "変更なし",
      count: 0,
      reason: "審査の結果が出るまで、報酬はそのままにしています。",
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("結果が空のときも、報酬はそのままにする", async () => {
    expect((await onReviewResultChanged(501, "")).action).toBe("変更なし");
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("否決：報酬が1件も無ければ、取り消すものが無いと伝える", async () => {
    fake.rewards = [];

    const out = await onReviewResultChanged(501, "否決");

    expect(out).toEqual({
      action: "変更なし",
      count: 0,
      reason: "この受注には報酬が1件も計上されていないため、取り消すものはありませんでした。",
    });
    expect(writes).toEqual([]);
  });

  it("否決：すでに取り消されていれば、そう伝えて何もしない", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];

    const out = await onReviewResultChanged(501, "否決");

    expect(out).toEqual({
      action: "変更なし",
      count: 0,
      reason: "この受注の報酬は、すでに取り消されています。",
    });
    expect(writes).toEqual([]);
  });

  it("否決：取消が途中で止まっていれば、報酬に触らずに中断する", async () => {
    // マイナスだけが立ち、元の支払済の行に印が付いていない状態
    fake.rewards = [
      reward({ id: 11, status: "支払済", amount: 77000 }),
      reward({ id: 12, status: "確定", amount: -77000, kind: "取消", cancel_reason: "審査の否決" }),
    ];

    const out = await onReviewResultChanged(501, "否決");

    expect(out.action).toBe("中断");
    expect(out.count).toBe(0);
    expect(out.reason).toContain("相殺のマイナス 1 件");
    expect(out.reason).toContain("元の報酬 1 件");
    expect(writes).toEqual([]);
  });

  it("否決：未払だけなら取り消して終わる", async () => {
    fake.rewards = [reward({ id: 11, status: "未確定" })];

    expect(await onReviewResultChanged(501, "否決")).toEqual({
      action: "取消",
      count: 1,
      reason: "",
    });
  });

  it("否決：本部が書いた理由は、取消の理由に書き添える", async () => {
    fake.rewards = [reward({ id: 11, status: "未確定" })];

    await onReviewResultChanged(501, "否決", "  アプラス否決 12345  ");

    expect(dbUpdate.mock.calls[0][1]).toEqual({
      status: "取消",
      cancel_reason: "審査の否決（アプラス否決 12345）",
    });
  });

  it("否決：支払済がまじっていたら、別の名前で返して差し引きのお願いまで伝える", async () => {
    fake.rewards = [reward({ id: 11, status: "支払済", amount: 77000 })];

    const out = await onReviewResultChanged(501, "否決", "アプラス否決 12345");

    expect(out.action).toBe("取消（支払済あり）");
    expect(out.count).toBe(1);
    expect(out.reason).toContain("報酬 1 件を取り消しました。");
    expect(out.reason).toContain("「アプラス否決 12345」");
    expect(out.reason).toContain("次回の振込から差し引いてください。");
  });

  it("承認：生きている報酬があれば、計上し直さない", async () => {
    fake.rewards = [reward({ id: 11, status: "未確定" })];

    expect(await onReviewResultChanged(501, "承認")).toEqual({
      action: "変更なし",
      count: 0,
      reason: "この受注の報酬はすでに計上されています。",
    });
    expect(writes).toEqual([]);
  });

  it("承認：出荷状況がキャンセルの受注は、計上し直さない", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];
    fake.order = order({ ship_status: "キャンセル" });

    const out = await onReviewResultChanged(501, "承認");

    expect(out.action).toBe("変更なし");
    expect(out.reason).toContain("出荷状況が「キャンセル」のため");
    expect(writes).toEqual([]);
  });

  it("承認：取り消した報酬しか無ければ、あらためて計上し直す", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];
    fake.order = order({ agency_code: "MET", zeroth_code: "RIM" });
    fake.agencies = [agency("MET", "2次代理店"), agency("RIM", "総販売代理店")];

    expect(await onReviewResultChanged(501, "承認")).toEqual({
      action: "計上し直し",
      count: 2,
      reason: "",
    });
    expect(writes).toEqual(["報酬を立てる"]);
  });

  it("承認：支払済のまま相殺した行しか無くても、計上し直せる（cancel_reason を読む契約）", async () => {
    /*
     * 支払済を相殺した行は status が「支払済」のまま残る。
     * ここで cancel_reason を読み落とすと「まだ生きている報酬」に数えられ、
     * action が「変更なし（すでに計上されています）」になって二度と計上し直せなくなる。
     */
    fake.rewards = [
      reward({
        id: 11,
        status: "支払済",
        amount: 62700,
        cancel_reason: "審査の否決（振込済みのため取り消さず、同額のマイナスで相殺）",
      }),
      reward({ id: 12, amount: -62700, status: "確定", kind: "取消", cancel_reason: "審査の否決" }),
    ];
    fake.order = order({ agency_code: "MET" });
    fake.agencies = [agency("MET", "2次代理店")];

    expect(await onReviewResultChanged(501, "承認")).toEqual({
      action: "計上し直し",
      count: 1,
      reason: "",
    });
    expect(writes).toEqual(["報酬を立てる"]);
  });

  it("審査結果を見るときの問い合わせも、4つの列をそろえたまま固定する", async () => {
    fake.rewards = [reward({ id: 11, status: "未確定" })];

    await onReviewResultChanged(501, "承認");

    expect(dbSelect.mock.calls[0][0]).toBe(
      "rewards?select=id,status,amount,cancel_reason&order_id=eq.501",
    );
  });

  it("承認：出荷済の受注なら、計上し直した報酬をその場で確定させる", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];
    fake.order = order({ agency_code: "MET", ship_status: "出荷済", delivered_on: "2026-08-20" });
    fake.agencies = [agency("MET", "2次代理店")];

    const out = await onReviewResultChanged(501, "承認");

    expect(out).toEqual({
      action: "計上し直し",
      count: 1,
      reason: "この受注はすでに出荷済みのため、計上し直した報酬は確定にしています。",
    });
    expect(writes).toEqual(["報酬を立てる", "確定にする"]);
  });

  it("承認：立て直せる報酬が無ければ、確かめてほしいことを伝える", async () => {
    fake.rewards = [reward({ id: 11, status: "取消", cancel_reason: "審査の否決" })];
    fake.order = order({ agency_code: "MENO" });
    fake.agencies = [agency("MENO", "取次店")]; // 本部の台帳には立たない相手

    const out = await onReviewResultChanged(501, "承認");

    expect(out.action).toBe("変更なし");
    expect(out.reason).toContain("計上し直せる報酬はありませんでした。");
  });
});

describe("monthlyRewards（代理店ごと・月ごとの集計）", () => {
  it("確定・支払済は確定額に、未確定は見込みに入れ、取消の行は合計から外す", async () => {
    fake.rewards = [
      { agency_code: "MET", month: "2026-08", status: "確定", amount: 62700 },
      { agency_code: "MET", month: "2026-08", status: "支払済", amount: 1100 },
      { agency_code: "MET", month: "2026-08", status: "未確定", amount: 63800 },
      { agency_code: "MET", month: "2026-08", status: "取消", amount: 62700 },
      { agency_code: "MET", month: "2026-08", status: "確定", amount: -62700, kind: "取消" },
    ];

    expect(await monthlyRewards(["MET"])).toEqual([
      { agencyCode: "MET", month: "2026-08", confirmed: 1100, pending: 63800, total: 64900 },
    ]);
  });

  it("代理店と月ごとにまとめ、新しい月から並べる", async () => {
    fake.rewards = [
      { agency_code: "MET", month: "2026-07", status: "支払済", amount: 62700 },
      { agency_code: "MET", month: "2026-09", status: "未確定", amount: 63800 },
      { agency_code: "RIM", month: "2026-08", status: "確定", amount: 77000 },
    ];

    expect((await monthlyRewards(["MET", "RIM"])).map((r) => [r.agencyCode, r.month])).toEqual([
      ["MET", "2026-09"],
      ["RIM", "2026-08"],
      ["MET", "2026-07"],
    ]);
  });

  it("コードが1つも無ければ、保存先を読みに行かない", async () => {
    expect(await monthlyRewards([])).toEqual([]);
    expect(await monthlyRewards(["", ""])).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("月を指定したときだけ、月で絞り込む", async () => {
    fake.rewards = [];

    await monthlyRewards(["MET", ""], "2026-08");
    expect(dbSelect.mock.calls[0][0]).toBe('rewards?select=*&agency_code=in.("MET")&month=eq.2026-08');

    await monthlyRewards(["MET"]);
    expect(dbSelect.mock.calls[1][0]).toBe('rewards?select=*&agency_code=in.("MET")');
  });
});

/* ─────────────────────────────────────────────────────────────
 * 既知の欠陥（仕様ではない）
 * ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
 * 通っていることは正しさを意味しない。
 * ───────────────────────────────────────────────────────────── */
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】未払取消の行が reversed を水増しし、止まっている取消を見逃す（rewards.ts:123）", () => {
    /*
     * 本来どうあるべきか:
     *   reversed は「マイナスを立てるべきだった行（＝支払済のまま相殺した行）」だけを数え、
     *   マイナスの立たない未払取消は数に入れないべき。
     *   下の並びは「マイナス1件・印の付いていない支払済1件」で止まっているので halfDone は true、
     *   呼び側は中断しなければならない。
     *
     * いまの実装:
     *   1周目の未払取消（マイナスなし）が reversed を 1 押し上げるため
     *   offsets(1) > reversed(1) が成り立たず halfDone が false になる。
     *   未払取消が1件増えるごとに、ガードに1件ぶんの遊びができる。
     */
    const rows: Row[] = [cancelled(62700), paid(62700), negative(62700)];
    expect(rewardStanding(rows)).toEqual({
      live: 1,
      livePaid: 1,
      offsets: 1,
      reversed: 1,
      halfDone: false, // 本来は true
    });
  });

  it("【欠陥】その遊びのせいで、否決のやり直しが同じ報酬に2件目のマイナスを立てる", async () => {
    /*
     * 本来どうあるべきか:
     *   action は「中断」で、報酬には1件も書き込まないべき（rewards.ts:670 のガードの唯一の目的）。
     *
     * いまの実装:
     *   halfDone が false のまま取消をやり直すので、すでにマイナスが立っている 62,700 円に
     *   2件目のマイナスが立ち、次回の振込から二重に差し引かれる。
     */
    fake.rewards = [
      reward({ id: 11, status: "取消", cancel_reason: "審査の否決" }), // 1周目（未払のまま取消）
      reward({ id: 12, status: "支払済", amount: 62700 }), // 2周目（印が付いていない）
      reward({ id: 13, status: "確定", amount: -62700, kind: "取消", cancel_reason: "審査の否決" }),
    ];

    const out = await onReviewResultChanged(501, "否決");

    expect(out.action).toBe("取消（支払済あり）"); // 本来は "中断"
    expect(dbInsert.mock.calls[0][1]).toEqual([expect.objectContaining({ amount: -62700 })]);
    // 同じ受注に -62,700 のマイナスが2件並ぶ
    expect(fake.rewards.filter((r) => Number(r["amount"]) < 0)).toHaveLength(2);
  });

  it("【欠陥】cancel_reason が空白だけでも「理由あり」とみなして打ち切り済みになる（rewards.ts:75）", () => {
    /*
     * 本来どうあるべきか:
     *   trim() してから見て、空白だけなら「理由なし＝まだ生きている」と数えるべき。
     *
     * いまの実装:
     *   空白1文字でも打ち切り済みになる。到達経路は手作業のデータ修正だけなので実害は小さいが、
     *   生きている報酬が「すでに取り消されています」に化ける。
     */
    const rows: Row[] = [{ amount: 77000, status: "確定", cancel_reason: "   " }];
    expect(rewardStanding(rows)).toEqual({
      live: 0, // 本来は 1
      livePaid: 0,
      offsets: 0,
      reversed: 1, // 本来は 0
      halfDone: false,
    });
  });

  it("【欠陥】数として読めない金額は 0 円扱いになり、どの件数にも入らない（rewards.ts:33-37）", () => {
    /*
     * 本来どうあるべきか:
     *   金額が読めない行は「判断できない」として呼び側に知らせ、取消や計上し直しを止めるべき。
     *
     * いまの実装:
     *   0 円として黙って落ちるので live が 0 になり、
     *   呼び側（onReviewResultChanged）は「すでに取り消されています」と誤って答える。
     */
    const rows: Row[] = [
      { amount: "七万七千円", status: "未確定", cancel_reason: null },
      { amount: null, status: "支払済", cancel_reason: null },
    ];
    expect(rewardStanding(rows)).toEqual({
      live: 0,
      livePaid: 0,
      offsets: 0,
      reversed: 0,
      halfDone: false,
    });
  });

  it("【欠陥】amount 列を選び忘れた行は、報酬が無いのと同じ答えになる（rewards.ts:107）", () => {
    /*
     * 本来どうあるべきか:
     *   金額の列が無い行は「判断できない」として扱うべき（0 円の行と区別する）。
     *
     * いまの実装:
     *   select から amount を落とすと live が 0 になり、生きている報酬が取消済みに見える。
     *   いまは呼び出し口2か所が select を直書きしているので到達しないが、
     *   問い合わせを1文字直しただけで金額が動く。
     *   その前提（2か所の select が 4 列そろっていること）は
     *   「既存の報酬を読む問い合わせは、4つの列をそろえたまま固定する」と
     *   「審査結果を見るときの問い合わせも、4つの列をそろえたまま固定する」で
     *   固定してある。あわせて差し替えた保存先も select= の列指定に従うので、
     *   1語落とせば二重計上・計上し直し不能として赤くなる。
     */
    const rows: Row[] = [
      { id: 1, status: "未確定", cancel_reason: null },
      { id: 2, status: "支払済", cancel_reason: null },
    ];
    expect(rewardStanding(rows)).toEqual({
      live: 0,
      livePaid: 0,
      offsets: 0,
      reversed: 0,
      halfDone: false,
    });
  });
});
