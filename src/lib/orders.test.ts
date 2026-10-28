import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

/*
 * "server-only" は vitest.config.ts の resolve.alias で
 * next の空実装に差し替え済みなので、ここでモックする必要はない。
 */

/*
 * 保存先（./db）は丸ごと差し替える。orders.ts が触る外部接点は select の1本だけなので、
 * 差し替えれば listOrders が「どんな問い合わせを投げたか」まで確かめられる。
 * ここが要点で、listOrders の中身のうち事故が起きたのは
 *   ・月の境界（monthRange）
 *   ・配達完了日で切るかどうか（basis）
 *   ・スタッフコードを見るかどうか（or フィルタ）
 *   ・同じ日の並び順（id.desc）
 * のように、返ってきた行ではなく問い合わせ文字列そのものに現れる。
 * agencies.test.ts / rewards.test.ts と同じやり方。
 */
vi.mock("./db", () => ({ select: vi.fn() }));

import { select } from "./db";
import { defaultPayUnits, effectivePayUnits, type PayUnits } from "./pay-defaults";
import { thisMonthInJapan } from "./jst";
import { PRODUCT_COLUMNS } from "./product-match";
import type { Agency, AgencyRank, SalesChannel } from "./types";
import {
  attachRewards,
  canComputeReward,
  currentMonth,
  effectiveRank,
  listOrders,
  recentMonths,
  scopeCodes,
  summarize,
  unitRewardFor,
  type OrderWithReward,
} from "./orders";

type Row = Record<string, unknown>;

const dbSelect = select as unknown as Mock<(q: string) => Promise<Row[]>>;

/* ───────────────────────── テスト用の材料 ───────────────────────── */

/**
 * 商品マスタから引いた単価が載った受注行（listOrders が作る形）。
 * 金額は実際の商品マスタ「VIS本体」の行に合わせてある
 * （product-match.test.ts の BODY 行と同じ 77,000 / 62,700 / 55,000 / 27,500）。
 */
const UNITS = {
  _unit_so: 77000,
  _unit_niji: 62700,
  _unit_hanbai: 55000,
  _unit_toritsugi: 27500,
};

const BODY = "VIS本体　先行予約";
const BODY_OP1_OP2 =
  "VIS本体　先行予約 ／ 事務手数料 ／ 3年保証セット ／ ジェルパッド1年分 先行購入（OP①・13,200円）";

/** 上位が配下に払う額（税抜）。統括 → 3次・スタッフ販売系の推奨額。 */
const PAY_UNITS: PayUnits = { body: 50000, op1: 500, op2: 1000, padYearly: 500 };

function agency(over: Partial<Agency> = {}): Agency {
  return {
    recordId: "1",
    code: "MENO",
    name: "メノ商事",
    representative: "山田",
    rank: "取次店" as AgencyRank,
    channel: "未設定" as SalesChannel,
    codeKind: "00",
    orgCode: "MENO",
    parentCode: "RIM0002",
    parentName: "統括",
    companyName: "",
    staffType: "",
    area: "関東",
    email: "a@example.com",
    phone: "03-0000-0000",
    zip: "",
    address: "",
    invoiceNo: "",
    bankName: "",
    bankBranch: "",
    accountType: "",
    accountNo: "",
    accountHolder: "",
    status: "有効",
    staffLimit: 100,
    slotLimits: {
      販売代理店枠上限: 0,
      サロン代理店枠上限: 0,
      個人代理店枠上限: 0,
      取次店枠上限: 0,
    },
    slotUsed: 0,
    slotRequestStatus: "",
    specialSlot: false,
    registeredVia: "",
    createdAt: "2026-08-01",
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
    ...over,
  };
}

function order(over: Partial<OrderWithReward> = {}): OrderWithReward {
  return {
    recordId: "1",
    date: "2026-08-10",
    customerName: "佐藤",
    productName: BODY,
    amount: 185000,
    quantity: 1,
    phone: "",
    shippingStatus: "出荷待ち",
    shippedAt: "",
    deliveredAt: "",
    paymentMethod: "クレジットカード",
    paymentStatus: "決済完了",
    matchStatus: "",
    agencyCode: "MENO",
    secondaryCode: "",
    referrerCode: "",
    staffCode: "",
    trackingNo: "",
    ownerCode: "MENO",
    unitReward: null,
    reward: null,
    ...over,
  };
}

/* ───────────── listOrders 用の材料（商品マスタと保存先） ───────────── */

/**
 * 商品マスタの行。列は PRODUCT_COLUMNS と同じ形。
 * 金額は product-match.test.ts と同じ実データ（id=5 の本体＋事務手数料）に合わせる。
 */
const P_BODY_FEE: Row = {
  name: "眼筋トレーニングマシンVIS本体　185,000円 ／ 事務手数料　3,300円",
  price_incl_tax: 188300,
  reward_target: "対象",
  amount_so: 77000,
  amount_niji: 62700,
  amount_hanbai: 55000,
  amount_toritsugi: 27500,
  active: true,
};

/**
 * 3年保証セット（OP②）。本体＋事務手数料の行と足し合わせると、
 * 商品マスタに元から入っている結合レコード（id=3）と全列で一致する
 * （188,300 + 11,000 = 199,300 / 販代 55,000 + 1,100 = 56,100）。
 */
const P_WARRANTY: Row = {
  name: "3年保証セット",
  price_incl_tax: 11000,
  reward_target: "対象",
  amount_so: 3300,
  amount_niji: 2200,
  amount_hanbai: 1100,
  amount_toritsugi: 0,
  active: true,
};

/** 報酬対象外の商品。金額列に値が入っていても報酬にしてはいけない。 */
const P_FEE_ONLY: Row = {
  name: "事務手数料",
  price_incl_tax: 3300,
  reward_target: "対象外",
  amount_so: 1000,
  amount_niji: 900,
  amount_hanbai: 800,
  amount_toritsugi: 700,
  active: true,
};

/**
 * select の差し替え。orders / products の2本を投げ分け、投げた問い合わせを記録する。
 * 返り値の配列に、実際に投げられた問い合わせ文字列が順に入る。
 */
function stubDb(orderRows: Row[] = [], productRows: Row[] = []): string[] {
  const queries: string[] = [];
  dbSelect.mockImplementation((q: string) => {
    queries.push(q);
    return Promise.resolve(q.startsWith("products?") ? productRows : orderRows);
  });
  return queries;
}

/** 受注テーブルへ投げた問い合わせ（商品マスタのぶんと取り違えない）。 */
function ordersQuery(queries: string[]): string {
  const q = queries.find((x) => x.startsWith("orders?"));
  if (!q) throw new Error("orders への問い合わせが投げられていない");
  return q;
}

/** listOrders を1回呼んで、受注テーブルへの問い合わせ文字列を取り出す。 */
async function queryOf(codes: string[], opts?: Parameters<typeof listOrders>[1]): Promise<string> {
  const queries = stubDb([], []);
  await listOrders(codes, opts);
  return ordersQuery(queries);
}

beforeEach(() => {
  dbSelect.mockReset();
  dbSelect.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ───────────────────────── unitRewardFor ───────────────────────── */

describe("unitRewardFor（ランク別の単価を受注行から読む）", () => {
  it("ランクごとに対応する列を読む（取次店は _unit_toritsugi、3次は _unit_hanbai）", () => {
    expect(unitRewardFor(UNITS, "総販売代理店")).toBe(77000);
    expect(unitRewardFor(UNITS, "2次代理店")).toBe(62700);
    expect(unitRewardFor(UNITS, "取次店")).toBe(27500);
    expect(unitRewardFor(UNITS, "販売代理店")).toBe(55000);
  });

  it("ランクが4種類のどれでもなければ、単価が載っていても null", () => {
    expect(unitRewardFor(UNITS, "")).toBeNull();
    expect(unitRewardFor(UNITS, "スタッフ")).toBeNull();
    expect(unitRewardFor(UNITS, "2次")).toBeNull();
  });

  it("報酬対象外・商品マスタに無い商品（null）は null を返す", () => {
    expect(unitRewardFor({ ...UNITS, _unit_niji: null }, "2次代理店")).toBeNull();
  });

  it("列そのものが無い（undefined）ときも null を返す", () => {
    expect(unitRewardFor({}, "2次代理店")).toBeNull();
  });

  it("文字列で入っている数値は数値に直す", () => {
    expect(unitRewardFor({ _unit_so: "77000" }, "総販売代理店")).toBe(77000);
  });

  it("単価 0 は null にしない（「0円」と「—」は別の意味）", () => {
    /*
     * 取次店の OP②（3年保証セット）は商品マスタで amount_toritsugi = 0。
     * 「0円で確定している」と「単価が決まっていない（—）」の区別が
     * このモジュールの核心なので、本物の 0 で押さえておく。
     */
    expect(unitRewardFor({ ...UNITS, _unit_toritsugi: 0 }, "取次店")).toBe(0);
    expect(unitRewardFor({ ...UNITS, _unit_toritsugi: null }, "取次店")).toBeNull();
  });
});

/* ───────────────────── attachRewards（商品マスタ単価） ───────────────────── */

describe("attachRewards（payUnits を渡さない＝商品マスタの単価で計算）", () => {
  it("単価 × 数量で報酬額を出す", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "101", product_name: BODY, quantity: 2, amount: 370000 }],
      "2次代理店",
    );
    expect(o.unitReward).toBe(62700);
    expect(o.reward).toBe(125400);
  });

  it("数量が空・0 のときは1台として扱う", () => {
    const [none, zero] = attachRewards(
      [
        { ...UNITS, id: "1", product_name: BODY },
        { ...UNITS, id: "2", product_name: BODY, quantity: 0 },
      ],
      "販売代理店",
    );
    expect(none.quantity).toBe(1);
    expect(none.reward).toBe(55000);
    expect(zero.quantity).toBe(1);
    expect(zero.reward).toBe(55000);
  });

  it("単価が引けない受注は unitReward も reward も null（0 円にはしない）", () => {
    const [o] = attachRewards(
      [{ _unit_niji: null, id: "1", product_name: "対象外の商品", quantity: 3 }],
      "2次代理店",
    );
    expect(o.unitReward).toBeNull();
    expect(o.reward).toBeNull();
  });

  it("単価 0 の商品は 0 円として付く（単価未設定の null とは別扱い）", () => {
    // 取次店の 3年保証セットは商品マスタで 0 円。数量を掛けても 0 のまま。
    const [zero, unset] = attachRewards(
      [
        { ...UNITS, _unit_toritsugi: 0, id: "1", product_name: "3年保証セット", quantity: 2 },
        { ...UNITS, _unit_toritsugi: null, id: "2", product_name: "対象外", quantity: 2 },
      ],
      "取次店",
    );
    expect(zero.unitReward).toBe(0);
    expect(zero.reward).toBe(0);
    expect(unset.reward).toBeNull();
  });

  it("ランクが空文字なら、単価が載っていても報酬は null になる", () => {
    // rewards/notice/page.tsx:75 は実際に attachRewards(live, "") と呼ぶ（金額を出さない画面）。
    const [o] = attachRewards([{ ...UNITS, id: "1", product_name: BODY }], "");
    expect(o.reward).toBeNull();
  });

  it("金額・数量が文字列で来ても数値に直す", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, amount: "185000", quantity: "2" }],
      "販売代理店",
    );
    expect(o.amount).toBe(185000);
    expect(o.quantity).toBe(2);
    expect(o.reward).toBe(110000);
  });

  it("受注行の列名を Order の項目名に読み替える", () => {
    const [o] = attachRewards(
      [
        {
          ...UNITS,
          id: "9001",
          ordered_on: "2026-08-20",
          customer_name: "鈴木",
          product_name: BODY,
          amount: 185000,
          quantity: 1,
          phone: "090-1111-2222",
          ship_status: "出荷済",
          shipped_on: "2026-08-21",
          delivered_on: "2026-08-23",
          payment_method: "銀行振込",
          payment_status: "着金待ち",
          match_status: "一致",
          agency_code: "MENO",
          niji_code: "RIM0002",
          tracking_no: "1234-5678-9012",
        },
      ],
      "取次店",
    );
    expect(o.recordId).toBe("9001");
    expect(o.date).toBe("2026-08-20");
    expect(o.customerName).toBe("鈴木");
    expect(o.shippingStatus).toBe("出荷済");
    expect(o.shippedAt).toBe("2026-08-21");
    expect(o.deliveredAt).toBe("2026-08-23");
    expect(o.paymentStatus).toBe("着金待ち");
    expect(o.secondaryCode).toBe("RIM0002");
    expect(o.trackingNo).toBe("1234-5678-9012");
    expect(o.reward).toBe(27500);
  });

  it("値の入っていない列は空文字にする（null も undefined も画面に出さない）", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, customer_name: null, tracking_no: undefined }],
      "取次店",
    );
    expect(o.customerName).toBe("");
    expect(o.trackingNo).toBe("");
    expect(o.deliveredAt).toBe("");
  });

  it("担当（ownerCode）は 取次の紹介コード → スタッフ本人 → 代理店コード の順で決まる", () => {
    const [byReferrer, byStaff, byAgency] = attachRewards(
      [
        {
          ...UNITS,
          id: "1",
          referrer_code: "TORI0001",
          staff_code: "MENO0002",
          agency_code: "MENO",
        },
        { ...UNITS, id: "2", staff_code: "MENO0002", agency_code: "MENO" },
        { ...UNITS, id: "3", agency_code: "MENO" },
      ],
      "取次店",
    );
    expect(byReferrer.ownerCode).toBe("TORI0001");
    expect(byStaff.ownerCode).toBe("MENO0002");
    expect(byAgency.ownerCode).toBe("MENO");
  });

  it("空配列を渡せば空配列を返す", () => {
    expect(attachRewards([], "2次代理店")).toEqual([]);
  });
});

/* ───────────────────── attachRewards（payUnits 優先） ───────────────────── */

describe("attachRewards（payUnits を渡す＝上位が決めた支払額を優先）", () => {
  it("含まれる品目の額を足して税込にする（本体+OP①+OP② = 51,500 → 56,650）", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY_OP1_OP2, quantity: 1 }],
      "販売代理店",
      PAY_UNITS,
    );
    expect(o.reward).toBe(56650);
    expect(o.unitReward).toBe(56650);
  });

  it("数量ぶん掛けてから税込にする（2台なら 113,300、単価表示は 56,650）", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY_OP1_OP2, quantity: 2 }],
      "販売代理店",
      PAY_UNITS,
    );
    expect(o.reward).toBe(113300);
    expect(o.unitReward).toBe(56650);
  });

  it("税込への換算は四捨五入（999 → 1,099。切り捨てなら 1,098 になる）", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, quantity: 1 }],
      "販売代理店",
      { body: 999, op1: null, op2: null, padYearly: null },
    );
    expect(o.reward).toBe(1099);
    expect(o.unitReward).toBe(1099);
  });

  it("単価表示の丸めも四捨五入（733 ÷ 2台 → 367。切り捨てなら 366 になる）", () => {
    /*
     * 税込への換算（payTaxIncl）と、単価表示（税込 ÷ 数量）の丸めは別物。
     * 上のテストは数量1で割り切れるため payTaxIncl 側しか押さえていない。
     * ここは割り切れない組み合わせを使って、attachRewards が持つ
     * 2つ目の丸めが四捨五入であることを固定する。
     *   333 × 2台 = 666 → 税込 733。733 ÷ 2 = 366.5 → 単価は 367。
     * 切り捨てにすると 366 になり、支払通知書の単価が1円ずつ小さく出る。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, quantity: 2 }],
      "販売代理店",
      { body: 333, op1: null, op2: null, padYearly: null },
    );
    expect(o.reward).toBe(733);
    expect(o.unitReward).toBe(367);
  });

  it("パッド単体・保証単体の受注は本体抜きで計算する", () => {
    const [pad, warranty] = attachRewards(
      [
        { ...UNITS, id: "1", product_name: "単体／追加パッド(１年分)", quantity: 1 },
        { ...UNITS, id: "2", product_name: "単体／追加保証(３年分)", quantity: 1 },
      ],
      "販売代理店",
      PAY_UNITS,
    );
    expect(pad.reward).toBe(550);
    expect(warranty.reward).toBe(1100);
  });

  it("本体の支払額が未設定なら payUnits を使わず、商品マスタの単価に戻る", () => {
    /*
     * 本番の _unit_hanbai は「本体＋OP①」の合成行から引かれることがあるため、
     * ここで OP のぶんが消えるとは限らない。確かなのは
     * 「本体の額が決まっていない＝payUnits では出さない」という分岐だけ。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: "VIS本体 ／ ジェルパッド1年分", quantity: 1 }],
      "販売代理店",
      { body: null, op1: 500, op2: 1000, padYearly: 500 },
    );
    expect(o.reward).toBe(55000);
    expect(o.unitReward).toBe(55000);
  });

  it("OP の額が未設定（null）でも、本体さえ決まっていれば 0 円として足す", () => {
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY_OP1_OP2, quantity: 1 }],
      "販売代理店",
      { body: 25000, op1: null, op2: null, padYearly: null },
    );
    expect(o.reward).toBe(27500);
  });

  it("総販売代理店・2次代理店に渡しても payUnits が優先される", () => {
    /*
     * orders.ts の説明文には「総販・2次には既定を置いていないため、
     * その2ランクは渡しても商品マスタのままになる」とあるが、これは
     * pay-defaults.ts に推奨額が入った 2026-08-27 以降は成り立たない。
     * 渡せば商品マスタ（77,000 / 62,700）ではなく payUnits の額が出る。
     */
    const [so] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, quantity: 1 }],
      "総販売代理店",
      { body: 80000, op1: null, op2: null, padYearly: null },
    );
    expect(so.reward).toBe(88000);

    const [niji] = attachRewards(
      [{ ...UNITS, id: "2", product_name: BODY, quantity: 1 }],
      "2次代理店",
      { body: 60000, op1: null, op2: null, padYearly: null },
    );
    expect(niji.reward).toBe(66000);
  });

  it("総販・2次の推奨額は、税込にすると今は商品マスタと一致する（ずれたら気づけるように固定）", () => {
    /*
     * 70,000 × 1.1 = 77,000（amount_so）、57,000 × 1.1 = 62,700（amount_niji）。
     * 一致しているのは推奨額がそう決められているからで、自動ではそろわない。
     * pay-defaults.ts の推奨額を動かすと、payUnits を渡すダッシュボードだけが
     * 商品マスタから乖離する。ここが赤くなったら、その乖離を承知のうえで直すこと。
     */
    const row = [{ ...UNITS, id: "1", product_name: BODY, quantity: 1 }];
    const [so] = attachRewards(row, "総販売代理店", defaultPayUnits(agency({ rank: "総販売代理店" })));
    const [niji] = attachRewards(row, "2次代理店", defaultPayUnits(agency({ rank: "2次代理店" })));
    expect(so.reward).toBe(UNITS._unit_so);
    expect(niji.reward).toBe(UNITS._unit_niji);
  });

  it("数量が空・0 でも1台として計算する（単価表示も出る）", () => {
    // 実データには数量が入っていない受注がある。単価の欄が「—」にならないこと。
    const [none, zero] = attachRewards(
      [
        { ...UNITS, id: "1", product_name: BODY },
        { ...UNITS, id: "2", product_name: BODY, quantity: 0 },
      ],
      "販売代理店",
      PAY_UNITS,
    );
    expect(none.reward).toBe(55000);
    expect(none.unitReward).toBe(55000);
    expect(zero.reward).toBe(55000);
    expect(zero.unitReward).toBe(55000);
  });

});

/* ───────────────────── listOrders（問い合わせの組み立て） ───────────────────── */

describe("listOrders（受注を取りに行くときの問い合わせ）", () => {
  it("コードが1つも無ければ、保存先に問い合わせず空で返す", async () => {
    /*
     * ここで止めないと in.() の中身が空になり、条件として成立しないまま
     * 全代理店の受注を引いてしまう（他社の顧客名・電話番号が画面に出る）。
     */
    stubDb([{ id: "1" }], [P_BODY_FEE]);
    await expect(listOrders([])).resolves.toEqual({ orders: [], raw: [] });
    await expect(listOrders(["", "   ", "\t"])).resolves.toEqual({ orders: [], raw: [] });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("コードは前後の空白を落とし、空のものを除いてから in.() に入れる", async () => {
    const q = await queryOf([" MENO ", "", "MENO0001", "   "]);
    expect(q).toContain('agency_code.in.("MENO","MENO0001")');
  });

  it("agency / niji / referrer / staff の4列すべてを or で見る", async () => {
    /*
     * staff_code を落とすと、スタッフ（区分02）本人がログインしても
     * 自分の受注が1件も出てこない（売上の付け先は所属会社になるため）。
     * 実際にダッシュボードが「今月の受注 0件」のままになった本番バグ。
     */
    const q = await queryOf(["MENO"]);
    expect(q).toContain(
      'or=(agency_code.in.("MENO"),niji_code.in.("MENO"),referrer_code.in.("MENO"),staff_code.in.("MENO"))',
    );
  });

  it("コードに含まれるダブルクォートはエスケープしてから渡す", async () => {
    /*
     * コードには利用者が入れた文字がそのまま来ることがある（受注の ?ref= など）。
     * エスケープしないと in.() の文字列を抜け出し、
     * 誰にいくら払うかの元になる問い合わせを外から書き換えられる。
     */
    const q = await queryOf(['ME"NO']);
    expect(q).toContain('agency_code.in.("ME\\"NO")');
    expect(q).not.toContain('in.("ME"NO")');
  });

  it("並び順は受注日の新しい順、同じ日は受注番号の大きい順", async () => {
    // id まで指定しないと同じ日の並びが決まらず、さっき入った注文が下に出る（2026-08-31 の修正）。
    const q = await queryOf(["MENO"]);
    expect(q).toContain("order=ordered_on.desc,id.desc");
  });

  it("月を指定しなければ日付では絞らない（全期間）", async () => {
    const q = await queryOf(["MENO"]);
    expect(q).not.toContain("gte.");
    expect(q).not.toContain("lte.");
  });

  it("月を指定すると、その月の1日から末日までで絞る", async () => {
    const q = await queryOf(["MENO"], { month: "2026-08" });
    expect(q).toContain("ordered_on=gte.2026-08-01");
    expect(q).toContain("ordered_on=lte.2026-08-31");
  });

  it("問い合わせ全体の形（組み立ての順番まで固定する）", async () => {
    const q = await queryOf(["MENO", "MENO0001"], { month: "2026-08" });
    expect(q).toBe(
      "orders?select=*" +
        '&or=(agency_code.in.("MENO","MENO0001"),niji_code.in.("MENO","MENO0001"),' +
        'referrer_code.in.("MENO","MENO0001"),staff_code.in.("MENO","MENO0001"))' +
        "&order=ordered_on.desc,id.desc" +
        "&ordered_on=gte.2026-08-01&ordered_on=lte.2026-08-31",
    );
  });

  it("月初は必ずその月の01日（月をまたいで前月ぶんを拾わない）", async () => {
    expect(await queryOf(["MENO"], { month: "2026-01" })).toContain("ordered_on=gte.2026-01-01");
    expect(await queryOf(["MENO"], { month: "2026-12" })).toContain("ordered_on=gte.2026-12-01");
    // 1桁の月は0を足して2桁にする。
    expect(await queryOf(["MENO"], { month: "2026-9" })).toContain("ordered_on=gte.2026-09-01");
  });

  it("月末はその月の日数で決まる（30日・31日・2月・うるう年）", async () => {
    /*
     * ここが1か月ずれると、8月の売上に9月ぶんが混ざる（報酬の二重計上）か、
     * 2月の末日が「2月31日」という存在しない日付になって1件も引けなくなる。
     */
    expect(await queryOf(["MENO"], { month: "2026-08" })).toContain("ordered_on=lte.2026-08-31");
    expect(await queryOf(["MENO"], { month: "2026-09" })).toContain("ordered_on=lte.2026-09-30");
    expect(await queryOf(["MENO"], { month: "2026-02" })).toContain("ordered_on=lte.2026-02-28");
    expect(await queryOf(["MENO"], { month: "2028-02" })).toContain("ordered_on=lte.2028-02-29");
    expect(await queryOf(["MENO"], { month: "2026-12" })).toContain("ordered_on=lte.2026-12-31");
  });

  it('basis:"delivered" は配達完了日で切る（売上・報酬・支払通知書）', async () => {
    /*
     * 2026-08-26 の決定。受注日で切ると、月をまたいで配達されたぶんが
     * 支払通知書と売上画面で食い違う。
     */
    const q = await queryOf(["MENO"], { month: "2026-08", basis: "delivered" });
    expect(q).toContain("delivered_on=gte.2026-08-01");
    expect(q).toContain("delivered_on=lte.2026-08-31");
    expect(q).not.toContain("ordered_on=gte.");
    expect(q).not.toContain("ordered_on=lte.");
  });

  it('basis を省略・"order" のときは受注日で切る（顧客一覧・ダッシュボード）', async () => {
    for (const opts of [{ month: "2026-08" }, { month: "2026-08", basis: "order" as const }]) {
      const q = await queryOf(["MENO"], opts);
      expect(q).toContain("ordered_on=gte.2026-08-01");
      expect(q).toContain("ordered_on=lte.2026-08-31");
      expect(q).not.toContain("delivered_on=");
    }
  });

  it("商品マスタは引き当てに必要な列だけを取る", async () => {
    const queries = stubDb([], []);
    await listOrders(["MENO"]);
    expect(queries).toContain(`products?select=${PRODUCT_COLUMNS}`);
  });
});

/* ───────────────────── listOrders（単価の引き当て） ───────────────────── */

describe("listOrders（受注1件ごとに商品マスタの単価を載せる）", () => {
  it("商品マスタに当たった受注には、ランク別の単価を4列とも載せる", async () => {
    const queries = stubDb(
      [{ id: "101", product_name: P_BODY_FEE["name"], amount: 188300, quantity: 1 }],
      [P_BODY_FEE],
    );
    const { orders, raw } = await listOrders(["MENO"]);
    expect(ordersQuery(queries)).toContain("orders?select=*");
    expect(raw[0]["_unit_so"]).toBe(77000);
    expect(raw[0]["_unit_niji"]).toBe(62700);
    expect(raw[0]["_unit_hanbai"]).toBe(55000);
    expect(raw[0]["_unit_toritsugi"]).toBe(27500);
    // orders 側は列名を読み替えた形（報酬は attachRewards が別に付ける）。
    expect(orders[0].recordId).toBe("101");
    expect(orders[0].amount).toBe(188300);
    // raw をそのまま attachRewards に渡せば金額が出る（画面はこの流れで使う）。
    expect(attachRewards(raw, "販売代理店")[0].reward).toBe(55000);
  });

  it("報酬対象外の商品は、金額列に値が入っていても単価を載せない", async () => {
    /*
     * 事務手数料のような対象外の商品に単価が付くと、
     * 報酬が丸ごと過大計上される（払わなくてよい額を払う）。
     */
    const queries = stubDb(
      [{ id: "102", product_name: "事務手数料", amount: 3300, quantity: 1 }],
      [P_FEE_ONLY],
    );
    const { raw } = await listOrders(["MENO"]);
    expect(ordersQuery(queries)).toContain("orders?select=*");
    expect(raw[0]["_unit_so"]).toBeNull();
    expect(raw[0]["_unit_niji"]).toBeNull();
    expect(raw[0]["_unit_hanbai"]).toBeNull();
    expect(raw[0]["_unit_toritsugi"]).toBeNull();
    expect(attachRewards(raw, "販売代理店")[0].reward).toBeNull();
  });

  it("台数ぶんまとめて決済された受注も、内訳に分解して単価を引ける（数量を引き当てに渡している）", async () => {
    /*
     * 商品マスタに無い組み合わせは ./product-match が内訳へ分解し、
     * 拾った商品の税込合計を決済額と突き合わせて初めて採用する。
     * 突き合わせは「1台ぶん」か「1台ぶん × 台数」のどちらかに合えばよい形なので、
     * listOrders が受注の数量を渡していないと、2台まとめて決済された受注
     * （199,300 × 2 = 398,600）は突き合わせに失敗して単価が引けず、
     * 報酬が丸ごと「—」になる。数量を 1 に固定してもここが赤くなる。
     */
    stubDb(
      [
        {
          id: "104",
          product_name: `${P_BODY_FEE["name"]} ／ 3年保証セット`,
          amount: 398600,
          quantity: 2,
        },
      ],
      [P_BODY_FEE, P_WARRANTY],
    );
    const { raw } = await listOrders(["MENO"]);
    expect(raw[0]["_unit_hanbai"]).toBe(56100);
    expect(raw[0]["_unit_toritsugi"]).toBe(27500);
    expect(attachRewards(raw, "販売代理店")[0].reward).toBe(112200);
  });

  it("商品マスタに無い商品も単価なし（0円にはしない）", async () => {
    stubDb([{ id: "103", product_name: "未登録の商品", amount: 1000, quantity: 1 }], [P_BODY_FEE]);
    const { raw } = await listOrders(["MENO"]);
    expect(raw[0]["_unit_hanbai"]).toBeNull();
    expect(attachRewards(raw, "販売代理店")[0].reward).toBeNull();
  });

  it("受注が0件なら空で返す（商品マスタは引いても行は増えない）", async () => {
    stubDb([], [P_BODY_FEE]);
    await expect(listOrders(["MENO"])).resolves.toEqual({ orders: [], raw: [] });
  });
});

/* ───────────────────────── summarize ───────────────────────── */

describe("summarize（ダッシュボードの月次サマリー）", () => {
  /*
   * ship_status は supabase/part2.sql の CHECK 制約で
   * 出荷待ち / 出荷手配中 / 出荷済 / キャンセル の4つに限られる。
   * 「配達完了」は受注の ship_status には入らない（配達完了日の有無で判断する）。
   */
  const orders = [
    order({ recordId: "1", quantity: 1, amount: 185000, reward: 62700, shippingStatus: "出荷済" }),
    order({ recordId: "2", quantity: 2, amount: 370000, reward: 125400, shippingStatus: "出荷手配中" }),
    order({ recordId: "3", quantity: 0, amount: 13200, reward: 1100, shippingStatus: "出荷待ち" }),
  ];

  it("件数・台数・売上・報酬を合計する（数量0は1台として数える）", () => {
    const s = summarize(orders, "2026-08");
    expect(s.month).toBe("2026-08");
    expect(s.orderCount).toBe(3);
    expect(s.unitCount).toBe(4);
    expect(s.salesTotal).toBe(568200);
    expect(s.rewardTotal).toBe(189200);
  });

  it("出荷済の件数は「出荷済」の完全一致だけを数える", () => {
    expect(summarize(orders, "2026-08").shippedCount).toBe(1);
    expect(summarize([order({ shippingStatus: "キャンセル" })], "2026-08").shippedCount).toBe(0);
  });

  it("「出荷済」で始まるだけの値は数えない（前方一致ではなく完全一致）", () => {
    /*
     * いまの CHECK 制約（出荷待ち / 出荷手配中 / 出荷済 / キャンセル）の中では
     * この4値以外は入らないので、完全一致と前方一致の区別は表に出ない。
     * それでも固定しておくのは、状況の選択肢を増やすときに
     * 「出荷済み」「出荷済（一部）」を足した瞬間、集計が黙って変わるため。
     * 前方一致に変えると、この2件が出荷済に混ざって件数が増える。
     */
    const s = summarize(
      [
        order({ recordId: "1", shippingStatus: "出荷済" }),
        order({ recordId: "2", shippingStatus: "出荷済み" }),
        order({ recordId: "3", shippingStatus: "出荷済（一部）" }),
        order({ recordId: "4", shippingStatus: "" }),
      ],
      "2026-08",
    );
    expect(s.shippedCount).toBe(1);
  });

  it("報酬が null の受注が1件でもあれば、合計は null になる", () => {
    const withNull = [orders[0], order({ recordId: "9", reward: null }), orders[1]];
    expect(summarize(withNull, "2026-08").rewardTotal).toBeNull();
  });

  it("null が先頭にあっても合計は null（途中までの金額は残らない）", () => {
    const nullFirst = [order({ recordId: "9", reward: null }), orders[0]];
    expect(summarize(nullFirst, "2026-08").rewardTotal).toBeNull();
  });

  it("null で打ち切っても、件数・台数・売上はすべての受注ぶん数える", () => {
    // 報酬だけが「—」になり、件数や売上は欠けない。
    const s = summarize([order({ recordId: "9", reward: null, amount: 100, quantity: 2 }), orders[0]], "2026-08");
    expect(s.rewardTotal).toBeNull();
    expect(s.orderCount).toBe(2);
    expect(s.unitCount).toBe(3);
    expect(s.salesTotal).toBe(185100);
  });

  it("受注が0件のときは、報酬合計が null ではなく 0 になる", () => {
    /*
     * 0件で 0 円。単価が引けるかどうかは canComputeReward が別に判定するので、
     * ここは件数0を「金額不明」にしない割り切りとして残す。
     */
    const s = summarize([], "2026-08");
    expect(s.orderCount).toBe(0);
    expect(s.unitCount).toBe(0);
    expect(s.salesTotal).toBe(0);
    expect(s.shippedCount).toBe(0);
    expect(s.rewardTotal).toBe(0);
  });

  it("報酬が 0 円の受注は 0 として足す（null 扱いにはしない）", () => {
    const s = summarize([order({ reward: 0 }), order({ recordId: "2", reward: 55000 })], "2026-08");
    expect(s.rewardTotal).toBe(55000);
  });

  it("数量が負の受注は、そのまま負の台数として引く（1台に切り上げない）", () => {
    /*
     * 数量0を1台と数える補正（quantity || 1）は 0 のときだけ効く。
     * 負の数量は補正されず、台数も売上もマイナスのまま合計に入る。
     * ここを Math.max(quantity, 1) のような下限つきに変えると、
     * 返品・訂正で入った -1 台が +1 台に化けて台数が2台ぶん水増しされる。
     */
    const s = summarize(
      [
        order({ recordId: "1", quantity: 2, amount: 370000, reward: 110000 }),
        order({ recordId: "2", quantity: -1, amount: -185000, reward: -55000 }),
      ],
      "2026-08",
    );
    expect(s.unitCount).toBe(1);
    expect(s.salesTotal).toBe(185000);
    expect(s.rewardTotal).toBe(55000);
    expect(summarize([order({ quantity: -3 })], "2026-08").unitCount).toBe(-3);
  });
});

/* ───────────────────────── scopeCodes ───────────────────────── */

describe("scopeCodes（自分＋配下のコード一覧）", () => {
  it("自分のコードを先頭に、配下のコードを並べる", () => {
    expect(
      scopeCodes(agency({ code: "MENO" }), [
        agency({ code: "MENO0001" }),
        agency({ code: "MENO0002" }),
      ]),
    ).toEqual(["MENO", "MENO0001", "MENO0002"]);
  });

  it("配下がいなければ自分だけ", () => {
    expect(scopeCodes(agency({ code: "MENO" }), [])).toEqual(["MENO"]);
  });
});

/* ───────────────────── recentMonths / currentMonth ───────────────────── */

describe("recentMonths（直近Nか月を新しい順に返す）", () => {
  it("指定した月数ぶんを新しい順に返す", () => {
    expect(recentMonths(3, new Date(Date.UTC(2026, 7, 15)))).toEqual(["2026-08", "2026-07", "2026-06"]);
  });

  it("1月をまたぐと前年の12月に戻る", () => {
    expect(recentMonths(3, new Date(Date.UTC(2026, 0, 15)))).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("12か月ぶんでも前年へ正しく続く", () => {
    const months = recentMonths(12, new Date(Date.UTC(2026, 8, 10)));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-09");
    expect(months[8]).toBe("2026-01");
    expect(months[9]).toBe("2025-12");
    expect(months[11]).toBe("2025-10");
  });

  it("31日を起点にしても月が飛ばない（5月31日 → 2月まで正しく戻る）", () => {
    expect(recentMonths(4, new Date(Date.UTC(2026, 4, 31)))).toEqual([
      "2026-05",
      "2026-04",
      "2026-03",
      "2026-02",
    ]);
  });

  it("月は2桁でそろえる", () => {
    expect(recentMonths(1, new Date(Date.UTC(2026, 0, 1)))).toEqual(["2026-01"]);
  });

  it("0以下を渡すと空配列", () => {
    expect(recentMonths(0, new Date(Date.UTC(2026, 7, 15)))).toEqual([]);
    expect(recentMonths(-3, new Date(Date.UTC(2026, 7, 15)))).toEqual([]);
  });

  it("引数を省略すると現在時刻を使う", () => {
    // 日付ずれと混ざらないよう、日本時間でも同じ月になる時刻を使う（8/15 21:00 JST）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    expect(recentMonths(2)).toEqual(["2026-08", "2026-07"]);
  });
});

describe("currentMonth（今月を YYYY-MM で返す）", () => {
  it("渡した日付の月を返す", () => {
    expect(currentMonth(new Date(Date.UTC(2026, 7, 26, 12)))).toBe("2026-08");
  });

  it("1桁の月は0を足して2桁にする", () => {
    expect(currentMonth(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01");
  });

  it("引数を省略すると現在時刻を使う", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    expect(currentMonth()).toBe("2026-08");
  });
});

/* ───────────────── effectiveRank / canComputeReward ───────────────── */

describe("effectiveRank（報酬単価を引くときの実際のランク）", () => {
  it("ランク＝取次店 ＋ 販路種別＝販売代理店 は3次（販売代理店）として扱う", () => {
    expect(effectiveRank(agency({ rank: "取次店", channel: "販売代理店" }))).toBe("販売代理店");
  });

  it("ランク＝取次店 でも販路種別が違えば取次店のまま", () => {
    expect(effectiveRank(agency({ rank: "取次店", channel: "サロン提携パートナー（取次）" }))).toBe("取次店");
    expect(effectiveRank(agency({ rank: "取次店", channel: "未設定" }))).toBe("取次店");
    expect(effectiveRank(agency({ rank: "取次店", channel: "サロン代理店" }))).toBe("取次店");
  });

  it("エリア統括（2次代理店 ＋ 販売代理店）は2次のまま。3次の単価に落とさない", () => {
    expect(effectiveRank(agency({ rank: "2次代理店", channel: "販売代理店" }))).toBe("2次代理店");
  });

  it("総販売代理店は販路種別に関わらずそのまま", () => {
    expect(effectiveRank(agency({ rank: "総販売代理店", channel: "販売代理店" }))).toBe("総販売代理店");
  });

  it("ランクが未設定なら空文字を返す", () => {
    expect(effectiveRank(agency({ rank: "", channel: "販売代理店" }))).toBe("");
  });
});

describe("canComputeReward（1台あたりの報酬額を出せるか）", () => {
  it("4ランクのどれかに当てはまれば出せる", () => {
    expect(canComputeReward(agency({ rank: "総販売代理店" }))).toBe(true);
    expect(canComputeReward(agency({ rank: "2次代理店" }))).toBe(true);
    expect(canComputeReward(agency({ rank: "取次店", channel: "未設定" }))).toBe(true);
    expect(canComputeReward(agency({ rank: "取次店", channel: "販売代理店" }))).toBe(true);
  });

  it("ランクが未設定なら出せない", () => {
    expect(canComputeReward(agency({ rank: "" }))).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────
 * 既知の欠陥（仕様ではない）
 * ここは「現在こう動いてしまう」ことの記録。実装を修正したらこのブロックごと更新する。
 * 通っていることは正しさを意味しない。
 * ───────────────────────────────────────────────────────────── */
describe("既知の欠陥（仕様ではない・修正時はこのブロックごと更新する）", () => {
  it("【欠陥】同じ受注の報酬額が、payUnits を渡す画面と渡さない画面で食い違う", () => {
    /*
     * 本来は「この受注の報酬額」を出す入口を1本にして、どの画面からでも
     * 同じ額が出るようにすべき（画面側でランクと payUnits を組み立てさせない）。
     * dashboard/page.tsx:140 は payUnits を渡し、rewards/page.tsx:314 は渡さない。
     * 上位が「金額修正」で額を上書きした代理店では、同一代理店の同一受注に
     * ダッシュボードは 49,500 円、報酬画面は 55,000 円と、5,500 円違う額が出る。
     * どちらが払う額なのか画面からは判断できず、利用者に見える食い違いになっている。
     */
    const row = [{ ...UNITS, id: "1", product_name: BODY, quantity: 1 }];
    const self = agency({ rank: "取次店", channel: "販売代理店", payUnit: 45000 });
    const [dashboard] = attachRewards(row, "販売代理店", effectivePayUnits(self));
    const [rewardsPage] = attachRewards(row, "販売代理店");
    expect(dashboard.reward).toBe(49500);
    expect(rewardsPage.reward).toBe(55000);
    expect(dashboard.reward).not.toBe(rewardsPage.reward); // 本来は一致すべき
  });

  it("【欠陥】数量が負の受注は、単価が「—」なのに報酬額だけマイナスで合計に入る", () => {
    /*
     * 本来は数量が負の受注を「金額を出せない」＝ reward も null にして
     * 合計から外すか、そもそもデータ側で弾くべき。
     * 実装は単価だけ「数量が正のとき」に絞っているため、
     * 画面の単価欄は「—」なのに報酬額は -55,000 円と出る。
     * この額は summarize の rewardTotal にそのまま足し込まれるので、
     * 返品・訂正で入った1件が支払通知の合計を静かに減らす。
     * 単価 × 数量 = 報酬額 も成り立たなくなっている。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, quantity: -1 }],
      "販売代理店",
      PAY_UNITS,
    );
    expect(o.unitReward).toBeNull(); // 本来は報酬額と矛盾しない値にすべき
    expect(o.reward).toBe(-55000); // 本来は null にして合計から外すべき
    expect(summarize([o], "2026-08").rewardTotal).toBe(-55000);
  });

  it("【欠陥】品目に当たらない商品名（事務手数料）は、商品マスタに単価があっても 0 円になる", () => {
    /*
     * 本来は「支払額を出せない」＝ null（画面は「—」）にすべき。
     * payItemsOf("事務手数料") が [] を返し、payoutForOrder が
     * items.includes("body") を通らないまま 0 を返すため、
     * attachRewards の if (paid !== null) が 0 を採用してしまう。
     * 商品マスタに 55,000 円があっても捨てられ、ダッシュボード
     * （dashboard/page.tsx:140 が payUnits を渡す）に「0円」と静かに出る。
     * キーワード未登録の新商品名でも同じことが起きる。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: "事務手数料", quantity: 1 }],
      "販売代理店",
      PAY_UNITS,
    );
    expect(o.reward).toBe(0);
    expect(o.unitReward).toBe(0);
  });

  it("【欠陥】単価表示は税込を数量で割って丸めるので、単価 × 数量が報酬額と1円合わない", () => {
    /*
     * 本来は 単価 × 数量 = 報酬額 になるべき
     * （先に1台あたりを丸めてから数量を掛けるか、明細に端数行を出す）。
     * 333 × 3 = 999 → 税込 1,099。1,099 ÷ 3 = 366.33… → 単価は 366 と出て、
     * 366 × 3 = 1,098 と縦計が1円ずれる。
     * 現行の推奨額（50000/25000/500/1000）はどれも 1.1 倍で割り切れるため表面化していないだけで、
     * 端数のある額を金額修正で入れた時点で支払通知書の縦計が崩れる。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, quantity: 3 }],
      "販売代理店",
      { body: 333, op1: null, op2: null, padYearly: null },
    );
    expect(o.reward).toBe(1099);
    expect(o.unitReward).toBe(366);
    expect((o.unitReward as number) * o.quantity).toBe(1098);
  });

  it("【欠陥】recentMonths が UTC 起点なので、日本時間 9/1 の未明は当月が候補に出ない", () => {
    /*
     * 本来は jst.ts の thisMonthInJapan と同じ日本時間基準で数え始めるべき
     * （CLAUDE.md「日時は必ず jst.ts を通す」）。
     * 日本時間で毎月1日 00:00〜08:59 のあいだ、月選択のドロップダウンに
     * 実際の当月が1つも並ばず、手で選ぶこともできない。
     */
    const jst0030 = new Date("2026-09-01T00:30:00+09:00");
    expect(thisMonthInJapan(jst0030)).toBe("2026-09"); // 本来はこちらを先頭にすべき
    expect(recentMonths(2, jst0030)).toEqual(["2026-08", "2026-07"]);
  });

  it("【欠陥】currentMonth が UTC 起点なので、日本時間 9/1 08:30 に先月を返す", () => {
    /*
     * 本来は thisMonthInJapan を返すべき。
     * 日本時間で毎月1日 00:00〜08:59 のあいだ、画面の「今月」ラベルが先月を指す。
     * basis:"delivered" の売上・報酬画面は、本部が日本時間で手入力した
     * delivered_on を UTC の月境界で切るため、その9時間ぶんを取りこぼす。
     */
    const jst0830 = new Date("2026-09-01T08:30:00+09:00");
    expect(thisMonthInJapan(jst0830)).toBe("2026-09"); // 本来はこちら
    expect(currentMonth(jst0830)).toBe("2026-08");
  });

  it("【欠陥】effectiveRank はコード区分02（スタッフ）を見ないため、pay-defaults と判定が食い違う", () => {
    /*
     * 本来は pay-defaults.ts の effectiveRankOf と同じ判定にすべき
     * （区分02 は staffType で 取次店／販売代理店 に振り分ける）。
     * 同じ「実際のランク」を名乗る関数が、同じ代理店に別の答えを返している。
     * いまは rewards/page.tsx が showReward = !isStaff で列を隠しているため
     * 表には出ないが、どちらかを参照する画面が増えた瞬間に金額が食い違う。
     */
    const staff = agency({ rank: "取次店", channel: "未設定", codeKind: "02", staffType: "販売代理店" });
    expect(effectiveRank(staff)).toBe("取次店"); // 本来は「販売代理店」
    expect(defaultPayUnits(staff).body).toBe(50000); // pay-defaults は販売代理店として 50,000 円を出す
  });

  it("【欠陥】ランク未設定のスタッフは報酬額を出せない扱いになる", () => {
    /*
     * 本来は区分02のスタッフなら pay-defaults と同じく販売代理店として扱い、
     * 「出せる」と判定すべき。支払額は 50,000 円と決まっているのに
     * 画面には「—」が出て、支払通知が作れないまま払い漏れる。
     */
    const staff = agency({ rank: "", codeKind: "02", staffType: "販売代理店" });
    expect(canComputeReward(staff)).toBe(false); // 本来は true
    expect(defaultPayUnits(staff).body).toBe(50000);
  });

  it("【欠陥】単価が空文字だと null ではなく 0 円になる", () => {
    /*
     * 本来は「単価が決まっていない」＝ null（画面は「—」）を返すべき。
     * Number("") が 0 になるのをそのまま通している。
     * 商品マスタの列は integer なので本番の listOrders 経由では到達しないが、
     * 「0円」と「—」を取り違える形の欠陥なので記録しておく。
     */
    expect(unitRewardFor({ _unit_hanbai: "" }, "販売代理店")).toBe(0);
  });

  it("【欠陥】数値に直せない文字列は NaN を返す（null にならない）", () => {
    /*
     * 本来は数値にできない値は null にして「—」を出すべき。
     * NaN のまま数量を掛けると、報酬額の欄に NaN が出る。
     */
    const v = unitRewardFor({ _unit_toritsugi: "対象外" }, "取次店");
    expect(Number.isNaN(v)).toBe(true);

    const [o] = attachRewards(
      [{ _unit_toritsugi: "対象外", id: "1", product_name: BODY, quantity: 2 }],
      "取次店",
    );
    expect(Number.isNaN(o.reward as number)).toBe(true);
  });

  it("【欠陥】桁区切り入りの金額文字列は黙って 0 円になる", () => {
    /*
     * 本来は桁区切りを外して数値にするか、変換できない値として弾くべき。
     * Number("185,000") が NaN → || 0 で 0 になるため、売上合計が静かに減る。
     * amount は integer 列なので本番の PostgREST 経由では到達しないが、
     * 「エラーにならず金額だけ消える」形の欠陥なので記録しておく。
     */
    const [o] = attachRewards(
      [{ ...UNITS, id: "1", product_name: BODY, amount: "185,000", quantity: 1 }],
      "販売代理店",
    );
    expect(o.amount).toBe(0);
    expect(summarize([o], "2026-08").salesTotal).toBe(0);
  });
});
