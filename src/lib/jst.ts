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
