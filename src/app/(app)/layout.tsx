import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { Sidebar } from "@/components/layout/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar
        viewerLabel={viewer.label}
        viewerCode={viewer.kind === "agency" ? viewer.code : undefined}
        isHq={viewer.kind === "hq"}
      />
      <main className="min-w-0 flex-1 bg-ink-950">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
