import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import {
  jpFullDate,
  listNotices,
  noticesConfigured,
  type Notice as NoticeRow,
} from "@/lib/content";

export default async function AnnouncementsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");

  // お知らせは本部・代理店のどちらから見ても同じ内容なので、種別では絞らない。
  const ready = noticesConfigured();

  let notices: NoticeRow[] = [];
  let error: string | null = null;

  if (ready) {
    try {
      notices = await listNotices();
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : "お知らせの読み込み中に問題が起きました。時間をおいて再度お試しください。";
    }
  }

  const importantCount = notices.filter((n) => n.important).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="お知らせ"
        description="本部からの連絡事項です。重要なお知らせは一覧の先頭に表示されます。"
      />

      {error ? (
        <Notice tone="bad">
          お知らせを読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、本部にご連絡ください。
        </Notice>
      ) : null}

      {!ready && !error ? (
        <Notice tone="info">
          お知らせの配信はただいま準備中です。本部側の登録先が用意でき次第、この画面に自動で表示されます。
          お手続きが必要なご連絡は、それまで従来どおりメールでお送りします。
        </Notice>
      ) : null}

      {importantCount > 0 ? (
        <Notice tone="warn">
          重要なお知らせが {importantCount} 件あります。内容をご確認ください。
        </Notice>
      ) : null}

      <Card title="お知らせ一覧">
        {error ? null : notices.length === 0 ? (
          <EmptyState
            title="お知らせはまだありません"
            description={
              ready
                ? "本部からの連絡事項がここに表示されます。"
                : "本部側の登録先がまだ用意されていないため、お知らせはここに表示されていません。"
            }
          />
        ) : (
          <ul className="divide-y divide-ink-850">
            {notices.map((n) => (
              <li key={n.id} className="px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {n.important ? <Badge tone="gold">重要</Badge> : null}
                    <h3 className="min-w-0 text-sm font-semibold text-ink-50">
                      {n.title || "（タイトル未設定）"}
                    </h3>
                  </div>
                  <div className="tabnum shrink-0 text-xs text-ink-400">
                    {jpFullDate(n.publishedAt)}
                  </div>
                </div>
                {n.body ? (
                  <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-200">
                    {n.body}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
