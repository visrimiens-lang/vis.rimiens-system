import { redirect } from "next/navigation";

/**
 * 旧「スタッフコード」の画面。
 *
 * 同じ内容（スタッフ一覧・所属・QRの停止）を代理店管理のスタッフタブで
 * 見られるようになったため、画面をひとつにまとめた。
 * 配布済みの資料やブックマークから開かれても迷子にならないよう、
 * ここは移動先へ送るだけにしてある。
 */
export default function StaffCodesPage() {
  redirect("/admin/agencies?tab=staff");
}
