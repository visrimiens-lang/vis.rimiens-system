import { redirect } from "next/navigation";
import { Paperclip } from "lucide-react";
import { currentViewer } from "@/lib/auth";
import { fileSize, jpFullDate } from "@/lib/content";
import {
  DOCUMENT_CATEGORIES,
  MAX_UPLOAD_BYTES,
  documentAdminConfigured,
  listAllDocuments,
  type AdminDocument,
} from "@/lib/document-admin";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { DocumentForm, DocumentRowActions } from "./DocumentForm";

export default async function AdminDocumentsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const ready = documentAdminConfigured();

  let documents: AdminDocument[] = [];
  let loadError: string | null = null;

  if (ready) {
    try {
      documents = await listAllDocuments();
    } catch (e) {
      loadError =
        e instanceof Error
          ? e.message
          : "資料の一覧を読み込めませんでした。時間をおいてもう一度お試しください。";
    }
  }

  const publishedCount = documents.filter((d) => d.published).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="資料の配布"
        description="販促物や操作マニュアルをここに登録すると、代理店の「資料」ページにそのまま並びます。カテゴリごとに分かれて表示されるので、「ここから全部お使いください」とまとめて案内できます。"
        actions={
          ready && !loadError ? (
            <Badge tone={publishedCount > 0 ? "gold" : "neutral"}>
              公開中 {publishedCount} 件
            </Badge>
          ) : null
        }
      />

      {!ready ? (
        <Notice tone="warn">
          資料の保管先がまだ設定されていないため、この画面からはアップロードできません。
          サーバー側に保管先の設定（保管先のURLと書き込み用のキー）を入れると、すぐに使えるようになります。
        </Notice>
      ) : null}

      {loadError ? (
        <Notice tone="bad">
          登録済みの資料を読み込めませんでした。{loadError}
          <br />
          しばらく待ってから画面を読み込み直してください。続くようであれば保管先の設定をご確認ください。
        </Notice>
      ) : null}

      {ready ? (
        <Card title="資料を追加">
          <DocumentForm categories={DOCUMENT_CATEGORIES} maxBytes={MAX_UPLOAD_BYTES} />
        </Card>
      ) : null}

      <Card title="登録済みの資料">
        {loadError ? null : documents.length === 0 ? (
          <EmptyState
            title="登録されている資料はまだありません"
            description={
              ready
                ? "上のフォームからファイルを追加すると、ここに一覧で並び、代理店の資料ページにも同時に表示されます。"
                : "資料の保管先が設定されていないため、まだ何も登録できていません。"
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>資料名</Th>
                  <Th>カテゴリ</Th>
                  <Th>ファイル</Th>
                  <Th align="right">サイズ</Th>
                  <Th align="right">更新日</Th>
                  <Th align="center">状態</Th>
                  <Th align="right">操作</Th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <div className="font-medium text-ink-100">
                        {d.name || "（資料名未設定）"}
                      </div>
                      {d.description ? (
                        <div className="mt-1 max-w-md whitespace-pre-wrap text-xs leading-relaxed text-ink-500">
                          {d.description}
                        </div>
                      ) : null}
                    </Td>
                    <Td>{d.category}</Td>
                    <Td>
                      {d.fileUrl ? (
                        <a
                          href={d.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-[16rem] items-center gap-2 text-ink-100 transition hover:text-gold-300"
                        >
                          <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                          <span className="truncate">
                            {d.fileName || "（ファイル名不明）"}
                          </span>
                        </a>
                      ) : (
                        <span className="text-ink-500">ファイルなし</span>
                      )}
                    </Td>
                    <Td numeric align="right">
                      {fileSize(d.fileSize)}
                    </Td>
                    <Td numeric align="right">
                      {jpFullDate(d.updatedAt)}
                    </Td>
                    <Td align="center">
                      {d.published ? (
                        <Badge tone="good">公開中</Badge>
                      ) : (
                        <Badge tone="neutral">非公開</Badge>
                      )}
                    </Td>
                    <Td align="right">
                      <DocumentRowActions
                        id={d.id}
                        name={d.name}
                        published={d.published}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-ink-800 px-5 py-3.5 text-xs leading-relaxed text-ink-400">
              「非公開」にした資料は代理店の画面から消えますが、ここには残るのでいつでも戻せます。
              削除すると、ファイル本体も保管先から消えて元に戻せません。
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
