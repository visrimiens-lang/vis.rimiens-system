import "server-only";

/**
 * JotForm から届いた内容を取り出す。
 *
 * Webhook で受けたときと、受信箱から取り込み直すときで
 * 取り出し方が違うと「直したはずなのに再取り込みでは直らない」が起きるため、
 * 判定はこの1か所に集めて両方から使う。
 */

type Row = Record<string, unknown>;

function normalizeKey(k: string): string {
  return k.replace(/^q\d+_/, "");
}

/*
 * JotForm が申込内容とは別に付けてくる、送信元の情報。
 *
 * 照合の対象から外す。名前の一部でも一致とみなす作りなので、
 * "name" を探すと username（JotForm のアカウント名）に当たってしまう。
 * 実際 2026-08-19 の代理店システム登録では、会社名を拾えなかった結果
 * 申込者の名前が「visrimiens」（アカウント名）として登録されかけていた。
 */
const JOTFORM_META_KEYS = new Set([
  "username", "formID", "formTitle", "submitSource", "buildDate", "slug", "path",
  "type", "event_id", "timeToSubmit", "submitDate", "uploadServerUrl",
  "eventObserver", "jsExecutionTracker", "validatedNewRequiredFieldIDs",
  "webhookURL", "ip", "pretty", "rawRequest", "appID", "parent", "action", "event",
]);

function pick(data: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    for (const [rawKey, v] of Object.entries(data)) {
      if (JOTFORM_META_KEYS.has(rawKey)) continue;
      const k = normalizeKey(rawKey);
      if (k === n || k.includes(n) || rawKey === n || rawKey.includes(n)) {
        if (v === null || v === undefined) continue;
        if (typeof v === "object") {
          const o = v as Record<string, unknown>;
          /*
           * 氏名は {first, last} で届く。
           *
           * JotForm の「姓／名」は、この4フォームでは first に姓、last に名が入る
           * （実際の申込 6629236644225492462 は first=東山 / last=和史）。
           * ここを逆に並べていたため「和史 東山」「純汰 東」のように
           * 姓名が入れ替わって登録され、承認メールの宛名も逆になっていた。
           */
          if (o.last || o.first) {
            const joined = [o.first, o.last].filter(Boolean).join(" ").trim();
            if (joined) return joined;
          }
          // 生年月日は {year, month, day}
          if (o.year && o.month && o.day) {
            const p2 = (x: unknown) => String(x).padStart(2, "0");
            return `${o.year}-${p2(o.month)}-${p2(o.day)}`;
          }
          // 電話は {full} や {area, phone}
          if (o.full) return String(o.full).trim();
          const flat = Object.values(o).filter(Boolean).join(" ").trim();
          if (flat) return flat;
          continue;
        }
        const s = String(v).trim();
        if (s) return s;
      }
    }
  }
  return "";
}

/**
 * JotForm が一緒に送ってくる pretty から「日本語ラベル → 値」を取り出す。
 *
 * ■ なぜこれが要るか
 *
 * JotForm の項目名は、フォームを作った人が名前を付けなければ
 * 「q43_input43」のような通し番号だけの名前で届く。
 * 実データ（2026-08-19 の取次パートナー登録）はこうだった:
 *   q6_input3=氏名 / q7_ka=フリガナ / q32_input32=メール / q43_input43=招待コード
 * このうち意味が読み取れるのは ka（フリガナ）だけで、招待コードは input43 としか名乗らない。
 * そのため名前で照合する pick では拾えず、招待コードが「未入力」と判定され、
 * 上位代理店が決まらないまま受信箱に取り込めない状態で溜まっていた。
 *
 * ところが JotForm は同じ内容を pretty にも入れてくれている:
 *   「名前:東山 和史, フリガナ:ヒガシヤマ カズシ, …, 招待コード:RIM, …」
 * ラベルは画面に出ている日本語そのものなので、こちらは意味が読み取れる。
 *
 * ■ 区切り方
 *
 * 値の中にも読点が入りうる（住所など）。「, 」で機械的に切ると壊れるので、
 * 直後が「ラベル:」の形になっている読点でだけ切る。
 */
function prettyPairs(pretty: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof pretty !== "string" || !pretty.trim()) return out;
  for (const part of pretty.split(/,\s*(?=[^,:]{1,40}:)/)) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const label = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (label && value) out[label] = value;
  }
  return out;
}


/**
 * 受信箱に残してある payload から項目を取り出す関数を作る。
 *
 * Webhook のときは form-data を開いた直後に pretty を混ぜているが、
 * 受信箱には混ぜる前の生の内容が入っていることがあるため、ここでも同じ処理をする。
 */
export function pickFromJotform(payload: Row): (...names: string[]) => string {
  const data: Row = { ...payload };
  const raw = data["rawRequest"];
  if (typeof raw === "string") {
    try {
      Object.assign(data, JSON.parse(raw) as Row);
    } catch {
      // JSON でなければそのまま使う
    }
  }
  for (const [label, value] of Object.entries(prettyPairs(data["pretty"]))) {
    if (!(label in data)) data[label] = value;
  }
  return (...names: string[]) => pick(data, ...names);
}

export { pick, prettyPairs, normalizeKey };
