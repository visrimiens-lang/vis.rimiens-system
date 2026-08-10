import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { Badge, Card, EmptyState, Notice, PageHeader, StatTile } from "@/components/ui";
import { jpFullDate } from "@/lib/content";
import {
  listAllNotices,
  noticesWritable,
  todayInJapan,
  type AdminNotice,
} from "@/lib/content-admin";
import { NoticeForm, NoticeRow } from "./NoticeForm";

export default async function AdminNoticesPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const writable = noticesWritable();
  const today = todayInJapan();

  let notices: AdminNotice[] = [];
  let loadError: string | null = null;

  if (writable) {
    try {
      notices = await listAllNotices();
    } catch (e) {
      loadError =
        e instanceof Error
          ? e.message
          : "お知らせの一覧を読み込めませんでした。時間をおいてもう一度お試しください。";
    }
  }

  const published = notices.filter((n) => n.published);
  const drafts = notices.filter((n) => !n.published);
  const importantCount = published.filter((n) => n.important).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="お知らせの配信"
        description="代理店ポータルの「お知らせ」に載せる内容をここで作ります。公開すると、ログイン中の代理店の画面にすぐ反映されます。"
        actions={
          writable && !loadError ? (
            <Badge tone={published.length > 0 ? "good" : "neutral"}>
              公開中 {published.length} 件
            </Badge>
          ) : null
        }
      />

      {!writable ? (
        <Notice tone="bad">
          お知らせの保存先がまだ設定されていないため、この画面から登録できません。
          <br />
          サーバーの設定に「保存先のアドレス」と「書き込み用キー」を登録すると使えるようになります。
          設定はシステム担当者の作業です。本部からご連絡ください。
        </Notice>
      ) : null}

      {loadError ? (
        <Notice tone="bad">
          お知らせの一覧を読み込めませんでした。{loadError}
          <br />
          しばらく待ってから画面を読み込み直してください。続くようであればシステム担当者にご連絡ください。
        </Notice>
      ) : null}

      {writable && !loadError ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="公開中"
            value={String(published.length)}
            unit="件"
            hint="代理店の画面に出ています"
          />
          <StatTile
            label="重要として掲載中"
            value={String(importantCount)}
            unit="件"
            tone={importantCount > 0 ? "gold" : "default"}
            hint="代理店の一覧で先頭に固定されます"
          />
          <StatTile
            label="下書き"
            value={String(drafts.length)}
            unit="件"
            hint="本部だけが見られます"
          />
        </div>
      ) : null}

      {writable ? (
        <Card title="新しいお知らせを作る">
          <NoticeForm defaultDate={today} />
        </Card>
      ) : null}

      {writable && !loadError ? (
        <>
          <Card title="公開中のお知らせ">
            {published.length === 0 ? (
              <EmptyState
                title="公開中のお知らせはありません"
                description="上のフォームで登録し、「代理店に公開する」にチェックを入れると、ここに並びます。"
              />
            ) : (
              <ul className="divide-y divide-ink-850">
                {published.map((n) => (
                  <NoticeRow
                    key={n.id}
                    notice={n}
                    dateLabel={jpFullDate(n.publishedAt)}
                    defaultDate={today}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Card title="下書き（代理店には表示されていません）">
            {drafts.length === 0 ? (
              <EmptyState
                title="下書きはありません"
                description="登録するときに「代理店に公開する」のチェックを外すと、ここに保存されます。書きかけの内容を置いておく場所です。"
              />
            ) : (
              <ul className="divide-y divide-ink-850">
                {drafts.map((n) => (
                  <NoticeRow
                    key={n.id}
                    notice={n}
                    dateLabel={jpFullDate(n.publishedAt)}
                    defaultDate={today}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Notice tone="info">
            公開したお知らせは、すべての代理店に同じ内容が表示されます。特定の代理店だけに伝えたい内容は、
            この画面ではなく個別にご連絡ください。
          </Notice>
        </>
      ) : null}
    </div>
  );
}
