import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";

/**
 * 本部専用画面の砦。
 * 各ページ側でも同じ判定をしているが、本部画面を1枚足したときの
 * 書き忘れで代理店マスタが丸ごと見えてしまうため、ここで必ず止める。
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");
  return <>{children}</>;
}
