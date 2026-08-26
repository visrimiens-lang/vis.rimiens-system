"use client";

import { Printer } from "lucide-react";

/**
 * この画面をPDFにする。
 *
 * サーバー側でPDFを組み立てず、ブラウザの印刷機能を使う。
 * 印刷の画面で「送信先」を「PDFに保存」にすれば、そのままファイルになる。
 * こうしている理由は3つ。
 *   ・画面に出ている絞り込みの結果が、そのまま同じ見た目で出る
 *   ・日本語のフォントを別途持たなくてよい（PDF生成ライブラリだと文字化けする）
 *   ・お客様の環境（Mac・Windows・iPad）でそのまま動く
 *
 * 印刷したときの体裁は globals.css の @media print で整えてある。
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:border-gold-500 hover:text-gold-300"
      title="印刷の画面で「PDFに保存」を選ぶとPDFになります"
    >
      <Printer className="h-3.5 w-3.5" />
      PDFで保存・印刷
    </button>
  );
}
