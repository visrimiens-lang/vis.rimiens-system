import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { audit, select, update } from "@/lib/db";
import { receive, markProcessed, normalizePhone } from "@/lib/intake";

/**
 * 保証登録を受け取る。
 *
 * お客様が LINE のリッチメニューから保証登録フォーム（UTAGE）に
 * 製造番号を入力すると、ここに届く。
 *
 * これまでは Make（シナリオ「VIS保証登録→kintone」）が受けて、
 * kintone のお客様をメールアドレスで探し、製造番号と保証ステータスを
 * 書き込んでいた。kintone をやめるのに合わせて、同じ流れをここで受ける。
 *
 * UTAGE 側のフォーム送信先をこの URL に変えるだけで切り替わる:
 *   https://vis-rimiens-system.vercel.app/api/webhooks/warranty?token=＜合言葉＞
 *
 * 探し方は Make 時代と同じ「メールアドレス」を第一にし、
 * 見つからないときは電話番号でも探す（スマホの自動入力で
 * メールアドレスが揺れることがあるため）。
 * それでも見つからなければ、受信箱に残して本部が手当てできるようにする。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;
const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
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

async function readPayload(req: NextRequest): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return (await req.json()) as Record<string, unknown>;
  }
  const form = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : String(v);
  return out;
}

function pick(data: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    for (const [k, v] of Object.entries(data)) {
      if (k === n || k.includes(n)) {
        const s = String(v ?? "").trim();
        if (s) return s;
      }
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  /*
   * 保証登録は、お客様のスマホで動く LINE のページ（LIFF）から呼ばれる。
   * そのページに埋めた合言葉は、開いた人なら誰でも読める。
   *
   * 受注を作る口（/api/webhooks/order）と同じ合言葉を配ると、
   * それを読み取った第三者が受注をいくらでも作れてしまい、
   * 報酬の水増しや顧客台帳の汚染につながる。
   * そこで保証登録には専用の合言葉（WARRANTY_TOKEN）を用意し、
   * 設定が無いうちは従来どおり WEBHOOK_TOKEN でも通す。
   */
  const secret = process.env.WARRANTY_TOKEN || process.env.WEBHOOK_TOKEN || "";
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || !sameSecret(given, secret)) {
    return NextResponse.json({ ok: false, error: "認証に失敗しました。" }, { status: 401 });
  }

  let data: Record<string, unknown>;
  try {
    data = await readPayload(req);
  } catch {
    return NextResponse.json({ ok: false, error: "内容を読み取れませんでした。" }, { status: 400 });
  }

  // まず丸ごと残す。途中で失敗しても登録内容が消えないようにする。
  const box = await receive("utage-warranty", null, null, data);

  const email = pick(data, "email", "メールアドレス", "mail");
  const phone = pick(data, "phone", "電話");
  const serial = pick(data, "serial", "製造番号", "シリアル", "seizoubangou");
  const name = pick(data, "name", "お名前", "氏名");

  try {
    if (!serial) {
      const msg = "製造番号が入っていません。受信箱から内容をご確認ください。";
      await markProcessed(box.id, msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 202 });
    }

    /*
     * お客様を探す。メールアドレスを第一にする（Make 時代と同じ）。
     * 完全一致で1件だけのときにだけ書き込む。複数当たったときに
     * 当て推量で選ぶと、他人の保証を書き換えてしまうため。
     */
    let hits: Row[] = [];
    if (email) {
      hits = await select<Row>(`customers?select=id,name,serial_no,warranty_status&email=eq.${encodeURIComponent(email)}`);
    }
    if (hits.length !== 1 && phone) {
      const digits = normalizePhone(phone);
      if (digits) {
        const byPhone = await select<Row>(
          `customers?select=id,name,serial_no,warranty_status,phone&limit=200`,
        );
        const matched = byPhone.filter((c) => normalizePhone(s_(c, "phone")) === digits);
        if (matched.length === 1) hits = matched;
      }
    }

    if (hits.length !== 1) {
      const msg =
        hits.length === 0
          ? `お客様が見つかりませんでした（メール: ${email || "なし"}）。受信箱から本部が確認してください。`
          : "同じ連絡先のお客様が複数いるため、自動では書き込みませんでした。受信箱から本部が確認してください。";
      await markProcessed(box.id, msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 202 });
    }

    const c = hits[0];
    await update(`customers?id=eq.${s_(c, "id")}`, {
      serial_no: serial,
      warranty_status: "本保証",
    });
    await audit("system", "保証登録", { type: "customer", key: s_(c, "id") }, {
      お客様: s_(c, "name"),
      製造番号: serial,
      変更前: { 製造番号: s_(c, "serial_no") || "（空）", 保証: s_(c, "warranty_status") },
      入力名: name || undefined,
    });
    await markProcessed(box.id);
    return NextResponse.json({
      ok: true,
      message: `${s_(c, "name")} 様の保証を登録しました（製造番号 ${serial}）。`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "保証登録に失敗しました。";
    await markProcessed(box.id, msg);
    console.error("[warranty]", e);
    return NextResponse.json({ ok: false, error: msg }, { status: 202 });
  }
}
