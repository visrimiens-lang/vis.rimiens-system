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
  /**
   * この代理店が属する組織の英字（自社代理店コード）。半角大文字4文字。
   * 会社は自分自身、配下の取次パートナー・スタッフはその会社の英字が入る。
   * 配下のコードはこの英字＋4桁で採番される。
   */
  orgCode: string;
  parentCode: string;
  parentName: string;
  /**
   * 所属している会社の名前。
   * エリア統括の下のスタッフが「どこの会社の人か」を表す（2026-08-22〜）。
   * 会社そのものの行では空。空のときは parentName を代わりに出す。
   */
  companyName: string;
  /**
   * スタッフの種別（販売代理店／サロン代理店／個人販売代理店）。
   * エリア統括代理店が管理画面で設定する。申込フォームからは送られてこない。
   * 販路種別（channel）とは別物。channel を変えると報酬の単価が動くため分けてある。
   */
  staffType: string;
  area: string;
  email: string;
  phone: string;
  /** 支払通知書に出す住所・振込先・登録番号（2026-08-26 追加） */
  zip: string;
  address: string;
  invoiceNo: string;
  bankName: string;
  bankBranch: string;
  accountType: string;
  accountNo: string;
  accountHolder: string;
  status: string;
  /**
   * 直下に登録できるスタッフの上限（2026-08-22〜）。
   * 0 は「上限なし」。既定は100名。
   */
  staffLimit: number;
  /**
   * 販路種別ごとの枠上限（2026-08-22 より前の持ち方）。
   * 枠はスタッフ1本にまとめたので、いまは本部の操作記録を読むためだけに残している。
   */
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
  qr2Status: string;
  qr2RejectedNote: string;
  trainingStatus: string;
  qr2Url: string;
  /**
   * 上位からこの代理店に払う1台あたりの報酬額。
   * null なら推奨の税抜単価（lib/pay-defaults.ts）を使う（既定）。
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
  /** 配達が完了した日。売上・報酬はこの日付の月で数える。 */
  deliveredAt: string;
  paymentMethod: string;
  matchStatus: string;
  agencyCode: string;
  secondaryCode: string;
  referrerCode: string;
  /** 売ったスタッフ本人のコード。スタッフ以外が売ったときは空。 */
  staffCode: string;
  trackingNo: string;
  /** 表示上の「担当」= 取次紹介コード → スタッフ本人 → 代理店コード の順で決まる */
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
