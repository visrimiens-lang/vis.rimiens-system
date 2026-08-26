import { NextRequest, NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { selectOne } from "@/lib/db";

/**
 * 発行済みの送り状PDF（控え）を返す。
 *
 * PDFの本体はB2クラウドではなく、発行時に保存した控え（yamato_issues）から
 * 出す。B2側のPDFには有効期限があり、期限が切れると取り直せないため。
 * 本部のアカウントでログインしているときだけ開ける。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return NextResponse.json({ error: "権限がありません。" }, { status: 403 });
  }

  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "指定が正しくありません。" }, { status: 400 });
  }

  const row = await selectOne<Record<string, unknown>>(
    `yamato_issues?select=issue_no,pdf_base64&id=eq.${id}`,
  );
  if (!row || !row["pdf_base64"]) {
    return NextResponse.json(
      { error: "控えのPDFがありません。B2クラウドの再発行からお出しください。" },
      { status: 404 },
    );
  }

  const bytes = Buffer.from(String(row["pdf_base64"]), "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="yamato-${String(row["issue_no"])}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
