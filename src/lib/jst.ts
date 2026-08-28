/**
 * 日本時間の日付。
 *
 * サーバー（Vercel）は世界標準時で動いている。
 * new Date().toISOString() をそのまま使うと、日本の午前0時〜9時のあいだは
 * 前日の日付になる。書類の発行日・報酬の確定日・成約日がずれるので、
 * 「今日」を決めるときは必ずここを通す。
 *
 * 同じ処理があちこちに写し取られていたのを1か所にまとめたもの。
 * ＋9時間する書き方もあったが、時間帯の指定に任せるほうが確実。
 */

const JST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日本時間での今日（"2026-08-26" の形）。 */
export function todayInJapan(now: Date = new Date()): string {
  return JST.format(now);
}

/** 日本時間での今月（"2026-08" の形）。 */
export function thisMonthInJapan(now: Date = new Date()): string {
  return todayInJapan(now).slice(0, 7);
}

/**
 * 日本時間での日時（"2026-08-28 19:08" の形）。
 *
 * データベースの timestamptz は世界標準時の文字列で返る。
 * そのまま先頭16文字を切って画面に出すと9時間ずれた時刻になるので、
 * 「いつ操作したか」を見せるときは必ずここを通す。
 * 読めない値が来たら、そのまま返して画面を壊さない。
 */
const JST_DATETIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function jpDateTime(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return JST_DATETIME.format(d).replace(/\//g, "-");
}
