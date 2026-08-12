import { NextRequest, NextResponse } from "next/server";

/**
 * 先行公開の期間中、本部の画面（/admin）の存在を伏せる。
 *
 * 代理店向けの画面だけを先に公開し、本部側（kintone の置き換え）は
 * あとから公開する段取りのため。
 *
 * なぜここでやるか:
 *   画面の中の判定（admin/layout.tsx）だけだと、未ログインの人には
 *   その手前の共通レイアウトが働いてログイン画面へ転送してしまう。
 *   存在しないURLは404が返るので、「転送された＝何かある」と分かってしまう。
 *   ここで先回りして、存在しないURLとまったく同じ404を返す。
 *
 * ここでの判定は「隠すかどうか」だけで、権限の確認ではない。
 * 本当の砦は admin/layout.tsx と各ページの currentViewer() 側にあり、
 * ここを通り抜けても本部以外は必ず止まる。
 * そのため署名の検証まではせず、中身を見るだけにしている。
 *
 * HIDE_ADMIN=1 のときだけ働く。設定を外せば元どおり。
 */

const HIDE_ADMIN = process.env.HIDE_ADMIN === "1";
const COOKIE = "vis_session";

/** そのセッションが本部のものかどうかを、ざっと見る。 */
function looksLikeHq(token: string | undefined): boolean {
  if (!token) return false;
  const body = token.split(".")[0];
  if (!body) return false;
  try {
    const json = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { v?: { kind?: string } };
    return json.v?.kind === "hq";
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (!HIDE_ADMIN) return NextResponse.next();
  if (looksLikeHq(req.cookies.get(COOKIE)?.value)) return NextResponse.next();

  // 存在しないURLと同じ見え方にする
  return NextResponse.rewrite(new URL("/_not-found", req.url), { status: 404 });
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
