import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { select, update } from "@/lib/db";
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

/* ═══════════════════ LINE から開いたときの照会 ═══════════════════ */

/**
 * LINE のマイページ（LIFF）から呼ばれる口。
 *
 * ■ なぜ GET と別に要るか
 *
 * これまでマイページは kViewer と kintone が担当していて、
 * LINE の利用者ID（LINE UserID）でお客様を引いていた。
 * 一度つなげば次からは入力なしで開ける、という作りになっている。
 *
 * 上の GET はメールアドレスと電話番号の両方を毎回求めるので、
 * そのまま差し替えるとお客様は開くたびに入力することになる。
 * ここで LINE の利用者IDによる照会を用意して、同じ使い勝手にする。
 *
 *   1回目 … 利用者IDでは見つからないので、メールと電話で本人確認し、
 *           確認できたらその利用者IDを控えて次から使えるようにする
 *   2回目以降 … 利用者IDだけで開ける
 *
 * ■ 返す形
 *
 * linked が false のときは、画面で連絡先の入力をお願いする合図。
 * 返す中身は GET と同じで、住所・決済・報酬は含めない。
 */
export async function POST(req: NextRequest) {
  const secret = process.env.WARRANTY_TOKEN || process.env.WEBHOOK_TOKEN || "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || !sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  const lineUserId = String(body["lineUserId"] ?? body["line_user_id"] ?? "").trim().slice(0, 100);
  const email = String(body["email"] ?? "").trim().toLowerCase().slice(0, 200);
  const phone = normalizePhone(String(body["phone"] ?? ""));

  if (!lineUserId && !email) {
    return NextResponse.json({ ok: false, error: "LINEの情報が取得できませんでした。" }, { status: 400 });
  }

  const shape = (r: Row) => ({
    name: s_(r, "name"),
    warrantyStatus: s_(r, "warranty_status") || "未登録",
    serialNo: s_(r, "serial_no"),
    shipStatus: s_(r, "ship_status"),
    trackingNo: s_(r, "tracking_no"),
    deliveredOn: s_(r, "delivered_on"),
    contractedOn: s_(r, "contracted_on"),
  });

  // ① すでにつながっていれば、利用者IDだけで返す
  if (lineUserId) {
    const linked = await select<Row>(
      `customers?select=*&line_user_id=eq.${encodeURIComponent(lineUserId)}&limit=1`,
    );
    if (linked.length > 0) {
      return NextResponse.json({ ok: true, linked: true, record: shape(linked[0]) });
    }
  }

  // ② まだなら、メールと電話の両方で本人確認する（GET と同じ厳しさ）
  if (!email || !phone) {
    return NextResponse.json({
      ok: true,
      linked: false,
      message: "ご購入時のメールアドレスと電話番号をご入力ください。",
    });
  }

  const lockKey = `mypage:${email}`;
  if (await isLocked(lockKey)) {
    return NextResponse.json(
      { ok: false, error: "試行が続いたため、しばらくしてからお試しください。" },
      { status: 429 },
    );
  }

  const rows = await select<Row>(
    `customers?select=*&email=eq.${encodeURIComponent(email)}`,
  );
  const hit = rows.find((r) => normalizePhone(s_(r, "phone")) === phone);
  if (!hit) {
    await recordFailure(lockKey);
    return NextResponse.json({
      ok: true,
      linked: false,
      message:
        "ご登録が見つかりませんでした。ご購入時のメールアドレスと電話番号をご確認ください。",
    });
  }

  await clearFailures(lockKey);

  // 確認できたので、次から入力なしで開けるように利用者IDを控える
  if (lineUserId) {
    try {
      await update(`customers?id=eq.${s_(hit, "id")}`, {
        line_user_id: lineUserId,
        line_registered_at: new Date().toISOString(),
      });
    } catch {
      // 控えられなくても、今回の表示は続ける
    }
  }

  return NextResponse.json({ ok: true, linked: true, record: shape(hit) });
}
