"use server";

import { revalidatePath } from "next/cache";
import { PAYMENT_STATUSES, initialPaymentStatus } from "@/lib/payment-status";
import { currentViewer } from "@/lib/auth";
import { audit, select, selectOne, update } from "@/lib/db";
import { todayInJapan } from "@/lib/jst";
import {
  confirmRewards,
  onReviewResultChanged,
  reverseRewards,
  rewardStanding,
  type ReviewRewardOutcome,
} from "@/lib/rewards";

/**
 * 受注の更新（本部だけが行う）。
 *
 * kintone App10 でやっていた「出荷の手配」と「審査・照合の直し」をここに移す。
 * 出荷済にすると報酬が確定し、キャンセルにすると報酬が取り消される。
 * 審査結果を否決にしたときも同じく報酬を取り消す（売上に数えないものは報酬も残さない）。
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
 * 同じ受注を同時に保存したときの言葉。
 *
 * 報酬の取消は「同額のマイナスを立てる」ため、二人が同時に保存すると
 * マイナスが二組立ち、支払額を余計に差し引いてしまう。
 * あとから来たほうは何も書かずにここで止める。
 */
const RACED =
  "このご注文は、ほかの画面（別のタブや別の担当者）から先に更新されました。" +
  "報酬を二重に動かさないよう、今回の保存は行っていません。" +
  "画面を開き直して、いまの内容をご確認のうえ、もう一度お試しください。";

/**
 * 「読んだときのままの行」だけを更新するための絞り込み条件。
 *
 * 受注を読んでから更新するまでの間に、ほかの画面が同じ列を書き換えていたら、
 * この条件に合う行が無くなり、更新は0件で終わる。
 * 呼んだ側は0件を「自分は負けた」と読み替えて、報酬には触らずに止める。
 * （PostgREST は値が null の行を eq. では拾えないので、null は is.null で分ける。）
 */
function stillEquals(column: string, raw: unknown): string {
  if (raw === null || raw === undefined) return `${column}=is.null`;
  return `${column}=eq.${encodeURIComponent(String(raw))}`;
}

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

/**
 * 日付欄。空なら null、形式が違うか実在しない日付なら undefined を返す。
 *
 * 形だけを見ていると 2026-02-31 が通り、保存先が返す英語のエラーが
 * そのまま画面に出てしまうため、ここで実在するかまで確かめる。
 */
function readDate(formData: FormData, key: string): string | null | undefined {
  const v = text(formData, key);
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return undefined;
  // 「翌月の0日」＝その月の末日
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate() ? v : undefined;
}

/** 全角の英数字を半角に直す。送り状番号の貼り付け間違いを救うため。 */
function toHalfWidth(v: string): string {
  return v.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
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

/*
 * ───────── 受注の言葉 → 顧客台帳の言葉 ─────────
 *
 * 出荷や審査の状態は、受注と顧客台帳の両方が持っている。
 * 受注だけを直すと、お客様一覧が「配達完了 100%」なのに「未出荷」と出る。
 * 実際にそうなっていたので、受注を直したら顧客台帳にも写す。
 *
 * 2つの台帳で言葉が違うので、ここで言い換える。
 * データベースの値の言葉づかいは変えない（既存のデータと絞り込みが壊れるため）。
 */

/**
 * 受注の出荷状況 → 顧客台帳の出荷状況。
 *
 * 顧客台帳が持てるのは「未出荷 / 出荷手配中 / 出荷済」の3つだけで、
 * 「キャンセル」は持てない（中止は決済状況の「否決・キャンセル」で表す取り決め）。
 * キャンセルのときは null を返し、出荷状況には触らない。
 * ここで「キャンセル」を書こうとすると、顧客台帳への書き込みがまるごと失敗し、
 * 配達完了日も送り状番号も入らなくなる。
 */
function customerShipStatus(orderShipStatus: string): string | null {
  if (orderShipStatus === "キャンセル") return null;
  return orderShipStatus === "出荷待ち" ? "未出荷" : orderShipStatus;
}

/**
 * 受注の審査結果 → 顧客台帳の審査状況。
 * 「電話確認待ち」は、まだ結果が出ていないので顧客台帳では「申込中」のまま。
 * 空（未設定）のときは書き換えない（null を返す）。
 */
function customerReviewStatus(reviewResult: string): string | null {
  if (reviewResult === "承認") return "審査完了";
  if (reviewResult === "否決") return "審査NG";
  if (reviewResult === "電話確認待ち") return "申込中";
  return null;
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

/**
 * 否決を「電話確認待ち」や未設定に戻したときに、報酬がいまどうなっているかを文にする。
 *
 * 売上から外しているのは審査結果が「否決」のときだけなので（受注一覧・詳細のどちらも）、
 * 否決を解いた瞬間にその受注は売上に戻る。ところが報酬は否決のときに取り消したままで、
 * 「承認」にするまで計上し直されない。
 * この「売上には数えるのに報酬は取消のまま」という食い違いを黙って作らないよう、
 * 何もしなかったときこそ、いまの姿をはっきり伝える。
 */
async function heldRewardNote(orderId: string): Promise<string> {
  const tail = "計上し直す場合は、審査結果を「承認」にしてください。";

  let rows: Row[];
  try {
    rows = await select<Row>(`rewards?select=status,amount&order_id=eq.${orderId}`);
  } catch {
    return (
      `この受注の報酬は取り消したままになっているおそれがあります。${tail}` +
      "下の報酬一覧をご確認ください。"
    );
  }

  // 取り消されていない、金額がプラスの行（＝まだ生きている報酬）
  const live = rows.filter((r) => n_(r, "amount") > 0 && s_(r, "status") !== "取消");
  if (live.length > 0) {
    return (
      `この受注の報酬 ${live.length} 件は計上されたままです。` +
      "取り消す場合は、審査結果を「否決」にしてください。"
    );
  }

  const cancelled = rows.filter((r) => n_(r, "amount") > 0 && s_(r, "status") === "取消");
  if (cancelled.length === 0) {
    return "この受注には報酬が1件も計上されていません。";
  }
  return `この受注の報酬 ${cancelled.length} 件は取り消したままです。${tail}`;
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

  /*
   * 配達完了日。
   *
   * 受注（orders.delivered_on）と顧客台帳（customers.delivered_on）の両方に書く。
   *   受注側 … 売上・報酬はこの日付の月で数える（2026-08-26〜）。
   *            お客様1人が2件買ったときに、あとの1件で前の1件が
   *            上書きされないよう、受注ごとに持たせている。
   *   台帳側 … お客様マイページと本部の顧客一覧が見ている。
   */
  const deliveredOn = readDate(formData, "deliveredOn");
  if (deliveredOn === undefined) {
    return { error: "配達完了日は「2026-08-11」のような形式で入力してください。" };
  }

  let before = "";
  let label = "このご注文";
  let rewardNote = "";
  let deliveryNote = "";
  let customerId = "";
  /** 決済方法。キャンセルから戻すとき、お支払いの状況を初期値に返すのに使う。 */
  let paymentMethod = "";

  try {
    const order = await selectOne<Row>(
      `orders?select=id,customer_id,customer_name,ship_status,tracking_no,shipped_on,delivered_on,payment_method&id=eq.${id}`,
    );
    if (!order) return { error: NOT_FOUND };

    before = s_(order, "ship_status");
    paymentMethod = s_(order, "payment_method");
    label = customerLabel(order);
    customerId = s_(order, "customer_id");

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

    // 「読んだときの出荷状況のままの行」だけを書き換える。
    // 同じ受注を2つの画面で開いて、両方からキャンセルを保存したときに、
    // どちらも「前は出荷待ち」と読んだまま報酬の取消に進み、
    // 同じ報酬に2組のマイナスが立つのを防ぐ（勝った1回だけが下の報酬処理に進む）。
    const saved = await update<Row>(
      `orders?id=eq.${id}&${stillEquals("ship_status", order["ship_status"])}`,
      {
        ship_status: next,
        tracking_no: tracking || null,
        // 出荷済で日付が空なら、今日の日付を入れておく
        shipped_on: shippedOn ?? (next === "出荷済" ? todayInJapan() : null),
        // 売上・報酬はこの日付の月で数える
        delivered_on: next === "キャンセル" ? null : deliveredOn,
      },
    );
    if (saved.length === 0) {
      // 自分が読んでから保存するまでの間に、ほかの画面が出荷状況を変えた。
      // 報酬には触らずに終える。
      await audit(await actorName(), "出荷状況の更新の中止", { type: "order", key: id }, {
        理由: "ほかの画面が先に更新した",
        読んだときの出荷状況: before || "（未設定）",
        保存しようとした出荷状況: next,
      });
      return { error: RACED };
    }
  } catch (e) {
    return failed("出荷状況を保存できませんでした。", e);
  }

  /* --- 報酬の確定・取消 --- */
  // 取消をするかどうかは「前の出荷状況」では決めない。
  // 出荷状況は上ですでに「キャンセル」で保存してしまうため、
  // 報酬の取消に失敗したあとにやり直すと「前もキャンセル」になり、
  // 報酬が生きたまま二度と取り消せなくなるため。
  // 判断材料は報酬側の今の姿（取り消されていない、プラスの報酬が残っているか）にする。
  /*
   * 報酬を確定させるのは「配達完了日が入ったとき」。
   *
   * 2026-08-07 の会議で「報酬確定を配送完了ベースにする」と決まっていたが、
   * 実装は出荷済で確定していた（lib/rewards.ts のコメントだけが正しかった）。
   * 2026-08-26 に売上・報酬も配達完了で切るようにしたので、ここも揃える。
   */
  const nowDelivered = Boolean(deliveredOn) && next !== "キャンセル";
  let touchRewards = nowDelivered;
  if (next === "キャンセル") {
    let rewardRows: Row[];
    try {
      // cancel_reason まで読む。読み落とすと、支払済のまま相殺した報酬を
      // 「まだ生きている」と数えてしまい、下の halfDone が誤って立つ。
      rewardRows = await select<Row>(
        `rewards?select=id,status,amount,cancel_reason&order_id=eq.${id}`,
      );
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

    /*
     * 報酬がいまどうなっているかの判断は rewardStanding（lib/rewards.ts）に任せる。
     *
     * ここで status だけを見て数えていたため、すでに相殺した「支払済」の報酬を
     * 「まだ生きている」と数えていた。支払済の報酬は打ち切ったあとも
     * status が「支払済」のまま残り、取消の理由（cancel_reason）で見分ける決まりのため。
     * その結果、支払済の報酬があった受注をキャンセルすると、
     * 2回目以降は保存のたびに「取消が途中で止まっています」と出続け、
     * 送り状番号も配達完了日も入れられなくなっていた（帳簿は正しいのに操作だけが止まる）。
     * 審査側（updateOrderAction）は同じ判断を rewardStanding で行っているので、そこに揃える。
     */
    const standing = rewardStanding(rewardRows);
    const live = standing.live;
    const offset = standing.offsets;
    const cancelled = standing.reversed;

    if (live > 0 && standing.halfDone) {
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
      rewardCount = nowDelivered
        ? await confirmRewards(id)
        : await reverseRewards(id, "受注のキャンセル");
      if (rewardCount > 0) {
        rewardNote = nowDelivered
          ? `この受注の報酬 ${rewardCount} 件を確定しました。`
          : `この受注の報酬 ${rewardCount} 件を取り消しました（同額のマイナスを立てて相殺しています）。`;
      } else {
        rewardNote = await noRewardNote(id, nowDelivered);
      }
    } catch (e) {
      // 出荷の記録は済んでいる。報酬だけが残っている状態を、はっきり伝える。
      await audit(
        await actorName(),
        nowDelivered ? "報酬確定の失敗" : "報酬取消の失敗",
        { type: "order", key: id },
        { 出荷状況: next, 理由: reason(e) },
      );
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          `出荷状況は「${next}」に保存しましたが、報酬の${nowDelivered ? "確定" : "取消"}に失敗しました。` +
          `${reason(e)} 下の報酬一覧をご確認のうえ、もう一度この操作を行ってください。`,
        at: Date.now(),
      };
    }
  }

  /*
   * 配達完了日を顧客台帳に書く。
   *
   * ここで失敗しても出荷の記録と報酬はそのままにする（配達日は後から入れ直せる）。
   * 受注に顧客が紐づいていないときは書けないので、その旨をそのまま伝える。
   * 黙って何もしないと「入れたのに進捗が変わらない」と見えてしまうため。
   */
  if (!customerId) {
    if (deliveredOn) {
      deliveryNote =
        "配達完了日は保存できませんでした。このご注文はまだお客様と結びついていません。" +
        "お客様を紐づけてから、もう一度お試しください。";
    }
  } else {
    try {
      const mirrorShip = customerShipStatus(next);
      await update<Row>(`customers?id=eq.${encodeURIComponent(customerId)}`, {
        delivered_on: deliveredOn,
        tracking_no: tracking || null,
        // 出荷の状態も顧客台帳に写す（キャンセルのときは触らない）
        ...(mirrorShip ? { ship_status: mirrorShip } : {}),
        /*
         * キャンセルはお客様の決済状況で表す。
         * 進み具合（components/Progress.tsx）は決済状況の「否決・キャンセル」を
         * 見て「中止」と出すため、ここを揃えないと止まった案件が進行中に見える。
         *
         * キャンセルから戻すときは、この印を外さないと進み具合が「中止」のまま残る。
         * 戻す先は決済方法から見た初期値にする
         * （クレジットカードは決済完了、銀行振込・アプラスは着金待ち）。
         * 実際のお支払いの状況は受注側で管理しているので、
         * ここは進み具合が動く状態に戻せれば足りる。
         */
        ...(next === "キャンセル"
          ? { payment_status: "否決・キャンセル" }
          : before === "キャンセル"
            ? { payment_status: initialPaymentStatus(paymentMethod) }
            : {}),
      });
      deliveryNote = deliveredOn ? `配達完了日を ${deliveredOn} として記録しました。` : "";
    } catch (e) {
      await audit(await actorName(), "顧客台帳への反映の失敗", { type: "order", key: id }, {
        顧客: customerId,
        配達完了日: deliveredOn,
        出荷状況: customerShipStatus(next),
        理由: reason(e),
      });
      deliveryNote =
        `お客様の台帳に反映できませんでした。${reason(e)} ` +
        "お客様一覧の進み具合が古いままになっています。";
    }
  }

  await audit(await actorName(), "出荷状況の更新", { type: "order", key: id }, {
    前: before || "（未設定）",
    後: next,
    送り状番号: tracking || null,
    出荷日: shippedOn ?? (next === "出荷済" ? todayInJapan() : null),
    配達完了日: deliveredOn,
    // 0件だったことも残す。あとから「なぜ報酬が立っていないのか」を追えるようにする。
    報酬件数: rewardCount,
  });

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath("/rewards");
  revalidatePath("/dashboard");
  // 進捗は顧客の画面にも出るので、そちらも作り直す
  revalidatePath("/customers");
  revalidatePath("/admin/customers");

  const backwards = before === "出荷済" && next !== "出荷済" && next !== "キャンセル";
  return {
    ok:
      `${label}の出荷状況を「${next}」に更新しました。` +
      (rewardNote ? ` ${rewardNote}` : "") +
      (deliveryNote ? ` ${deliveryNote}` : "") +
      (backwards
        ? " すでに確定した報酬はそのまま残ります。報酬まで取り消す場合は「キャンセル」を選んでください。"
        : ""),
    at: Date.now(),
  };
}

/* ══════════════════════ 審査・照合の更新 ══════════════════════ */

/**
 * 審査結果・信販受付番号・照合状態・紹介元コード・担当スタッフのコードを直す。
 *
 * 紹介元コードと担当スタッフのコードは、どちらも代理店マスタに実在するコードだけを通す。
 * 紹介元は報酬の支払先そのもので（払い先の無い報酬を作らないため）、
 * 担当スタッフは「誰が売ったか」の裏付けになるので、打ち間違いをその場で弾く。
 *
 * 審査結果を変えると報酬が動く（否決＝取消／否決から承認に戻す＝計上し直し）。
 * 同じ値のまま保存し直しても報酬に触らないよう、実際に変わったときだけ呼ぶ。
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

  // 否決にするときの理由（信販の否決通知番号など）。任意。
  // 報酬の取消理由としてそのまま残すので、あとから「なぜ取り消したか」を追える。
  const rejectReason = text(formData, "rejectReason");
  if (rejectReason.length > 100) {
    return {
      error:
        "否決の理由が長すぎます。100文字以内で、信販の否決通知番号など要点だけを入力してください。",
    };
  }

  const matchStatus = text(formData, "matchStatus");
  if (!MATCH_STATUSES.includes(matchStatus)) {
    return { error: "照合の状態は「照合済」「要確認」「直販」から選んでください。" };
  }

  /*
   * お支払い（着金待ち／決済完了）。2026-08-27 会議で追加。
   * 銀行振込・アプラスの着金を本部が確認して、手で「決済完了」に変える欄。
   * 欄を出していない古い画面から届いたときは空で、その場合は何も変えない。
   */
  const paymentStatus = text(formData, "paymentStatus");
  if (paymentStatus && !(PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
    return { error: "お支払いは「着金待ち」「決済完了」から選んでください。" };
  }

  /*
   * アプラスの申込URLを送ったかどうか。2026-08-27 会議で追加。
   *
   * アプラスはAPIで連携できないので、担当者がお客様へ申込URLをメールで送る。
   * 送ったつもりで送れていないと、審査が始まらないまま受注が着金待ちで止まり、
   * 誰も気づかない。送った日時を残して、一覧から見えるようにする。
   * 「送った」「取り消す」のどちらでもないときは空で届くので、その場合は触らない。
   */
  const aplusSent = text(formData, "aplusUrlSent");
  if (aplusSent && aplusSent !== "sent" && aplusSent !== "clear") {
    return { error: "アプラスの申込URLの状態を読み取れませんでした。" };
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

  /*
   * 担当スタッフのコード。
   * 空欄で保存しても、いま記録されているコードは消さない。
   * この欄は申込の取り込みで自動的に入る（誰が売ったかの記録）ので、
   * 審査結果を直すつもりの保存で消えてしまうと、本部が代理店ごとの支払いを検証できなくなる。
   * 消すときは、画面のチェックで「空にする」とはっきり伝えてもらう。
   */
  const staff = text(formData, "staffCode");
  const clearStaff = text(formData, "clearStaffCode") === "true";
  if (staff && !/^[A-Za-z0-9-]{1,20}$/.test(staff)) {
    return {
      error: "担当スタッフのコードは半角の英数字で入力してください（例：MENO0001）。",
    };
  }

  let label = "このご注文";
  let beforeReferrer = "";
  let beforeMatch = "";
  let beforeReview = "";
  let beforeStaff = "";
  let referrerName = "";
  let staffName = "";
  let staffKind = "";
  let reviewCustomerId = "";
  let mirrorNote = "";

  try {
    const order = await selectOne<Row>(
      `orders?select=id,customer_id,customer_name,review_result,credit_ref_no,match_status,referrer_code,staff_code&id=eq.${id}`,
    );
    if (!order) return { error: NOT_FOUND };
    label = customerLabel(order);
    beforeReferrer = s_(order, "referrer_code");
    beforeMatch = s_(order, "match_status");
    beforeReview = s_(order, "review_result");
    beforeStaff = s_(order, "staff_code");
    reviewCustomerId = s_(order, "customer_id");

    // 否決も、出荷の「キャンセル」と同じで報酬の取消につながる。
    // プルダウンを選んで一度保存するだけでマイナスが立ってしまわないよう、
    // 確認を通っていなければ、審査結果を書き換える前に止める。
    // すでに否決の受注をもう一度保存するとき（前回失敗した取消のやり直しなど）は、
    // 画面に確認欄が出ないうえ、確認はその1回目に済んでいるので求めない。
    if (review === "否決" && beforeReview !== "否決" && text(formData, "confirmReject") !== "true") {
      return {
        error:
          "審査結果を「否決」にすると、この受注から発生した報酬が取り消されます。" +
          "確認のチェックを入れてから、もう一度お試しください。",
      };
    }

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

    // 担当スタッフも、実在するコードだけを通す（打ち間違いをそのまま記録しない）
    if (staff) {
      const person = await selectOne<Row>(
        `agencies?select=code,name,code_kind&code=eq.${encodeURIComponent(staff)}`,
      );
      if (!person) {
        return {
          error:
            `担当スタッフのコード「${staff}」は代理店一覧に登録されていません。` +
            "コードの打ち間違いがないかご確認ください。まだ登録前の方の場合は、先にスタッフを登録してください。",
        };
      }
      staffName = s_(person, "name");
      staffKind = s_(person, "code_kind");
    }

    const patch: Record<string, string | null> = {
      review_result: review || null,
      credit_ref_no: creditRef || null,
      match_status: matchStatus,
      referrer_code: referrer || null,
    };

    // 空欄のときは、はっきり「空にする」と言われた場合だけ消す
    if (staff) patch.staff_code = staff;
    else if (clearStaff) patch.staff_code = null;

    // 「読んだときの審査結果のままの行」だけを書き換える。
    // 同じ受注を2つの画面で開いて、両方から否決を保存したときに、
    // どちらも「前は承認」と読んだまま報酬の取消に進み、
    // 同じ報酬に2組のマイナスが立つのを防ぐ。
    // 更新できた1回だけが下の報酬処理に進み、負けたほうは何もせずに終わる。
    // 審査結果を変えない保存（照合や紹介元だけを直すとき）は、値が同じなので条件に合い、
    // これまでどおり通る。
    const saved = await update<Row>(
      `orders?id=eq.${id}&${stillEquals("review_result", order["review_result"])}`,
      patch,
    );
    if (saved.length === 0) {
      // 自分が読んでから保存するまでの間に、ほかの画面が審査結果を変えた。
      // 報酬には触らずに終える。
      await audit(await actorName(), "受注内容の更新の中止", { type: "order", key: id }, {
        理由: "ほかの画面が先に更新した",
        読んだときの審査結果: beforeReview || "（未設定）",
        保存しようとした審査結果: review || "（未設定）",
      });
      return { error: RACED };
    }

    /*
     * お支払いは別枠で保存する。
     * payment_status の列がまだ無い環境でも、審査・照合の保存まで
     * 巻き添えで失敗しないようにするため。
     * お客様側（customers.payment_status）にも写す。顧客一覧と
     * 代理店の顧客管理は、そちらを見ているため。
     */
    if (paymentStatus) {
      try {
        await update(`orders?id=eq.${id}`, { payment_status: paymentStatus });
        if (reviewCustomerId && /^\d+$/.test(reviewCustomerId)) {
          await update(`customers?id=eq.${reviewCustomerId}`, {
            payment_status: paymentStatus,
          });
        }
      } catch {
        // 列がまだ無い。supabase/migrations の payment_status を流すと保存できる。
      }
    }

    /*
     * アプラスの申込URLの送付記録も別枠で保存する。
     * こちらも列がまだ無い環境で、審査・照合の保存を巻き添えにしないため。
     */
    if (aplusSent) {
      try {
        await update(`orders?id=eq.${id}`, {
          aplus_url_sent_at: aplusSent === "sent" ? new Date().toISOString() : null,
        });
      } catch {
        // 列がまだ無い。supabase/migrations の aplus_url_sent を流すと保存できる。
      }
    }
  } catch (e) {
    return failed("審査・照合の内容を保存できませんでした。", e);
  }

  /* --- 審査結果が変わったときだけ、報酬を動かす --- */
  // 同じ値のまま保存し直したときに走らせない。走らせると、
  // 否決の受注を保存するたびにマイナスが増え、支払額を余計に差し引いてしまう。
  let outcome: ReviewRewardOutcome | null = null;
  if (review !== beforeReview) {
    try {
      // 否決のときだけ、本部が書いた理由を報酬の取消理由として渡す。
      outcome = await onReviewResultChanged(id, review, review === "否決" ? rejectReason : "");
    } catch (e) {
      // 審査結果の保存は済んでいる。報酬だけが取り残された状態を、はっきり伝える。
      await audit(await actorName(), "審査結果に伴う報酬処理の失敗", { type: "order", key: id }, {
        審査結果: `${beforeReview || "（未設定）"} → ${review || "（未設定）"}`,
        理由: reason(e),
      });
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          `審査結果は「${review || "未設定"}」に保存しましたが、報酬の処理に失敗しました。${reason(e)} ` +
          "下の報酬一覧をご確認のうえ、もう一度この操作を行ってください。",
        at: Date.now(),
      };
    }

    if (outcome.action === "中断") {
      await audit(await actorName(), "報酬取消の中断", { type: "order", key: id }, {
        審査結果: `${beforeReview || "（未設定）"} → ${review || "（未設定）"}`,
        理由: outcome.reason,
      });
      revalidatePath("/admin/orders");
      revalidatePath(`/admin/orders/${id}`);
      return {
        error:
          `審査結果は「${review || "未設定"}」に保存しました。ただし、${outcome.reason}` +
          "下の報酬一覧をご確認のうえ、担当者にご連絡ください。",
        at: Date.now(),
      };
    }
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

  /*
   * 審査結果と担当スタッフを顧客台帳にも写す。
   * お客様一覧の進み具合は顧客台帳の審査状況を見ているため、
   * 受注だけを直すと「承認したのに申込中のまま」になる。
   * 写せなくても受注の更新は取り消さない（あとから直せるため）。
   */
  const reviewMirror = customerReviewStatus(review);
  if (reviewCustomerId && (reviewMirror || staff || clearStaff)) {
    const patch: Record<string, unknown> = {};
    if (reviewMirror) patch["review_status"] = reviewMirror;
    // 否決は決済状況にも出す（進み具合が「中止」になる）。
    // 承認に戻したときは決済状況を触らない。実際に決済が通ったかは別の話なので、
    // ここで「決済完了」に書き換えてしまうと事実と違う値が入る。
    if (review === "否決") patch["payment_status"] = "否決・キャンセル";
    if (staff) patch["staff_code"] = staff;
    else if (clearStaff) patch["staff_code"] = null;
    try {
      await update<Row>(
        `customers?id=eq.${encodeURIComponent(reviewCustomerId)}`,
        patch,
      );
    } catch (e) {
      await audit(await actorName(), "顧客台帳への反映の失敗", { type: "order", key: id }, {
        顧客: reviewCustomerId,
        審査状況: reviewMirror,
        理由: reason(e),
      });
      mirrorNote =
        `お客様の台帳には反映できませんでした。${reason(e)} ` +
        "お客様一覧の進み具合が古いままになっています。";
    }
  }

  await audit(await actorName(), "受注内容の更新", { type: "order", key: id }, {
    審査結果: `${beforeReview || "（未設定）"} → ${review || "（未設定）"}`,
    顧客台帳の審査状況: reviewMirror,
    信販受付番号: creditRef || null,
    照合: `${beforeMatch || "（未設定）"} → ${matchStatus}`,
    紹介元: `${beforeReferrer || "（なし）"} → ${referrer || "（なし）"}`,
    担当スタッフ: staff
      ? `${beforeStaff || "（なし）"} → ${staff}`
      : clearStaff && beforeStaff
        ? `${beforeStaff} → （なし）`
        : null,
    // 0件だったことも残す。あとから「なぜ報酬が動いていないのか」を追えるようにする。
    報酬: outcome ? `${outcome.action}${outcome.count > 0 ? ` ${outcome.count} 件` : ""}` : null,
    否決の理由: review === "否決" && review !== beforeReview ? rejectReason || null : null,
  });

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath("/rewards");
  if (outcome && outcome.count > 0) revalidatePath("/dashboard");
  revalidatePath("/customers");
  revalidatePath("/admin/customers");

  const parts = [`${label}の内容を更新しました。`];
  parts.push(`審査結果は「${review || "未設定"}」、照合の状態は「${matchStatus}」です。`);
  if (referrer) {
    parts.push(`紹介元は ${referrer}${referrerName ? `（${referrerName}）` : ""} です。`);
  } else if (beforeReferrer) {
    parts.push("紹介元コードを空にしました。");
  }

  /* --- 担当スタッフ（誰が売ったか） --- */
  if (staff && staff !== beforeStaff) {
    parts.push(
      `担当スタッフを ${staff}${staffName ? `（${staffName}）` : ""} にしました。` +
        // スタッフ以外のコード（会社・取次パートナー）でも記録は許すが、気づけるようにしておく
        (staffKind && staffKind !== "02"
          ? "このコードはスタッフ（区分02）として登録されていません。相違がないかご確認ください。"
          : ""),
    );
  } else if (!staff && clearStaff && beforeStaff) {
    parts.push("担当スタッフのコードを空にしました。");
  }

  /* --- 審査結果に伴う報酬の動き --- */
  // 何もしなかったときも、その理由をそのまま伝える。
  // 「更新しました」とだけ返すと、報酬が取り消されていない否決の受注を見落とすため。
  if (outcome) {
    if (outcome.action === "取消") {
      parts.push(
        `審査が否決になったため、この受注の報酬 ${outcome.count} 件を取り消しました` +
          "（同額のマイナスを立てて相殺しています）。" +
          // 書いてもらった理由は、報酬の取消理由としてそのまま残る。残したことを伝える。
          (rejectReason ? `取消の理由として「${rejectReason}」を残しました。` : ""),
      );
    } else if (outcome.action === "計上し直し") {
      parts.push(
        `審査が承認に戻ったため、この受注の報酬 ${outcome.count} 件を計上し直しました` +
          "（取り消した分は帳簿に残したままです）。" +
          (outcome.reason ? outcome.reason : ""),
      );
    } else if (beforeReview === "否決" && review !== "承認") {
      // 否決を「電話確認待ち」や未設定に戻したとき。
      // 「承認」に戻したのに何も動かなかった場合は、そのときの理由
      //（すでに計上済み・出荷状況がキャンセル など）のほうが大事なので、下の枝に任せる。
      // この受注は売上に戻る（売上から外しているのは「否決」のときだけ）のに、
      // 報酬は取り消したままになる。lib/rewards.ts が返す
      // 「審査の結果が出るまで、報酬はそのままにしています。」では実態が伝わらないため、
      // 報酬の今の姿を調べて言い換える。
      parts.push(await heldRewardNote(id));
    } else if (outcome.reason) {
      // 承認・否決に限らず、何もしなかった理由は必ず添える。
      parts.push(outcome.reason);
    }
  }

  if (mirrorNote) parts.push(mirrorNote);

  return { ok: parts.join("") + rewardWarning, at: Date.now() };
}
