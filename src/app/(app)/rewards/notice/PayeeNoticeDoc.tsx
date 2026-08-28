/**
 * 御支払通知書。
 *
 * 統括代理店が、配下（スタッフ・取次店）へ「今月いくらお支払いします」を
 * 渡すための1枚。画面をそのまま印刷するのではなく、
 * 支払通知として通用する体裁で組み直している
 * （2026-08-26・実際に使われている様式に合わせた）。
 *
 * 金額の考え方
 *   単価 × 台数 ＝ 小計（税抜）
 *   小計 × 10%  ＝ 消費税
 *   小計 ＋ 消費税 ＝ お支払金額
 * 支払額は税抜きで持っているので（2026-08 会議「金額は税抜きで統一」）、
 * ここで消費税を足して総額を出す。
 */

export type NoticeLine = {
  /** 品目に出す文字。例「販売委託手数料（VIS本体）」 */
  item: string;
  unit: number | null;
  qty: number;
  amount: number | null;
};

export type NoticeDoc = {
  /**
   * 支払う相手（宛先）。
   * 登録番号と振込口座は載せない（2026-08-26・お互い分かっているため）。
   */
  to: { name: string };
  /**
   * 支払う側（発行元＝ログインしている代理店）。
   * 登録番号は宛先の側に載せるので、ここには持たない。
   */
  from: { name: string; zip: string; address: string; tel: string };
  /** 件名。例「2026年8月度 販売委託手数料」 */
  subject: string;
  issuedOn: string;
  lines: NoticeLine[];
};

const TAX_RATE = 0.1;

/**
 * 書類に載せる日付。"2026-08-26" → "2026年8月26日"。
 * 画面用の jpDate は「8/26」と年を落とすので、書面には使えない。
 */
function docDate(v: string): string {
  const d = v.slice(0, 10).split("-");
  if (d.length !== 3) return v;
  return `${d[0]}年${Number(d[1])}月${Number(d[2])}日`;
}
/** 罫線を引く最低行数。少ない件数でも様式が崩れないように空行で埋める。 */
const MIN_ROWS = 12;

const yen = (n: number | null): string => (n === null ? "—" : n.toLocaleString("ja-JP"));

export function PayeeNoticeDoc({ doc }: { doc: NoticeDoc }) {
  /*
   * 支払額が決まっていない品目が1つでもあれば、合計を数字で出さない。
   *
   * 以前は null を 0 として足していた。数量は実数のまま出るので、
   * 「3台ぶんお支払いします」と読めるのに金額にはその3台が入っていない、
   * という書面が相手に渡ってしまう。売上・報酬の画面はすでに
   * 「1人でも単価が分からなければ合計を出さない」に直してあるので、
   * 実際に相手へ渡るこちらも同じ決まりに揃える。
   */
  const hasMissing = doc.lines.some((l) => l.amount === null);
  const subtotal = hasMissing ? null : doc.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  const tax = subtotal === null ? null : Math.floor(subtotal * TAX_RATE);
  const total = subtotal === null || tax === null ? null : subtotal + tax;
  const blanks = Math.max(0, MIN_ROWS - doc.lines.length);

  return (
    <div className="notice-doc">
      <h1 className="notice-title">御 支 払 通 知 書</h1>

      {/* 宛先から御支払金額まではひとかたまり。紙が2枚になっても、ここは割らない */}
      <div className="notice-keep">
        <div className="notice-head">
          <div className="notice-to">
            <div className="notice-to-name">{doc.to.name}　御中</div>
          </div>

          <div className="notice-from">
            <div className="notice-from-name">{doc.from.name}</div>
            {doc.from.zip ? <div className="notice-small">〒{doc.from.zip}</div> : null}
            {doc.from.address ? <div className="notice-small">{doc.from.address}</div> : null}
            {doc.from.tel ? <div className="notice-small">TEL：{doc.from.tel}</div> : null}
          </div>
        </div>

        <div className="notice-dates">
          <div>発行日：　{docDate(doc.issuedOn)}</div>
          <div>振込日：　—</div>
        </div>

        <div className="notice-subject">
          <div>
            <span className="notice-subject-label">件名：</span>
            {doc.subject}
          </div>
        </div>

        <div className="notice-total-line">
          <span className="notice-total-label">御支払金額</span>
          <span className="notice-total-value">
            {total === null ? "—" : `¥${yen(total)}`}
          </span>
        </div>
      </div>

      <table className="notice-table">
        <thead>
          <tr>
            <th className="c-item">品目</th>
            <th className="c-num">単価</th>
            <th className="c-num">数量</th>
            <th className="c-num">価格</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i} className={i % 2 === 1 ? "shade" : ""}>
              <td>{l.item}</td>
              <td className="c-num">{l.unit === null ? "—" : yen(l.unit)}</td>
              <td className="c-num">{l.qty}</td>
              <td className="c-num">{l.amount === null ? "—" : yen(l.amount)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <tr key={`b${i}`} className={(doc.lines.length + i) % 2 === 1 ? "shade" : ""}>
              <td>&nbsp;</td>
              <td className="c-num">&nbsp;</td>
              <td className="c-num">0</td>
              <td className="c-num">0</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="notice-foot">
        {/* この断りは書面の中に置く。画面だけの注意書きは紙に出ないため */}
        {hasMissing ? (
          <div className="notice-warn">
            ※ 支払額が決まっていない品目があるため、金額は確定していません。
          </div>
        ) : null}
        <table className="notice-sum">
          <tbody>
            <tr>
              <th>小計</th>
              <td className="c-num">{yen(subtotal)} 円</td>
            </tr>
            <tr>
              <th>消費税</th>
              <td className="c-num">{yen(tax)} 円</td>
            </tr>
            <tr className="grand">
              <th>合計</th>
              <td className="c-num">{yen(total)} 円</td>
            </tr>
            <tr>
              <th>内訳</th>
              <td className="c-num">
                <span className="notice-inner">10%対象</span>
                {yen(subtotal)} 円
              </td>
            </tr>
            <tr>
              <th />
              <td className="c-num">
                <span className="notice-inner">消費税</span>
                {yen(tax)} 円
              </td>
            </tr>
            <tr>
              <th />
              <td className="c-num">
                <span className="notice-inner">8%（軽減税率）対象</span>0 円
              </td>
            </tr>
            <tr>
              <th />
              <td className="c-num">
                <span className="notice-inner">消費税</span>0 円
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/*
        インボイス（適格請求書）の但し書き。
        契約書と条件表に同じ文言が載っている。書面にも同じことが書いていないと、
        適格請求書発行事業者でない方に消費税分まで払ったように読めてしまう。
      */}
      <p className="notice-terms">
        ※ 適格請求書発行事業者でない場合、消費税相当額はお支払いの対象外とし、
        税抜金額にて精算いたします。
      </p>
    </div>
  );
}
