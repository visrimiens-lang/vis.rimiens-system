import { NextRequest, NextResponse } from "next/server";
import { insert, select } from "@/lib/db";
import { normalizeCode, normalizePhone } from "@/lib/intake";

/**
 * 決済ページで読み取った紹介コードを控えておく。
 *
 * ■ なぜ要るか
 *
 * 代理店のQRは …?ref=MENO0001 の形で配るが、UTAGE はこの ?ref= を
 * 決済の通知に載せてくれない。実際に届く内容にキー ref は無く、
 * そのため受注の「誰の売上か」が空のまま入る。
 *
 * 決済ページのカスタムJSは ?ref= を読めているので、
 * お客様が連絡先を入れた時点でここに控えを送る。
 * 決済の通知が届いたら、メールアドレスか電話番号で突き合わせて
 * 売上の付け先を決める（src/app/api/webhooks/order/route.ts）。
 *
 * ■ 合言葉は付けない
 *
 * 決済ページは誰でも開けるので、合言葉を置いても JS に書いた時点で
 * 誰でも読める。代わりに次の3つで守る。
 *   ・受け付けるのは決済ページのドメインからだけ（CORS）
 *   ・実在する代理店コードでなければ捨てる
 *   ・同じ連絡先の控えが短時間に増えすぎたら受け付けない
 *
 * それでも「他人のメールアドレスで自分のコードを控えさせる」ことは
 * 理屈のうえでは可能だが、突き合わせに使うのは
 * 「受注に付け先が入っていないとき」だけなので、
 * 正しく ?ref= が付いた受注が横取りされることはない。
 * 万一おかしな付け先になっても、本部が受注の画面から入れ直せる。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW_ORIGIN = "https://line.metore0403.com";

/** 同じ連絡先で、この件数を超えたら受け付けない（いたずら対策） */
const MAX_PER_CONTACT = 20;

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "content-type");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return cors(NextResponse.json({ ok: false }, { status: 400 }));
  }

  const ref = normalizeCode(String(body["ref"] ?? ""));
  const email = String(body["email"] ?? "").trim().slice(0, 200).toLowerCase();
  const phone = normalizePhone(String(body["phone"] ?? ""));

  // どちらの連絡先も無ければ、あとで突き合わせようがない
  if (!ref || (!email && !phone)) {
    return cors(NextResponse.json({ ok: false }, { status: 400 }));
  }
  if (!/^[A-Z0-9-]{1,20}$/.test(ref)) {
    return cors(NextResponse.json({ ok: false }, { status: 400 }));
  }

  try {
    // 実在するコードでなければ控えない（打ち間違いといたずらを弾く）
    const known = await select<Record<string, unknown>>(
      `agencies?select=code&code=eq.${encodeURIComponent(ref)}`,
    );
    if (known.length === 0) {
      return cors(NextResponse.json({ ok: true, stored: false }));
    }

    // 同じ連絡先の控えが増えすぎていたら受け付けない
    const filter = email
      ? `email=eq.${encodeURIComponent(email)}`
      : `phone=eq.${encodeURIComponent(phone)}`;
    const existing = await select<Record<string, unknown>>(
      `ref_claims?select=id&${filter}&limit=${MAX_PER_CONTACT + 1}`,
    );
    if (existing.length > MAX_PER_CONTACT) {
      return cors(NextResponse.json({ ok: true, stored: false }));
    }

    await insert("ref_claims", [{ ref, email: email || null, phone: phone || null }]);
    return cors(NextResponse.json({ ok: true, stored: true }));
  } catch {
    // 控えられなくても決済は続けてもらう
    return cors(NextResponse.json({ ok: true, stored: false }));
  }
}
