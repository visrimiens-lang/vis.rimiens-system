import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { select } from "@/lib/db";
import { normalizePhone } from "@/lib/intake";
import { isLocked, recordFailure, clearFailures } from "@/lib/rate-limit";

/**
 * お客様のマイページ（LINE リッチメニューの LIFF ページ）に出す情報を返す。
 *
 * これまでは Make 経由で kintone からメールアドレスと電話番号で引いていた
 * （かおりさんが構築中だった流れ）。kintone と Make をやめる方針に合わせて、
 * ここが同じ役割を担う。LIFF ページ側は取得先の URL をここに変えるだけでよい:
 *
 *   GET /api/mypage?token=＜合言葉＞&email=＜メール＞&phone=＜電話＞
 *
 * ■ 本人の特定は「メールアドレスと電話番号の両方一致」
 *
 * 片方だけで返すと、どちらか一方を知っているだけの第三者が
 * 他人の情報を引けてしまう。マイページは購入者本人が自分の連絡先を
 * 入力する画面なので、両方要求しても本人は困らない。
 *
 * ■ 返すのは画面に出す最小限だけ
 *
 * 住所・決済・報酬まわりは返さない。保証と配送の確認が目的のため。
 * 連続で外した相手は しばらく受け付けない（総当たり対策）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const secret = process.env.WEBHOOK_TOKEN ?? "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || !sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  const email = (req.nextUrl.searchParams.get("email") ?? "").trim();
  const phone = normalizePhone(req.nextUrl.searchParams.get("phone") ?? "");
  if (!email || !phone) {
    return NextResponse.json(
      { ok: false, error: "メールアドレスと電話番号の両方を入れてください。" },
      { status: 400 },
    );
  }

  // 総当たり対策。連続で外した連絡先はしばらく受け付けない。
  const lockKey = `mypage:${email}`;
  if (await isLocked(lockKey)) {
    return NextResponse.json(
      { ok: false, error: "試行が続いたため、しばらくしてからお試しください。" },
      { status: 429 },
    );
  }

  const rows = await select<Row>(
    `customers?select=name,email,phone,serial_no,warranty_status,ship_status,tracking_no,delivered_on,contracted_on` +
      `&email=eq.${encodeURIComponent(email)}`,
  );
  const hit = rows.find((r) => normalizePhone(s_(r, "phone")) === phone);

  if (!hit) {
    await recordFailure(lockKey);
    return NextResponse.json(
      {
        ok: false,
        error:
          "ご登録が見つかりませんでした。ご購入時のメールアドレスと電話番号をご確認ください。",
      },
      { status: 404 },
    );
  }

  await clearFailures(lockKey);
  return NextResponse.json({
    ok: true,
    customer: {
      name: s_(hit, "name"),
      warrantyStatus: s_(hit, "warranty_status") || "未登録",
      serialNo: s_(hit, "serial_no"),
      shipStatus: s_(hit, "ship_status"),
      trackingNo: s_(hit, "tracking_no"),
      deliveredOn: s_(hit, "delivered_on"),
      contractedOn: s_(hit, "contracted_on"),
    },
  });
}
