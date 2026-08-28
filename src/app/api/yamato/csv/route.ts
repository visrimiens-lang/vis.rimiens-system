import { NextRequest, NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { select } from "@/lib/db";
import { todayInJapan } from "@/lib/jst";
import { shipperConfig } from "@/lib/yamato";
import { buildB2Csv, type CsvOrder } from "@/lib/yamato-csv";

/**
 * B2クラウドに取り込ませる送り状データ（CSV）を返す。
 *
 * APIの認証キーが揃うまでの発行手段。ここで出したCSVをB2クラウドの
 * 「送り状発行データ取込」に読ませて発行し、発行結果の伝票番号を
 * 送り状発行の画面から貼り戻す。
 *
 * 宛先が欠けている受注は入れない（B2側で弾かれて、どれが原因か分からなくなるため）。
 */
export async function GET(req: NextRequest) {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return NextResponse.json({ error: "権限がありません。" }, { status: 403 });
  }

  const { config, missing } = shipperConfig();
  if (!config) {
    return NextResponse.json(
      { error: `送り主の設定が足りません（${missing.join("、")}）。` },
      { status: 400 },
    );
  }

  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
  if (ids.length === 0) {
    return NextResponse.json({ error: "受注が選ばれていません。" }, { status: 400 });
  }
  if (ids.length > 1000) {
    return NextResponse.json({ error: "一度に出せるのは1000件までです。" }, { status: 400 });
  }

  type Row = Record<string, unknown>;
  const s_ = (r: Row, k: string): string => {
    const v = r[k];
    return v === null || v === undefined ? "" : String(v);
  };

  const rows = await select<Row>(
    `orders?select=id,customer_name,phone,zip,address,building,quantity,product_name` +
      `&id=in.(${ids.join(",")})&order=id.asc`,
  );

  const orders: CsvOrder[] = rows
    .filter(
      (o) => s_(o, "customer_name") && s_(o, "phone") && s_(o, "zip") && s_(o, "address"),
    )
    .map((o) => ({
      orderId: s_(o, "id"),
      name: s_(o, "customer_name"),
      phone: s_(o, "phone"),
      zip: s_(o, "zip"),
      address: `${s_(o, "address")}${s_(o, "building")}`,
      quantity: Number(o["quantity"] ?? 1) || 1,
      productName: s_(o, "product_name"),
    }));

  if (orders.length === 0) {
    return NextResponse.json(
      { error: "宛先の揃った受注がありませんでした。" },
      { status: 400 },
    );
  }

  const today = todayInJapan();
  const csv = buildB2Csv(config, orders, today.replaceAll("-", ""));

  return new NextResponse(new Uint8Array(csv), {
    headers: {
      "Content-Type": "text/csv; charset=Shift_JIS",
      "Content-Disposition": `attachment; filename="b2-${today.replaceAll("-", "")}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
