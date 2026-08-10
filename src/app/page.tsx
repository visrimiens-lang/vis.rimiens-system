import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";

export default async function Home() {
  const viewer = await currentViewer();
  redirect(viewer ? "/dashboard" : "/login");
}
