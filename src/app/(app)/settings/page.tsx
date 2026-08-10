import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { Card, Notice, PageHeader } from "@/components/ui";
import { PasswordForm } from "./PasswordForm";

export default async function SettingsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  return (
    <div className="space-y-6">
      <PageHeader
        title="アカウント設定"
        description={`${viewer.label}（${viewer.code}）のログイン情報を管理します。`}
      />

      <Notice tone="info">
        本部から受け取ったパスワードのままお使いの場合は、ここでご自身のものに変更してください。
        変更後は本部もパスワードを知らない状態になります。
      </Notice>

      <Card title="パスワードの変更">
        <PasswordForm />
      </Card>
    </div>
  );
}
