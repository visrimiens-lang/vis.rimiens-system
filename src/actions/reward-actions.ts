"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { bankReady as bankReadyShared } from "@/lib/bank";
import { audit, selectOne, update } from "@/lib/db";
import { todayInJapan } from "@/lib/jst";

/**
 * 報酬の支払い（本部だけが行う）。
 *
 * 月次の締めで本部がやることは3つしかない。
 *   ・その月に「確定」した報酬を、代理店ごとにまとめて支払済にする
 *   ・1件だけ支払済にする（あとから届いた分の追い払いなど）
 *   ・間違えて支払済にしたものを、支払済の前（確定）に戻す
 *
 * 報酬そのものの計上・確定・取消は src/lib/rewards.ts が持っている。
 * ここは「お金を振り込んだ事実の記録」だけを扱い、金額の計算はしない。
 *
 * ■ ここで守っている約束（お金に直結するので、画面側だけの制限にしない）
 *
 *   1. 「未確定」は支払済にしない
 *      未確定は、まだ商品が届いていない報酬。配送完了で「確定」に変わる。
 *      ここを飛ばして振り込むと、キャンセルされたときに返金を追いかけることになる。
 *
 *   2. 金額がマイナスの行（取消の相殺）は支払済にしない
 *      キャンセルの相殺は、翌月以降の振込額から差し引くためのもの。
 *      支払済にしてしまうと「マイナスを振り込んだ」記録が残り、
 *      差し引き忘れにも気づけなくなる。
 *
 *   3. 振込先が未登録の代理店は支払済にできない
 *      どこに振り込んだのかを残せない支払記録は、あとから確かめようがない。
 *
 * ■ 画面への返し方
 *
 * この画面はサーバーコンポーネントのまま（部品の状態を持たない）にしてあるので、
 * 操作の結果は戻り値ではなく、戻り先の URL に短い合図（result）を付けて伝える。
 * 文言は画面側（src/app/(app)/admin/rewards/page.tsx）に置いてある。
 * URL に金額と件数以外の情報（代理店名・口座番号など）は載せない。
 */

const BASE = "/admin/rewards";

/** rewards.status に入れてよい値。 */
const CONFIRMED = "確定";
const PAID = "支払済";

type Row = Record<string, unknown>;

const s_ = (r: Row | null, k: string): string => {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

const n_ = (r: Row | null, k: string): number => {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/* ══════════════════ 画面から届いた値の検分 ══════════════════ */

/**
 * 戻り先の URL に引き継ぐもの。
 * 並び順や絞り込みが操作のたびに外れると、本部が同じ画面を作り直すことになる。
 * どれも画面から届く値なので、そのまま URL に戻さず、決められた形だけを通す。
 */
type Nav = {
  month: string;
  sort: string;
  dir: string;
  status: string;
  open: string;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CODE_RE = /^[A-Za-z0-9-]{1,20}$/;
const REWARD_STATUSES = ["未確定", "確定", "支払済", "取消"];

function readNav(formData: FormData): Nav {
  const month = text(formData, "month");
  const sort = text(formData, "sort");
  const dir = text(formData, "dir");
  const status = text(formData, "status");
  const open = text(formData, "open");
  return {
    month: MONTH_RE.test(month) ? month : "",
    sort: /^[a-z]{1,12}$/.test(sort) ? sort : "",
    dir: dir === "desc" || dir === "asc" ? dir : "",
    status: REWARD_STATUSES.includes(status) ? status : "",
    open: CODE_RE.test(open) ? open : "",
  };
}

/** 操作の結果を伝える合図。文言は画面側が持つ。 */
type Result =
  | "paid" // まとめて支払済にした
  | "paid1" // 1件だけ支払済にした
  | "undone" // 支払済を取り消した
  | "none" // 支払える報酬が1件も無かった
  | "e_perm" // 本部以外が操作した
  | "e_month" // 対象月が読み取れない
  | "e_code" // 代理店コードが読み取れない
  | "e_agency" // 代理店が見つからない
  | "e_bank" // 振込先が未登録
  | "e_row" // 対象の報酬が見つからない
  | "e_status" // その状態からは変えられない
  | "e_minus" // マイナス（取消の相殺）は支払わない
  | "e_save"; // 保存に失敗した

/** 戻り先の URL。件数と金額だけを添える。 */
function backHref(
  nav: Nav,
  result: Result,
  extra: { count?: number; amount?: number; code?: string } = {},
): string {
  const q = new URLSearchParams();
  if (nav.month) q.set("month", nav.month);
  if (nav.sort) q.set("sort", nav.sort);
  if (nav.dir) q.set("dir", nav.dir);
  if (nav.status) q.set("status", nav.status);
  if (nav.open) q.set("open", nav.open);
  q.set("done", result);
  if (extra.count !== undefined) q.set("n", String(extra.count));
  if (extra.amount !== undefined) q.set("amt", String(Math.round(extra.amount)));
  if (extra.code && CODE_RE.test(extra.code)) q.set("target", extra.code);
  return `${BASE}?${q.toString()}`;
}

/** 本部かどうか。すべての書き込みの入口で必ず通す。 */
async function hqLabel(): Promise<string | null> {
  const viewer = await currentViewer();
  if (!viewer || viewer.kind !== "hq") return null;
  return viewer.label || "本部";
}

/**
 * 振込先がそろっているか。
 *
 * 金融機関名・支店名・口座番号・口座名義のどれかが欠けていると、
 * 振込の記録として残せない（誰にいくら払ったのかを後から確かめられない）。
 * 預金の種類は、実際の振込では要るが、過去に登録した代理店で空のままのものがあり、
 * ここで止めると支払い自体ができなくなるため、支払いは通して画面で注意だけ出す。
 */
function bankReady(agency: Row | null): boolean {
  if (!agency) return false;
  // 判定の中身は src/lib/bank.ts に1つだけ置いてある（画面側と揃えるため）
  return bankReadyShared({
    bankName: s_(agency, "bank_name"),
    bankBranch: s_(agency, "bank_branch"),
    accountNo: s_(agency, "account_no"),
    accountHolder: s_(agency, "account_holder"),
  });
}

/** 振込先を、記録に残してよい形にする（口座番号は残さない）。 */
function bankNote(agency: Row | null): string {
  const bank = s_(agency, "bank_name");
  const branch = s_(agency, "bank_branch");
  return [bank, branch].filter(Boolean).join(" ") || "（未登録）";
}

function sumOf(rows: Row[]): number {
  return rows.reduce((total, r) => total + n_(r, "amount"), 0);
}

/** 書き込んだあとに読み直してほしい画面。 */
function refresh(): void {
  revalidatePath(BASE);
  revalidatePath("/rewards");
  revalidatePath("/dashboard");
}

/* ══════════════ 確定した報酬をまとめて支払済にする ══════════════ */

/**
 * 代理店1社ぶんの、その月の「確定」報酬をまとめて支払済にする。
 *
 * 画面から届く代理店コードと対象月しか使わない。件数も金額も、
 * 画面に出ていた値ではなく、ここで保存先から引き直したものを記録する
 * （確認の画面を開いたあとに配送完了が増えることがあるため）。
 */
export async function payMonthAction(formData: FormData): Promise<void> {
  const nav = readNav(formData);
  const actor = await hqLabel();
  if (!actor) redirect(backHref(nav, "e_perm"));

  // 対象月は戻り先にも使うので、readNav が検分した値をそのまま使う。
  const month = nav.month;
  if (!month) redirect(backHref(nav, "e_month"));

  const code = text(formData, "code");
  if (!CODE_RE.test(code)) redirect(backHref(nav, "e_code"));

  let outcome: { result: Result; count?: number; amount?: number };

  try {
    const agency = await selectOne<Row>(
      `agencies?select=code,name,bank_name,bank_branch,account_type,account_no,account_holder` +
        `&code=eq.${encodeURIComponent(code)}`,
    );

    if (!agency) {
      outcome = { result: "e_agency" };
    } else if (!bankReady(agency)) {
      // 振り込んだ記録が残せないので、状態は一切変えない。
      await audit(actor, "報酬の支払を中止（振込先が未登録）", { type: "agency", key: code }, {
        対象月: month,
      });
      outcome = { result: "e_bank" };
    } else {
      // マイナス（取消の相殺）は支払わない。翌月以降の振込額から差し引くためのもの。
      const filter =
        `agency_code=eq.${encodeURIComponent(code)}` +
        `&month=eq.${encodeURIComponent(month)}` +
        `&status=eq.${encodeURIComponent(CONFIRMED)}` +
        `&amount=gt.0`;

      // 何件を支払ったかは、書き換える前に数えた件数ではなく、
      // 実際に書き換わった行で数える。確認の画面を開いたあとに
      // 別のタブや別の担当者が先に支払済にしていると、ここが0件になる。
      // 0件のときは振り込んだ事実が無いので、支払いの記録も残さない。
      const paid = await update<Row>(`rewards?${filter}`, {
        status: PAID,
        paid_on: todayInJapan(),
      });

      if (paid.length === 0) {
        outcome = { result: "none" };
      } else {
        const amount = sumOf(paid);
        await audit(actor, "報酬の支払（まとめて）", { type: "agency", key: code }, {
          対象月: month,
          件数: paid.length,
          合計: amount,
          支払日: todayInJapan(),
          振込先: bankNote(agency),
        });
        outcome = { result: "paid", count: paid.length, amount };
      }
    }
  } catch (e) {
    await audit(actor, "報酬の支払に失敗", { type: "agency", key: code }, {
      対象月: month,
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
    });
    outcome = { result: "e_save" };
  }

  refresh();
  redirect(
    backHref(nav, outcome.result, {
      count: outcome.count,
      amount: outcome.amount,
      code,
    }),
  );
}

/* ══════════════════ 1件だけ支払済にする ══════════════════ */

/**
 * 明細の1行だけを支払済にする。
 *
 * まとめての支払いと同じ条件を、1件でも必ず通す。
 * 「未確定」を飛ばして支払済にできてしまうと、配送完了前の報酬を
 * 振り込むことになるため、状態は保存先から引き直して確かめる。
 */
export async function payOneAction(formData: FormData): Promise<void> {
  const nav = readNav(formData);
  const actor = await hqLabel();
  if (!actor) redirect(backHref(nav, "e_perm"));

  const id = text(formData, "rewardId");
  if (!/^\d+$/.test(id)) redirect(backHref(nav, "e_row"));

  let outcome: { result: Result; count?: number; amount?: number; code?: string };

  try {
    const reward = await selectOne<Row>(
      `rewards?select=id,agency_code,month,amount,status&id=eq.${id}`,
    );
    const code = s_(reward, "agency_code");

    if (!reward) {
      outcome = { result: "e_row" };
    } else if (n_(reward, "amount") <= 0) {
      // 取消の相殺（マイナス）。支払いの対象にしない。
      outcome = { result: "e_minus", code };
    } else if (s_(reward, "status") !== CONFIRMED) {
      // 未確定・支払済・取消のいずれか。どれも「確定」を通さずには支払わない。
      outcome = { result: "e_status", code };
    } else {
      const agency = await selectOne<Row>(
        `agencies?select=code,name,bank_name,bank_branch,account_type,account_no,account_holder` +
          `&code=eq.${encodeURIComponent(code)}`,
      );
      if (!agency) {
        outcome = { result: "e_agency", code };
      } else if (!bankReady(agency)) {
        outcome = { result: "e_bank", code };
      } else {
        // いま「確定」のものだけを書き換える。画面を開いたあとに
        // 誰かが先に支払済にしていたら、ここで0件になって二重払いを防げる。
        const paid = await update<Row>(
          `rewards?id=eq.${id}&status=eq.${encodeURIComponent(CONFIRMED)}`,
          { status: PAID, paid_on: todayInJapan() },
        );
        if (paid.length === 0) {
          outcome = { result: "e_status", code };
        } else {
          const amount = sumOf(paid);
          await audit(actor, "報酬の支払（1件）", { type: "reward", key: id }, {
            代理店: code,
            対象月: s_(reward, "month"),
            金額: amount,
            支払日: todayInJapan(),
            振込先: bankNote(agency),
          });
          outcome = { result: "paid1", count: 1, amount, code };
        }
      }
    }
  } catch (e) {
    await audit(actor, "報酬の支払に失敗（1件）", { type: "reward", key: id }, {
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
    });
    outcome = { result: "e_save" };
  }

  refresh();
  redirect(
    backHref(nav, outcome.result, {
      count: outcome.count,
      amount: outcome.amount,
      code: outcome.code,
    }),
  );
}

/* ════════════════ 支払済を取り消して確定に戻す ════════════════ */

/**
 * 間違えて支払済にした1件を、支払う前（確定）に戻す。
 *
 * 報酬そのものを消すわけではないので、金額も対象月もそのまま残す。
 * 支払日だけを消して、次の締めでもう一度支払いの対象に出るようにする。
 * 「取消（キャンセルの相殺）」はここでは扱わない。受注をキャンセルすると
 * src/lib/rewards.ts が同額のマイナスを立てて相殺する仕組みになっている。
 */
export async function undoPayAction(formData: FormData): Promise<void> {
  const nav = readNav(formData);
  const actor = await hqLabel();
  if (!actor) redirect(backHref(nav, "e_perm"));

  const id = text(formData, "rewardId");
  if (!/^\d+$/.test(id)) redirect(backHref(nav, "e_row"));

  let outcome: { result: Result; count?: number; amount?: number; code?: string };

  try {
    const reward = await selectOne<Row>(
      `rewards?select=id,agency_code,month,amount,status,paid_on&id=eq.${id}`,
    );
    const code = s_(reward, "agency_code");

    if (!reward) {
      outcome = { result: "e_row" };
    } else if (s_(reward, "status") !== PAID) {
      outcome = { result: "e_status", code };
    } else {
      const back = await update<Row>(
        `rewards?id=eq.${id}&status=eq.${encodeURIComponent(PAID)}`,
        { status: CONFIRMED, paid_on: null },
      );
      if (back.length === 0) {
        outcome = { result: "e_status", code };
      } else {
        const amount = sumOf(back);
        await audit(actor, "報酬の支払を取り消し", { type: "reward", key: id }, {
          代理店: code,
          対象月: s_(reward, "month"),
          金額: amount,
          取り消した支払日: s_(reward, "paid_on") || "（記録なし）",
        });
        outcome = { result: "undone", count: 1, amount, code };
      }
    }
  } catch (e) {
    await audit(actor, "報酬の支払取り消しに失敗", { type: "reward", key: id }, {
      理由: e instanceof Error ? e.message : "原因を特定できませんでした。",
    });
    outcome = { result: "e_save" };
  }

  refresh();
  redirect(
    backHref(nav, outcome.result, {
      count: outcome.count,
      amount: outcome.amount,
      code: outcome.code,
    }),
  );
}
