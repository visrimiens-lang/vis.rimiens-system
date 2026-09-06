import "server-only";

import iconv from "iconv-lite";
import type { OutboundOrder, ShipperConfig } from "./yamato";

/**
 * B2クラウドに読ませる送り状データ（CSV）と、発行結果の取り込み。
 *
 * ■ なぜAPIとは別に用意するのか
 *
 * API連携（lib/yamato.ts）はヤマトとのAPI利用契約が要り、
 * APIアクセス認証キーとAPI連携会社コードが揃うまで使えない。
 * それまで送り状が1枚も出せないと出荷が止まるので、
 * 「こちらでCSVを書き出す → B2クラウドの画面で取り込んで発行 →
 * 発行結果のCSVをこちらに戻して伝票番号を入れる」でも回るようにする。
 * キーが揃えばボタンひとつのAPI発行に切り替わる。どちらも結果は同じ。
 *
 * ■ 文字コード
 *
 * B2クラウドの取込はShift_JIS・CRLFが前提。UTF-8のまま渡すと
 * 住所や名前が化けたまま送り状に印字されてしまうので、必ず変換する。
 *
 * ■ 列の並び
 *
 * B2クラウドの「外部データから発行」の基本レイアウト（固定の列順）に
 * そろえてある。以前は見出し付きの独自の並びで、B2側で初回に
 * 項目の対応づけ（任意フォーマット取込）をする前提だったが、
 * 現場は対応づけをせずそのまま取り込むため、全列が1つずつ
 * 別の項目に流れ込む事故が起きた（2026-09-07・銀座本店の発行）。
 * 基本レイアウトなら対応づけ不要で、ファイルを選ぶだけで通る。
 * 見出し行も付けない（B2の既定は1行目もデータとして読むため）。
 */

/** CSVの1マス。カンマ・改行・引用符が入っても壊れないようにする。 */
function cell(v: string): string {
  const s = (v ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export type CsvOrder = OutboundOrder & {
  quantity: number;
  productName: string;
  /** 建物名。B2では住所と別の「アパートマンション名」列に入れる */
  building?: string;
};

/**
 * 送り状に印字する品名。
 *
 * 中身と違う品名が付いていると、受け取った方が「頼んだものと違う」と思うし、
 * 事故があったときの照会もできない。パッドだけの買い足しに
 * 「眼筋トレーニングマシンVIS」と印字しないよう、商品名から出し分ける。
 * 全角25文字までという決まりがあるので、長い名前はそこで切る。
 */
export function itemNameFor(cfg: ShipperConfig, productName: string): string {
  const p = productName || "";
  const isPadOnly = /パッド|パット/.test(p) && !/本体/.test(p);
  const name = isPadOnly ? "ジェルパッド1年分" : cfg.itemName;
  return name.slice(0, 25);
}

/**
 * B2クラウド取込用のCSVを作る（Shift_JIS・CRLF）。
 *
 * 出荷予定日はB2側で「本日〜30日後」しか受け付けないので、呼び出し側で
 * 日本時間の日付を渡すこと。
 */
export function buildB2Csv(
  cfg: ShipperConfig,
  orders: CsvOrder[],
  shipDate: string,
): Buffer {
  // B2の基本レイアウトの日付は YYYY/MM/DD。YYYYMMDD や YYYY-MM-DD で来ても直す
  const d = shipDate.replace(/[^0-9]/g, "");
  const ship = `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;

  const lines: string[] = [];
  for (const o of orders) {
    lines.push(
      [
        o.orderId, // 1 お客様管理番号。発行結果と受注を突き合わせる鍵になる
        "0", // 2 送り状種類：発払い
        "0", // 3 クール区分：なし
        "", // 4 伝票番号（発行時にB2が採番する）
        ship, // 5 出荷予定日
        "", // 6 お届け予定日（指定しない）
        "", // 7 配達時間帯（指定しない）
        "", // 8 お届け先コード
        o.phone, // 9 お届け先電話番号
        "", // 10 電話番号枝番
        o.zip.replace(/[^0-9]/g, ""), // 11 お届け先郵便番号
        o.address, // 12 お届け先住所
        o.building ?? "", // 13 お届け先アパートマンション名
        "", // 14 会社・部門1
        "", // 15 会社・部門2
        o.name, // 16 お届け先名
        "", // 17 お届け先名(カナ)
        "様", // 18 敬称
        "", // 19 ご依頼主コード
        cfg.shipper.tel, // 20 ご依頼主電話番号
        "", // 21 電話番号枝番
        cfg.shipper.zip.replace(/[^0-9]/g, ""), // 22 ご依頼主郵便番号
        cfg.shipper.address, // 23 ご依頼主住所
        "", // 24 ご依頼主アパートマンション名
        cfg.shipper.name, // 25 ご依頼主名
        "", // 26 ご依頼主名(カナ)
        "", // 27 品名コード1
        itemNameFor(cfg, o.productName), // 28 品名1
        "", // 29 品名コード2
        "", // 30 品名2
        "", // 31 荷扱い1
        "", // 32 荷扱い2
        "", // 33 記事
        "", // 34 コレクト代金引換額
        "", // 35 内消費税額等
        "", // 36 止置き
        "", // 37 止置き営業所コード
        String(o.quantity > 0 ? o.quantity : 1), // 38 発行枚数（1箱1台なので台数ぶん）
        "", // 39 個数口表示フラグ
        cfg.invoiceCode, // 40 請求先顧客コード
        cfg.invoiceCodeExt, // 41 請求先分類コード
        cfg.invoiceFreightNo, // 42 運賃管理番号
      ]
        .map(cell)
        .join(","),
    );
  }
  return iconv.encode(lines.join("\r\n") + "\r\n", "Shift_JIS");
}

/* ══════════════════ 発行結果の取り込み ══════════════════ */

export type TrackingPair = { orderId: string; trackingNo: string };

/**
 * B2クラウドから出した発行結果を読んで、受注IDと伝票番号の組にする。
 *
 * 受け取る形は決め打ちにしない。B2の出力CSVをそのまま貼っても、
 * 「受注ID,伝票番号」の2列だけを貼っても通るようにする。
 * 実際の運用では、担当者が画面からコピーして貼る使い方が多いため。
 *
 *   ・伝票番号 … 10〜12桁の数字（ハイフンが入っていても外して見る）
 *   ・受注ID   … 同じ行にある、伝票番号ではない短い数字
 *
 * 1行から両方が読めなければ、その行は飛ばす（無理に当てはめない）。
 */
export function parseTracking(text: string): {
  pairs: TrackingPair[];
  skipped: string[];
} {
  const pairs: TrackingPair[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 見出し行は飛ばす
    if (/お客様管理番号|伝票番号|送り状番号|受注/.test(line) && !/\d{10}/.test(line)) {
      continue;
    }
    const cells = line
      .split(/[,\t]/)
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .filter((c) => c.length > 0);

    const numbers = cells
      .map((c) => c.replace(/[^0-9]/g, ""))
      .filter((c) => c.length > 0);

    /* 送り状番号は12桁。まず12桁を探す。
       先に「10〜12桁のどれか」で拾うと、桁合わせの0が付いた受注ID
       （0000000124 など）を送り状番号と取り違えるため、順番が大事。 */
    const tracking =
      numbers.find((n) => n.length === 12) ||
      numbers.find((n) => n.length >= 10 && n.length < 12 && !n.startsWith("0"));
    /* こちらの受注IDは小さい数。桁合わせの0が付いていることがあるので外して見る。 */
    const orderId = numbers
      .filter((n) => n !== tracking)
      .map((n) => n.replace(/^0+/, ""))
      .find((n) => n.length > 0 && n.length <= 9);
    if (!tracking || !orderId) {
      skipped.push(line.slice(0, 60));
      continue;
    }
    const key = `${orderId}:${tracking}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ orderId, trackingNo: tracking });
  }
  return { pairs, skipped };
}
