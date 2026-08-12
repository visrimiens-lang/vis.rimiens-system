import { notFound, redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";

/**
 * 本部専用画面の砦。
 * 各ページ側でも同じ判定をしているが、本部画面を1枚足したときの
 * 書き忘れで代理店マスタが丸ごと見えてしまうため、ここで必ず止める。
 *
 * ★ 先行公開の期間中は、本部画面の存在自体を伏せる。
 *   代理店向けの画面だけを先に公開し、本部側（kintone の置き換え）は
 *   あとから公開する段取りのため。
 *   本部のコードでログインしている人だけが今までどおり使えて、
 *   それ以外には「そんなURLは無い」と見える状態にしておく。
 *
 *   HIDE_ADMIN=1 のときだけこの扱いになる。設定を外せば元に戻る。
 */
const HIDE_ADMIN = process.env.HIDE_ADMIN === "1";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();

  if (HIDE_ADMIN) {
    /*
     * 伏せている間は、未ログインでも代理店でも同じ「404」を返す。
     * ログイン画面へ飛ばすと「ログインすれば何かある」と分かってしまい、
     * 代理店の画面へ飛ばすと「弾かれた＝何かある」と分かってしまうため、
     * どちらの手がかりも出さない。
     */
    if (!viewer || viewer.kind !== "hq") notFound();
    return <>{children}</>;
  }

  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");
  return <>{children}</>;
}
