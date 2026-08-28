"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, insert, select, update } from "@/lib/db";
import { todayInJapan } from "@/lib/jst";
import {
  B2Client,
  B2Error,
  b2Config,
  buildShipment,
  type OutboundOrder,
} from "@/lib/yamato";
import { parseTracking } from "@/lib/yamato-csv";

/**
 * ヤマトB2クラウドで送り状を発行する（本部専用）。
 *
 * 1回の実行でやること:
 *   1. 選ばれた受注を読み、宛先（名前・電話・郵便番号・住所）が揃っているか確かめる
 *   2. B2クラウドへ仮データ登録（B2側のデータチェックを通す）
 *   3. エラーがあれば仮データを片づけて、受注ごとのエラー内容を返す
 *   4. 送り状発行 → 印刷データの完成を待つ → PDFを取得
 *   5. 伝票番号を受け取り、受注（orders.tracking_no）と顧客台帳へ保存
 *   6. PDFの控えを yamato_issues に残す
 *
 * 途中で失敗しても、伝票番号を受け取れた分は必ず保存する。
 * 「B2では発行済みなのに、こちらには番号が無い」が最悪の状態なので、
 * その状態に気づけるよう、失敗はすべて audit に残す。
 */

export type YamatoState = {
  error?: string;
  /** 受注ごとのデータチェック結果（B2から返ったエラー文をそのまま出す） */
  rowErrors?: { orderId: string; name: string; messages: string[] }[];
  ok?: string;
  issueId?: number;
};

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

const MAX_PER_ISSUE = 100; // 仕様上は1000件まで。運用上はこれで十分

export async function issueYamatoAction(
  _prev: YamatoState,
  formData: FormData,
): Promise<YamatoState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "この操作は本部のアカウントでのみ行えます。" };
  }

  const { config, missing } = b2Config();
  if (!config) {
    return {
      error:
        "ヤマトB2クラウドの接続情報が設定されていません。" +
        `（不足している設定：${missing.join("、")}）担当者にご連絡ください。`,
    };
  }

  /* --- 対象の受注 --- */
  const ids = formData
    .getAll("order")
    .map((v) => String(v))
    .filter((v) => /^\d+$/.test(v));
  if (ids.length === 0) {
    return { error: "送り状を発行する受注を選んでください。" };
  }
  if (ids.length > MAX_PER_ISSUE) {
    return { error: `一度に発行できるのは ${MAX_PER_ISSUE} 件までです。分けてお試しください。` };
  }

  let orders: Row[];
  try {
    orders = await select<Row>(
      `orders?select=id,customer_id,customer_name,phone,zip,address,building,ship_status,tracking_no,review_result` +
        `&id=in.(${ids.join(",")})`,
    );
  } catch (e) {
    return { error: `受注を読み込めませんでした。${reason(e)}` };
  }
  if (orders.length === 0) return { error: "対象の受注が見つかりませんでした。" };

  /* --- 発行してよい状態か・宛先が揃っているかを先に確かめる ---
     B2に送ってから弾かれるより、こちらで分かる不備は先に伝えるほうが早い。 */
  const rowErrors: NonNullable<YamatoState["rowErrors"]> = [];
  const targets: OutboundOrder[] = [];
  for (const o of orders) {
    const messages: string[] = [];
    if (s_(o, "ship_status") === "キャンセル") messages.push("キャンセルされた受注です。");
    if (s_(o, "review_result") === "否決") messages.push("審査否決の受注です。");
    if (s_(o, "tracking_no")) messages.push(`送り状番号（${s_(o, "tracking_no")}）が入っています。`);
    if (!s_(o, "customer_name")) messages.push("お客様の名前が入っていません。");
    if (!s_(o, "phone")) messages.push("電話番号が入っていません。");
    if (!s_(o, "zip")) messages.push("郵便番号が入っていません。");
    if (!s_(o, "address")) messages.push("住所が入っていません。");
    if (messages.length > 0) {
      rowErrors.push({ orderId: s_(o, "id"), name: s_(o, "customer_name"), messages });
      continue;
    }
    targets.push({
      orderId: s_(o, "id"),
      name: s_(o, "customer_name"),
      phone: s_(o, "phone"),
      zip: s_(o, "zip"),
      address: `${s_(o, "address")}${s_(o, "building")}`,
    });
  }
  if (rowErrors.length > 0) {
    return {
      error: "発行できない受注が含まれています。外すか、内容を直してからお試しください。",
      rowErrors,
    };
  }

  const shipDate = todayInJapan().replaceAll("-", ""); // YYYYMMDD（本日〜30日後が有効）
  const client = new B2Client(config);

  /* --- 仮データ登録（B2のデータチェック） --- */
  let updated = "";
  let registered: Awaited<ReturnType<B2Client["register"]>>["entries"] = [];
  try {
    const r = await client.register(targets.map((t) => buildShipment(config, t, shipDate)));
    updated = r.updated;
    registered = r.entries;
  } catch (e) {
    return { error: b2reason(e) };
  }

  const nameOf = new Map(targets.map((t) => [t.orderId, t.name]));
  const bad = registered.filter((r) => r.errorFlg === "9");
  if (bad.length > 0) {
    // エラーの行が1つでもあれば発行しない。仮データは片づけて、内容をそのまま見せる
    await client.removeDrafts(
      updated,
      registered.map((r) => r.trackingNumber).filter(Boolean),
    );
    return {
      error:
        `B2クラウドのデータチェックで ${bad.length} 件がエラーになりました。` +
        "内容を直してから、もう一度お試しください。",
      rowErrors: bad.map((r) => ({
        orderId: r.orderId,
        name: nameOf.get(r.orderId) ?? "",
        messages: r.errors.length > 0 ? r.errors : ["（エラーの内容が返されませんでした）"],
      })),
    };
  }

  /* --- 送り状発行 → 印刷完成待ち → PDF → 伝票番号 --- */
  let issueNo = "";
  let issued: { orderId: string; invoiceNo: string }[] = [];
  let pdf: Uint8Array | null = null;
  try {
    const r = await client.issue(
      updated,
      registered.map((x) => ({ trackingNumber: x.trackingNumber, createdMs: x.createdMs })),
    );
    issueNo = r.issueNo;
    const { rxid } = await client.waitForPrint(issueNo, r.waitMs);
    pdf = await client.downloadPdf(issueNo);
    issued = await client.fetchIssued(rxid);
  } catch (e) {
    await audit("hq", "ヤマト送り状発行の失敗", { type: "yamato", key: issueNo || "-" }, {
      対象受注: ids,
      発行番号: issueNo || null,
      理由: b2reason(e),
    });
    return {
      error:
        b2reason(e) +
        (issueNo
          ? ` 発行番号は ${issueNo} です。伝票番号が採番済みの場合はB2クラウドの「発行済データの検索」で確認できます。`
          : ""),
    };
  }

  /* --- 伝票番号を保存する。ここが一番落としてはいけないところ --- */
  const saved: string[] = [];
  const saveFailed: string[] = [];
  for (const it of issued) {
    if (!it.orderId || !it.invoiceNo) continue;
    try {
      const rows = await update<Row>(`orders?id=eq.${encodeURIComponent(it.orderId)}`, {
        tracking_no: it.invoiceNo,
        // 送り状ができた＝手配が始まった。実際に発送したら、受注詳細で「出荷済」にする
        ...(ordersById(orders, it.orderId) === "出荷待ち" ? { ship_status: "出荷手配中" } : {}),
      });
      const customerId = rows[0] ? s_(rows[0], "customer_id") : "";
      if (customerId) {
        // お客様マイページは顧客台帳の送り状番号を見るので、そちらにも写す
        await update(`customers?id=eq.${encodeURIComponent(customerId)}`, {
          tracking_no: it.invoiceNo,
        });
      }
      saved.push(it.orderId);
    } catch {
      saveFailed.push(it.orderId);
    }
  }

  /* --- 控えを残す --- */
  let issueId: number | undefined;
  try {
    const rows = await insert<Row>("yamato_issues", [
      {
        issue_no: issueNo,
        order_ids: issued.map((i) => i.orderId),
        label_count: issued.length,
        pdf_base64: pdf ? Buffer.from(pdf).toString("base64") : null,
        has_pdf: pdf !== null,
      },
    ]);
    issueId = rows[0] ? Number(rows[0]["id"]) : undefined;
  } catch (e) {
    // 控えが残せなくても伝票番号は保存済み。監査に残して続ける
    await audit("hq", "ヤマト送り状控えの保存失敗", { type: "yamato", key: issueNo }, {
      理由: reason(e),
    });
  }

  await audit("hq", "ヤマト送り状発行", { type: "yamato", key: issueNo }, {
    枚数: issued.length,
    受注: issued.map((i) => `${i.orderId}:${i.invoiceNo}`),
    PDF: pdf ? "取得済み" : "取得できず",
    保存に失敗した受注: saveFailed.length > 0 ? saveFailed : null,
  });

  revalidatePath("/admin/shipping");
  revalidatePath("/admin/orders");
  revalidatePath("/customers");

  if (saveFailed.length > 0) {
    return {
      error:
        `送り状 ${issued.length} 枚を発行しましたが、受注 ${saveFailed.join("・")} への` +
        "伝票番号の保存に失敗しました。受注詳細から手で入力してください。",
      issueId,
    };
  }
  return {
    ok:
      `送り状 ${issued.length} 枚を発行しました（発行番号 ${issueNo}）。` +
      `伝票番号を受注 ${saved.length} 件に保存しました。` +
      (pdf ? "" : " PDFは取得できなかったため、B2クラウドの再発行からお出しください。"),
    issueId,
  };
}

/** 更新前の出荷状況を引く（保存条件の判定に使う）。 */
function ordersById(orders: Row[], id: string): string {
  const hit = orders.find((o) => s_(o, "id") === id);
  return hit ? s_(hit, "ship_status") : "";
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : "原因を特定できませんでした。";
}

/** B2のエラーは説明ごと利用者に見せる。それ以外は通信の失敗として伝える。 */
function b2reason(e: unknown): string {
  if (e instanceof B2Error) return e.message;
  return `B2クラウドとの通信に失敗しました。${reason(e)}`;
}


/* ══════════════════ 発行結果の取り込み（CSV運用） ══════════════════ */

export type TrackingState = {
  error?: string;
  ok?: string;
  /** 入れられなかった行の説明。何が起きたかを画面でそのまま見せる */
  problems?: string[];
};

/**
 * B2クラウドで発行した伝票番号を、受注に入れる。
 *
 * APIの認証キーが揃うまでの流れ:
 *   1. 送り状発行の画面から取込用CSVを書き出す
 *   2. B2クラウドの「送り状発行データ取込」で読ませて発行する
 *   3. 発行結果（お客様管理番号と送り状番号）をここに貼る
 *
 * 貼る形は決め打ちにしない。B2の出力をそのまま貼っても、
 * 「受注ID,伝票番号」の2列だけを貼っても通す（lib/yamato-csv.ts）。
 *
 * すでに別の伝票番号が入っている受注は、上書きせずに知らせる。
 * 二重発行に気づかないまま番号だけ書き換わるのが一番まずいため。
 */
export async function importTrackingAction(
  _prev: TrackingState,
  formData: FormData,
): Promise<TrackingState> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") {
    return { error: "この操作は本部のアカウントでのみ行えます。" };
  }

  const text = String(formData.get("tracking") ?? "");
  const { pairs, skipped } = parseTracking(text);
  if (pairs.length === 0) {
    return {
      error:
        "受注IDと伝票番号の組が読み取れませんでした。" +
        "B2クラウドの発行結果をそのまま貼るか、「受注ID,伝票番号」の形で貼ってください。",
      problems: skipped.slice(0, 10),
    };
  }

  const problems: string[] = skipped.map((l) => `読み取れなかった行：${l}`);
  let done = 0;

  for (const p of pairs) {
    let rows: Row[];
    try {
      rows = await select<Row>(
        `orders?select=id,customer_id,customer_name,tracking_no,ship_status` +
          `&id=eq.${encodeURIComponent(p.orderId)}`,
      );
    } catch (e) {
      problems.push(`受注${p.orderId}：読み込めませんでした。${reason(e)}`);
      continue;
    }
    const o = rows[0];
    if (!o) {
      problems.push(`受注${p.orderId}：この番号の受注がありません。`);
      continue;
    }
    const already = s_(o, "tracking_no");
    if (already && already !== p.trackingNo) {
      problems.push(
        `受注${p.orderId}（${s_(o, "customer_name")}）：すでに ${already} が入っているため、` +
          `${p.trackingNo} は入れませんでした。二重発行でないかご確認ください。`,
      );
      continue;
    }
    if (already === p.trackingNo) {
      done += 1; // 同じ番号の貼り直しは、そのまま済みとして数える
      continue;
    }
    try {
      await update(`orders?id=eq.${encodeURIComponent(p.orderId)}`, {
        tracking_no: p.trackingNo,
        ...(s_(o, "ship_status") === "出荷待ち" ? { ship_status: "出荷手配中" } : {}),
      });
      const customerId = s_(o, "customer_id");
      if (customerId) {
        // お客様マイページは顧客台帳の送り状番号を見るので、そちらにも写す
        await update(`customers?id=eq.${encodeURIComponent(customerId)}`, {
          tracking_no: p.trackingNo,
        });
      }
      done += 1;
    } catch (e) {
      problems.push(`受注${p.orderId}：入れられませんでした。${reason(e)}`);
    }
  }

  await audit("hq", "ヤマト伝票番号の取り込み", { type: "yamato", key: "csv" }, {
    入れた件数: done,
    問題: problems.length > 0 ? problems.slice(0, 20) : null,
  });

  revalidatePath("/admin/shipping");
  revalidatePath("/admin/orders");
  revalidatePath("/customers");

  return {
    ok: done > 0 ? `${done} 件の伝票番号を受注に入れました。` : undefined,
    error: done === 0 ? "受注に入れられた伝票番号はありませんでした。" : undefined,
    problems: problems.length > 0 ? problems : undefined,
  };
}
