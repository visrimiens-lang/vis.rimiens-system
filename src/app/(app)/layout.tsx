import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { Sidebar } from "@/components/layout/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");

  return (
    /*
     * lg 以上は「メニュー｜本文」の横並び。lg 未満は縦積み
     * （上部バー → 本文。メニューはドロワーで重ねて出す）。
     * 余白はスマホで詰め、画面が広がるほど広げる。
     */
    <div className="min-h-screen lg:flex">
      <Sidebar
        viewerLabel={viewer.label}
        viewerCode={viewer.kind === "agency" ? viewer.code : undefined}
        isHq={viewer.kind === "hq"}
      />
      <main className="min-w-0 flex-1 bg-ink-950">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
