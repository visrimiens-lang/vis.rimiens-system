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
 * B2クラウドの「送り状発行データ取込」は、初回に画面で項目の対応づけを
 * 行う（任意フォーマット取込）。見出し行の名前をB2の項目名に合わせてあるので、
 * 対応づけはほぼ自動で埋まる。一度作ったパターンは保存されるので、
 * 2回目からはファイルを選ぶだけで取り込める。
 */

/** 見出し。B2クラウドの項目名にそろえてある。 */
const HEADERS = [
  "お客様管理番号",
  "送り状種類",
  "クール区分",
  "出荷予定日",
  "お届け先電話番号",
  "お届け先郵便番号",
  "お届け先住所",
  "お届け先名",
  "ご依頼主電話番号",
  "ご依頼主郵便番号",
  "ご依頼主住所",
  "ご依頼主名",
  "品名1",
  "個数",
  "請求先顧客コード",
  "請求先分類コード",
  "運賃管理番号",
];

/** CSVの1マス。カンマ・改行・引用符が入っても壊れないようにする。 */
function cell(v: string): string {
  const s = (v ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export type CsvOrder = OutboundOrder & { quantity: number };

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
  const lines = [HEADERS.map(cell).join(",")];
  for (const o of orders) {
    lines.push(
      [
        o.orderId, // お客様管理番号。発行結果と受注を突き合わせる鍵になる
        "0", // 送り状種類：発払い
        "0", // クール区分：なし
        shipDate, // YYYYMMDD
        o.phone,
        o.zip.replace(/[^0-9]/g, ""),
        o.address,
        o.name,
        cfg.shipper.tel,
        cfg.shipper.zip,
        cfg.shipper.address,
        cfg.shipper.name,
        cfg.itemName,
        String(o.quantity > 0 ? o.quantity : 1),
        cfg.invoiceCode,
        cfg.invoiceCodeExt,
        cfg.invoiceFreightNo,
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
