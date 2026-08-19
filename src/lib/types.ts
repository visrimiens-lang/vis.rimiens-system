/** 代理店の階層。kintone App9「代理店ランク」に対応する。 */
export type AgencyRank = "総販売代理店" | "2次代理店" | "取次店";

/** 販路種別。取次店ランクの中身を分ける。 */
export type SalesChannel =
  | "サロン提携パートナー（取次）"
  | "サロン代理店"
  | "個人販売パートナー"
  | "販売代理店"
  | "未設定";

/** 代理店コードの区分。00=正規代理店 / 01=取次パートナー / 02=スタッフ */
export type CodeKind = "00" | "01" | "02" | "";

export type Agency = {
  recordId: string;
  code: string;
  name: string;
  representative: string;
  rank: AgencyRank | "";
  channel: SalesChannel | "";
  codeKind: CodeKind;
  parentCode: string;
  parentName: string;
  area: string;
  email: string;
  phone: string;
  status: string;
  slotLimit: number;
  /** 販路種別ごとの枠上限。0 は未設定（既定値で扱う）。 */
  slotLimits: {
    販売代理店枠上限: number;
    サロン代理店枠上限: number;
    個人代理店枠上限: number;
    取次店枠上限: number;
  };
  slotUsed: number;
  slotRequestStatus: string;
  specialSlot: boolean;
  registeredVia: string;
  createdAt: string;
  qr1Url: string;
  qr2Url: string;
  /**
   * 上位からこの代理店に払う1台あたりの報酬額。
   * null なら商品マスタのランク別単価を使う（既定）。
   */
  payUnit: number | null;
  /** 既定と変えた理由（インボイス未登録、個別契約など）。 */
  payUnitNote: string;
};

export type Order = {
  recordId: string;
  date: string;
  customerName: string;
  productName: string;
  amount: number;
  quantity: number;
  phone: string;
  shippingStatus: string;
  shippedAt: string;
  paymentMethod: string;
  matchStatus: string;
  agencyCode: string;
  secondaryCode: string;
  referrerCode: string;
  trackingNo: string;
  /** 表示上の「担当」= 取次紹介コード があればそれ、無ければ代理店コード */
  ownerCode: string;
};

export type RewardRow = {
  recordId: string;
  orderNo: string;
  productName: string;
  quantity: number;
  targetMonth: string;
  status: string;
  paidAt: string;
  holderCode: string;
  holderRank: string;
  amount: number;
};

/** ログインしている人の種別 */
export type Viewer =
  | { kind: "hq"; label: string }
  | { kind: "agency"; label: string; code: string; rank: AgencyRank | ""; recordId: string };

/** 組織図のノード */
export type OrgNode = {
  agency: Agency;
  children: OrgNode[];
};
