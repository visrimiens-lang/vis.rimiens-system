import { NextRequest, NextResponse } from "next/server";
import { selectOne } from "@/lib/db";

/**
 * 「このご案内リンク（?ref=代理店コード）は今も使ってよいか」を返す。
 *
 * QR を止めても、URL 自体は UTAGE のページなので、リンクを知っていれば
 * 開けて決済までできてしまう。決済ページのカスタムJSがここに問い合わせて、
 * 止めた相手のリンクなら「ご利用いただけません」の画面に切り替える。
 *
 * ■ 返すのは使えるかどうかだけ
 *
 * 決済ページ（別ドメイン）から合言葉なしで呼ぶため、名前などの情報は返さない。
 * コードの状態（使える/使えない）以上のことは分からないようにする。
 *
 * ■ 迷ったら通す（fail-open）
 *
 * この確認が落ちていても決済は通す。門番の故障で正規のお客様の決済を
 * 止めるほうが、被害が大きいため。止まるのは
 * 「コードが実在して、かつ QR停止中 か 停止・解約」のときだけ。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 決済ページのドメインだけに応答を読ませる。 */
const ALLOW_ORIGIN = "https://line.metore0403.com";

/**
 * 停止（凍結）の目印。
 * ★ actions/qr-actions.ts・admin/staff・QrPanel と同じ文字列。必ず全部そろえること。
 */
const FREEZE_MARK = "【QR停止】";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get("ref") ?? "").trim();
  // コードが無い・長すぎる・変な文字 → 判定できないので通す
  if (!ref || ref.length > 20 || !/^[A-Za-z0-9_-]+$/.test(ref)) {
    return cors(NextResponse.json({ ok: true, usable: true }));
  }

  try {
    const a = await selectOne<Record<string, unknown>>(
      `agencies?select=status,qr2_status,qr2_rejected_note&code=eq.${encodeURIComponent(ref)}`,
    );
    // 知らないコードは通す（打ち間違いで正規の決済を止めない。帰属は要確認に落ちる）
    if (!a) return cors(NextResponse.json({ ok: true, usable: true }));

    const frozen =
      String(a["qr2_status"] ?? "") === "差戻し" &&
      String(a["qr2_rejected_note"] ?? "").startsWith(FREEZE_MARK);
    const retired = String(a["status"] ?? "") === "停止・解約";

    return cors(NextResponse.json({ ok: true, usable: !(frozen || retired) }));
  } catch {
    // 確認できないときは通す（fail-open）
    return cors(NextResponse.json({ ok: true, usable: true }));
  }
}
