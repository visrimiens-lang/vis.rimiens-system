import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { findAgencyByCode } from "@/lib/agencies";
import { Card, Notice, PageHeader } from "@/components/ui";
import { PasswordForm } from "./PasswordForm";
import { ContactForm } from "./ContactForm";

export default async function SettingsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "agency") redirect("/admin/agencies");

  /*
   * 連絡先のいまの値。読めなくてもパスワードの変更はできるようにしておく
   * （連絡先の欄だけを出さない）。
   */
  let me = null;
  let loadError = "";
  try {
    me = await findAgencyByCode(viewer.code);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "読み込みに失敗しました。";
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="アカウント設定"
        description={`${viewer.label}（${viewer.code}）のログイン情報と連絡先を管理します。`}
      />

      <Card title="連絡先">
        {me ? (
          <>
            <div className="border-b border-ink-800 px-5 py-4 text-sm leading-relaxed text-ink-300">
              ご登録の郵便番号・住所・電話番号を、この画面で直せます。
              法人名・メールアドレス・振込先は本部で管理しているため、
              変更が必要なときは本部にご連絡ください。
            </div>
            <ContactForm
              zip={me.zip ?? ""}
              address={me.address ?? ""}
              phone={me.phone ?? ""}
            />
          </>
        ) : (
          <div className="px-5 py-5">
            <Notice tone="bad">
              ご登録内容を読み込めませんでした。{loadError}
              <br />
              しばらく待っても直らない場合は、本部にお問い合わせください。
            </Notice>
          </div>
        )}
      </Card>

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
