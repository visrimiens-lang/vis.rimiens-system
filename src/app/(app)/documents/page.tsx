import { redirect } from "next/navigation";
import { Paperclip } from "lucide-react";
import { currentViewer } from "@/lib/auth";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import {
  documentsConfigured,
  fileSize,
  groupDocuments,
  jpFullDate,
  listDocuments,
  type DocumentItem,
} from "@/lib/content";

export default async function DocumentsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");

  // 資料は本部・代理店のどちらから見ても同じ内容なので、種別では絞らない。
  const ready = documentsConfigured();

  let documents: DocumentItem[] = [];
  let error: string | null = null;

  if (ready) {
    try {
      documents = await listDocuments();
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : "資料の読み込み中に問題が起きました。時間をおいて再度お試しください。";
    }
  }

  const groups = groupDocuments(documents);

  return (
    <div className="space-y-6">
      <PageHeader
        title="資料"
        description="本部が用意した販促物や操作マニュアルをまとめています。カテゴリごとに分かれています。"
      />

      {error ? (
        <Notice tone="bad">
          資料を読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、本部にご連絡ください。
        </Notice>
      ) : null}

      {!ready && !error ? (
        <Notice tone="info">
          資料の配布はただいま準備中です。本部側の保管先が用意でき次第、この画面に自動で表示されます。
          お急ぎの販促物が必要な場合は、本部までご連絡ください。
        </Notice>
      ) : null}


      {error ? null : groups.length === 0 ? (
        <Card title="資料一覧">
          <EmptyState
            title="資料はまだ登録されていません"
            description={
              ready
                ? "販促物や操作マニュアルがここからダウンロードできるようになります。"
                : "本部側の保管先がまだ用意されていないため、資料はここに表示されていません。"
            }
          />
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.category} title={g.category}>
            <ul className="divide-y divide-ink-850">
              {g.items.map((d) => (
                <li key={d.id} className="px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <h3 className="min-w-0 text-sm font-semibold text-ink-50">
                      {d.name || "（資料名未設定）"}
                    </h3>
                    <div className="tabnum shrink-0 text-xs text-ink-400">
                      更新 {jpFullDate(d.updatedAt)}
                    </div>
                  </div>

                  {d.description ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-300">
                      {d.description}
                    </p>
                  ) : null}

                  {d.files.length > 0 ? (
                    <ul className="mt-3 space-y-1.5">
                      {d.files.map((f, i) => (
                        <li key={`${f.url || f.name}-${i}`}>
                          <a
                            href={f.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 transition hover:border-gold-500/50 hover:text-gold-300"
                          >
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                            <span className="min-w-0 truncate">
                              {f.name || "（ファイル名不明）"}
                            </span>
                            {f.size > 0 ? (
                              <span className="tabnum shrink-0 text-xs text-ink-500">
                                {fileSize(f.size)}
                              </span>
                            ) : null}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-ink-400">
                      ファイルはまだ添付されていません。
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
