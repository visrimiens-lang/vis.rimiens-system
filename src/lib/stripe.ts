import "server-only";

/**
 * Stripe を直接呼ぶ小さな道具。
 *
 * ■ なぜ UTAGE を介さないか
 *
 * 「本体を買ったら、1年後（OP①を付けた方は2年後）から毎年17,500円の
 * 定期パッド配送が自動で始まる」が会議の決定（2026-08-27）。
 * UTAGE の継続課金は「初回の金額を2回目以降より高くできない」制約があり、
 * 本体188,300円＋以降17,500円/年を1つの決済にまとめられない。
 * そこで決済そのものは今までどおり UTAGE（Stripe）で行い、
 * 定期の契約だけをポータルが Stripe に直接作る。
 *
 * ■ なぜ公式SDKを使わないか
 *
 * 使うのは5種類の呼び出しだけで、そのために依存を増やさない。
 * Stripe の REST API はフォーム形式の単純な作りで、fetch で足りる。
 */

const API = "https://api.stripe.com/v1";

export function stripeConfigured(): boolean {
  return Boolean((process.env.STRIPE_SECRET_KEY ?? "").trim());
}

function key(): string {
  const k = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!k) throw new Error("STRIPE_SECRET_KEY が設定されていません。");
  return k;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stripe が返すエラー種別（resource_missing など） */
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * ネストした値を Stripe のフォーム形式（items[0][price]=... ）に直す。
 */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          out.push(...encode(item as Record<string, unknown>, `${name}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof v === "object") {
      out.push(...encode(v as Record<string, unknown>, name));
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

type Row = Record<string, unknown>;

export async function stripeReq(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, unknown>,
): Promise<Row> {
  const body = params ? encode(params).join("&") : "";
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method !== "GET" && body ? body : undefined,
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) {
    const err = (json["error"] ?? {}) as Row;
    throw new StripeError(
      String(err["message"] ?? `Stripe が ${res.status} を返しました。`),
      res.status,
      String(err["code"] ?? err["type"] ?? ""),
    );
  }
  return json;
}
