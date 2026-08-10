"use server";

import { revalidatePath } from "next/cache";
import { currentViewer } from "@/lib/auth";
import { audit, select, selectOne, update } from "@/lib/db";
import { confirmRewards, reverseRewards } from "@/lib/rewards";

/**
 * 受注の更新（本部だけが行う）。
 *
 * kintone App10 でやっていた「出荷の手配」と「審査・照合の直し」をここに移す。
 * 出荷済にすると報酬が確定し、キャンセルにすると報酬が取り消される。
 * 報酬の計算そのものは src/lib/rewards.ts が持っているので、ここからは呼ぶだけにする。
 */

/** at は成功のたびに変わる。画面側が「今の結果」を出し分ける合図に使う。 */
export type OrderActionState = { error?: string; ok?: string; at?: number };

type Row = Record<string, unknown>;

/* 保管先（orders テーブル）が受け付ける値。これ以外は保存させない。 */
const SHIP_STATUSES = ["出荷待ち", "出荷手配中", "出荷済", "キャンセル"];
const REVIEW_RESULTS = ["承認", "否決", "電話確認待ち"];
const MATCH_STATUSES = ["照合済", "要確認", "直販"];

const NOT_FOUND =
  "対象のご注文が見つかりませんでした。画面を開き直してから、もう一度お試しください。";

/**
 * 本部以外は一切書き換えできない。
 * フォームから受注番号を受け取るため、ここの判定が唯一の砦になる。
 */
async function denyIfNotHq(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") return "権限がありません。";
  return null;
}

/** 操作の記録に残す名前。 */
async function actorName(): Promise<string> {
  const viewer = await currentViewer();
  return viewer?.label ?? "本部";
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function s_(r: Row | null, k: string): string {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

function n_(r: Row | null, k: string): number {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** 画面から来た受注番号をそのまま絞り込みに使わない。数字だけを通す。 */
function readOrderId(formData: FormData): string | null {
  const id = text(formData, "orderId");
  return /^\d+$/.test(id) ? id : null;
}

/** 日付欄。空なら null、形式が違えば undefined を返す。 */
function readDate(formData: FormData, key: string): string | null | undefined {
  const v = text(formData, key);
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

/** 全角の英数字を半角に直す。送り状番号の貼り付け間違いを救うため。 */
function toHalfWidth(v: string): string {
  return v.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/** 日本時間での今日。サーバーが世界標準時で動いていても前日にならないようにする。 */
function todayInJapan(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function failed(prefix: string, e: unknown): OrderActionState {
  return {
    error:
      e instanceof Error
        ? `${prefix}${e.message}`
        : `${prefix}時間をおいて、もう一度お試しください。`,
  };
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : "原因を特定できませんでした。";
}

/** 画面に出す注文者の呼び名。 */
function customerLabel(order: Row): string {
  const name = s_(order, "customer_name");
  return name ? `${name} 様` : "このご注文";
}

/**
 * 確定・取消の対象が1件も無かったときに、その理由を調べて文にする。
 *
 * 「そもそも報酬が立っていない」のか「すでに確定・取消が済んでいる」のかで、
 * 本部が次にやることがまったく変わる。
 * 一律に「確定しました」と伝えると、報酬が立っていない受注を見落としてしまうため、
 * ここで必ず言い分ける。
 *
 * ・受注時の計上に失敗した／紹介元コードが無かった／商品が報酬の対象外 → 1件も無い
 * ・キャンセルしたあとで出荷済に戻した → 元の行は「取消」のままで、確定できる行が無い
 */
async function noRewardNote(orderId: string, shipped: boolean): Promise<string> {
  const head = shipped
    ? "確定できる報酬はありませんでした。"
    : "取り消す報酬はありませんでした。";
  const tail = "下の報酬一覧をご確認ください。";

  let rows: Row[];
  try {
    rows = await select<Row>(`rewards?select=status,amount&order_id=eq.${orderId}`);
  } catch {
    return `${head}報酬の計上状況を確認できませんでした。${tail}`;
  }

  if (rows.length === 0) {
    return shipped
      ? `${head}この受注には報酬が1件も計上されていません。紹介元コードが入っているか、商品が報酬の対象かをご確認ください。`
      : `${head}この受注には報酬が1件も計上されていません。`;
  }

  // 取消されていない、金額がプラスの行が残っているか
  const live = rows.filter((r) => n_(r, "amount") > 0 && s_(r, "status") !== "取消");
  if (shipped && live.length > 0) {
    return "新しく確定した報酬はありません。この受注の報酬はすでに確定済みです。";
  }
  return `${head}この受注の報酬はすでに取り消されています。${tail}`;
}

/* ══════════════════════════ 出荷の更新 ══════════════════════════ */

/**
 * 出荷状況・送り状番号・出荷日を更新する。
 *
 * ・出荷済にしたら、この受注から発生した報酬を確定させる
 * ・キャンセルにしたら、計上済みの報酬を取り消す（同額のマイナスを立てる）
 *
 * 取消は二重に立てると帳簿が合わなくなる。かといって出荷状況が「キャンセル」かどうかで
 * 判断すると、取消に失敗したときに出荷状況だけ先に変わってしまい、
 * やり直しても報酬が取り消せなくなる。
 * そこで「取り消されていない報酬が残っているか」で毎回判断する。
 * 確定のほうは何度呼んでも結果が変わらないので、やり直しができるように毎回呼ぶ。
 */
export async function updateShipmentAction(
  _prev: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readOrderId(formData);
  if (!id) return { error: NOT_FOUND };

  const next = text(formData, "shipStatus");
  if (!SHIP_STATUSES.includes(next)) {
    return {
      error: "出荷状況は「出荷待ち」「出荷手配中」「出荷済」「キャンセル」から選んでください。",
    };
  }

  // 送り状番号はハイフンや空白を入れて書かれることが多いので、こちらで取り除く。
  // 全角で入力されることもあるため、半角に直してから確かめる。
  const tracking = toHalfWidth(text(formData, "trackingNo")).replace(
    /[-\s‐-―ー－]/g,
    "",
  );
  if (tracking.length > 30) {
    return { error: "送り状番号が長すぎます。ヤマトの送り状番号（12桁）をご確認ください。" };
  }
  if (tracking && !/^[0-9A-Za-z]+$/.test(tracking)) {
    return {
      error:
        "送り状番号は半角の数字で入力してください。ハイフンや空白は入っていても構いません（自動で取り除きます）。",
    };
  }
  if (next === "出荷済" && !tracking) {
    return {
      error:
        "出荷済にするには送り状番号が必要です。ヤマトの送り状番号を入力してから、もう一度お試しください。" +
        "まだ送り状ができていない場合は「出荷手配中」で保存してください。",
    };
  }

  const shippedOn = readDate(formData, "shippedOn");
  if (shippedOn === undefined) {
    return { error: "出荷日は「2026-08-11」のような形式で入力してください。" };
  }

  let before = "";
  let label = "このご注文";
  let rewardNote = "";

  try {
    const order = await selectOne<Row>(
      `orders?select=id,customer_name,ship_status,tracking_no,shipped_on&id=eq.${id}`,
    );
    if (!order) return { error: NOT_FOUND };

    before = s_(order, "ship_status");
    label = customerLabel(order);

    // キャンセルは報酬の取消につながる。押し間違いを防ぐため、確認を通っていなければ止める。
    // すでにキャンセルの受注をもう一度保存するとき（前回失敗した取消のやり直しなど）は、
    // 画面に確認欄が出ないうえ、確認はその1回目に済んでいるので求めない。
    if (next === "キャンセル" && before !== "キャンセル" && text(formData, "confirmCancel") !== "true") {
      return {
        error:
          "キャンセルにすると、この受注から発生した報酬が取り消されます。" +
          "確認のチェックを入れてから、もう一度お試しください。",
      };
    }

    await update(`orders?id=eq.${id}`, {
      ship_status: next,
      tracking_no: tracking || null,
      // 出荷済で日付が空なら、今日の日付を入れておく（報酬の締めに使うため）
      shipped_on: shippedOn ?? (next === "出荷済" ? todayInJapan() : null),
    });
  } catch (e) {
    return failed("出荷状況を保存できませんでした。", e);
  }

  /* --- 報酬の確定・取消 --- */
  // 取消をするかどうかは「前の出荷状況」では決めない。
  // 出荷状況は上ですでに「キャンセル」で保存してしまうため、
  // 報酬の取消に失敗したあとにやり直すと「前もキャンセル」になり、
  // 報酬が生きたまま二度と取り消せなくなるため。
  // 判断材料は報酬側の今の姿（取り消されていない、プラスの報酬が残っているか）にする。
  let touchRewards = next === "出荷済";
  if (next === "キャンセル") {
    let rewardRows: Row[];
    try {
      rewardRows = await select<Row>(`rewards?select=status,amount&order_id=eq.${id}`);
    } catch (e) {
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          `出荷状況は「キャンセル」に保存しましたが、報酬の計上状況を確認できませんでした。${reason(e)} ` +
          "報酬はまだ取り消されていないおそれがあります。" +
          "下の報酬一覧をご確認のうえ、もう一度この操作を行ってください。",
        at: Date.now(),
      };
    }

    // 取り消されていない、プラスの報酬（＝まだ生きている報酬）
    const live = rewardRows.filter(
      (r) => n_(r, "amount") > 0 && s_(r, "status") !== "取消",
    ).length;
    // 相殺のために立てたマイナスの報酬
    const offset = rewardRows.filter((r) => n_(r, "amount") < 0).length;

    if (live > 0 && offset > 0) {
      // 前回の取消が途中で止まっている。ここでやり直すとマイナスが二重に立ち、
      // 支払額を余計に差し引いてしまうため、報酬には触らずに本部へ知らせる。
      await audit(await actorName(), "報酬取消の中断", { type: "order", key: id }, {
        出荷状況: next,
        残っている報酬: live,
        立っているマイナス: offset,
      });
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          "出荷状況は「キャンセル」に保存しました。ただし、この受注の報酬は取消の途中で止まっています" +
          `（相殺のマイナス ${offset} 件は立っていますが、元の報酬 ${live} 件が取消になっていません）。` +
          "このまま取消をやり直すとマイナスが二重に立つため、報酬には触っていません。" +
          "下の報酬一覧をご確認のうえ、担当者にご連絡ください。",
        at: Date.now(),
      };
    }

    touchRewards = live > 0;
    // 取り消すものが無いときは、その理由をそのまま伝える。
    // 「取り消しました」とだけ返すと、取消が済んでいない受注を本部が見落とすため。
    if (!touchRewards) rewardNote = await noRewardNote(id, false);
  }

  let rewardCount: number | null = null;
  if (touchRewards) {
    try {
      // 何件動いたかを必ず受け取る。0件のまま「確定しました」とは言わない。
      rewardCount =
        next === "出荷済"
          ? await confirmRewards(id)
          : await reverseRewards(id, "受注のキャンセル");
      if (rewardCount > 0) {
        rewardNote =
          next === "出荷済"
            ? `この受注の報酬 ${rewardCount} 件を確定しました。`
            : `この受注の報酬 ${rewardCount} 件を取り消しました（同額のマイナスを立てて相殺しています）。`;
      } else {
        rewardNote = await noRewardNote(id, next === "出荷済");
      }
    } catch (e) {
      // 出荷の記録は済んでいる。報酬だけが残っている状態を、はっきり伝える。
      await audit(
        await actorName(),
        next === "出荷済" ? "報酬確定の失敗" : "報酬取消の失敗",
        { type: "order", key: id },
        { 出荷状況: next, 理由: reason(e) },
      );
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          `出荷状況は「${next}」に保存しましたが、報酬の${next === "出荷済" ? "確定" : "取消"}に失敗しました。` +
          `${reason(e)} 下の報酬一覧をご確認のうえ、もう一度この操作を行ってください。`,
        at: Date.now(),
      };
    }
  }

  await audit(await actorName(), "出荷状況の更新", { type: "order", key: id }, {
    前: before || "（未設定）",
    後: next,
    送り状番号: tracking || null,
    出荷日: shippedOn ?? (next === "出荷済" ? todayInJapan() : null),
    // 0件だったことも残す。あとから「なぜ報酬が立っていないのか」を追えるようにする。
    報酬件数: rewardCount,
  });

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath("/rewards");
  revalidatePath("/dashboard");

  const backwards = before === "出荷済" && next !== "出荷済" && next !== "キャンセル";
  return {
    ok:
      `${label}の出荷状況を「${next}」に更新しました。` +
      (rewardNote ? ` ${rewardNote}` : "") +
      (backwards
        ? " すでに確定した報酬はそのまま残ります。報酬まで取り消す場合は「キャンセル」を選んでください。"
        : ""),
    at: Date.now(),
  };
}

/* ══════════════════════ 審査・照合の更新 ══════════════════════ */

/**
 * 審査結果・信販受付番号・照合状態・紹介元コードを直す。
 *
 * 紹介元コードは報酬の支払先そのものなので、
 * 代理店マスタに無いコードは保存させない（払い先の無い報酬を作らないため）。
 */
export async function updateOrderAction(
  _prev: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  const denied = await denyIfNotHq();
  if (denied) return { error: denied };

  const id = readOrderId(formData);
  if (!id) return { error: NOT_FOUND };

  const review = text(formData, "reviewResult");
  if (review && !REVIEW_RESULTS.includes(review)) {
    return { error: "審査結果は「承認」「否決」「電話確認待ち」から選んでください。" };
  }

  const creditRef = text(formData, "creditRefNo");
  if (creditRef.length > 60) {
    return { error: "信販受付番号が長すぎます。信販会社から届いた番号をご確認ください。" };
  }

  const matchStatus = text(formData, "matchStatus");
  if (!MATCH_STATUSES.includes(matchStatus)) {
    return { error: "照合の状態は「照合済」「要確認」「直販」から選んでください。" };
  }

  const referrer = text(formData, "referrerCode");
  if (referrer && !/^[A-Za-z0-9-]{1,20}$/.test(referrer)) {
    return {
      error: "紹介元コードは半角の英数字で入力してください（例：RIM0003）。",
    };
  }
  if (matchStatus === "照合済" && !referrer) {
    return {
      error:
        "「照合済」は紹介元がはっきりしている受注に付けます。紹介元コードを入力するか、" +
        "紹介元がまだ分からない場合は「要確認」、紹介がない場合は「直販」を選んでください。",
    };
  }
  if (matchStatus === "直販" && referrer) {
    return {
      error:
        "「直販」は紹介元がいない受注です。紹介元コードを空にするか、" +
        "紹介元がある場合は「照合済」を選んでください。",
    };
  }

  let label = "このご注文";
  let beforeReferrer = "";
  let beforeMatch = "";
  let referrerName = "";

  try {
    const order = await selectOne<Row>(
      `orders?select=id,customer_name,review_result,credit_ref_no,match_status,referrer_code&id=eq.${id}`,
    );
    if (!order) return { error: NOT_FOUND };
    label = customerLabel(order);
    beforeReferrer = s_(order, "referrer_code");
    beforeMatch = s_(order, "match_status");

    // 払い先のないコードを入れさせない
    if (referrer) {
      const agency = await selectOne<Row>(
        `agencies?select=code,name,status&code=eq.${encodeURIComponent(referrer)}`,
      );
      if (!agency) {
        return {
          error:
            `紹介元コード「${referrer}」は代理店マスタに登録されていません。` +
            "コードの打ち間違いがないかご確認ください。まだ登録前の場合は、先に代理店を登録してください。",
        };
      }
      referrerName = s_(agency, "name");
    }

    await update(`orders?id=eq.${id}`, {
      review_result: review || null,
      credit_ref_no: creditRef || null,
      match_status: matchStatus,
      referrer_code: referrer || null,
    });
  } catch (e) {
    return failed("審査・照合の内容を保存できませんでした。", e);
  }

  /* --- すでに報酬が立っている受注で紹介元を変えたら、そのことを伝える --- */
  let rewardWarning = "";
  if (referrer !== beforeReferrer) {
    try {
      const rows = await select<Row>(`rewards?select=id&order_id=eq.${id}`);
      if (rows.length > 0) {
        rewardWarning =
          " この受注はすでに報酬が計上されています。紹介元を変えても報酬は自動では作り直されません。" +
          "下の報酬一覧をご確認のうえ、支払先の直しが必要かご判断ください。";
      }
    } catch {
      // 確認できなくても、更新そのものは終わっている
      rewardWarning = " 報酬の計上状況を確認できませんでした。下の報酬一覧をご確認ください。";
    }
  }

  await audit(await actorName(), "受注内容の更新", { type: "order", key: id }, {
    審査結果: review || "（未設定）",
    信販受付番号: creditRef || null,
    照合: `${beforeMatch || "（未設定）"} → ${matchStatus}`,
    紹介元: `${beforeReferrer || "（なし）"} → ${referrer || "（なし）"}`,
  });

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath("/rewards");

  const parts = [`${label}の内容を更新しました。`];
  parts.push(`審査結果は「${review || "未設定"}」、照合の状態は「${matchStatus}」です。`);
  if (referrer) {
    parts.push(`紹介元は ${referrer}${referrerName ? `（${referrerName}）` : ""} です。`);
  } else if (beforeReferrer) {
    parts.push("紹介元コードを空にしました。");
  }
  return { ok: parts.join("") + rewardWarning, at: Date.now() };
}
