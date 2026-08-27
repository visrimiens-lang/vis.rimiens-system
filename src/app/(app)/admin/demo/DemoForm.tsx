"use client";

import { Fragment, useActionState, useId, useState } from "react";
import {
  createDemoAction,
  lendDemoAction,
  returnDemoAction,
  updateDemoAction,
  type DemoFormState,
} from "@/actions/demo-actions";
import { Badge, Notice, Td } from "@/components/ui";

/* ------------------------------------------------------------------
 * 本部のデモ機台帳の、登録フォームと一覧の行。
 *
 * 会議での指摘（デモ機登録フォームの「使用者名」は、実際には
 * その端末を預かっている責任者の名前）にあわせ、この画面では
 * 「保有者（責任者）」という呼び方で統一している。
 * ------------------------------------------------------------------ */

/** デモ機1台ぶんの内容。 */
export type DemoView = {
  id: string;
  serialNo: string;
  model: string;
  acquiredKind: string;
  acquiredOn: string;
  state: string;
  holderCode: string;
  /** 保有者（責任者）の名前。 */
  holderName: string;
  /** 申込者が名乗った会社名（デモ機登録フォームの「自社会社名」）。 */
  ownerCompany: string;
  customerName: string;
  lendTo: string;
  lendOn: string;
  returnDueOn: string;
  returnedOn: string;
  purpose: string;
  converted: string;
  note: string;
};

/** 保有代理店コードの入力を助けるための候補。 */
export type AgencyOption = { code: string; name: string };

/** 画面から直接選べる状態。貸出中・返却済は貸出／返却の操作でしか付かない。 */
const MANUAL_STATES = ["在庫", "設置済", "故障・修理", "廃棄"];
const ACQUIRED_KINDS = ["個人購入", "デモ機購入", "無料貸与"];
const CONVERTED_KINDS = ["該当なし", "転用済", "未転用"];

const initial: DemoFormState = {};

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";
const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-3 py-1.5 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";

/* ---------- 入力欄のまとまり ---------- */

/**
 * 登録と修正で共通の入力欄。
 * 貸出中の台は、状態を選ぶ欄を出さない（返却の記録でしか変えられないため）。
 */
function DetailFields({
  machine,
  agencies,
  listId,
  disabled,
}: {
  machine?: DemoView;
  agencies: AgencyOption[];
  listId: string;
  disabled?: boolean;
}) {
  const onLoan = machine?.state === "貸出中";
  const returned = machine?.state === "返却済";
  // 返却済の台は、そのままの状態も選べるようにしておく
  // （メモだけ直したいときに、気づかないうちに在庫へ戻さないため）
  const stateOptions = returned ? ["返却済", ...MANUAL_STATES] : MANUAL_STATES;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className={labelCls}>製品番号</span>
          <input
            type="text"
            name="serialNo"
            required
            maxLength={60}
            defaultValue={machine?.serialNo ?? ""}
            disabled={disabled}
            placeholder="例）VIS-2026-0001"
            className={`${inputCls} tabnum`}
          />
          <span className={hintCls}>
            1台ずつ見分けるための番号です。同じ番号は登録できません。
          </span>
        </label>

        <label className="block">
          <span className={labelCls}>機種</span>
          <input
            type="text"
            name="model"
            maxLength={60}
            defaultValue={machine?.model ?? "VIS本体"}
            disabled={disabled}
            className={inputCls}
          />
        </label>

        {onLoan ? (
          <div className="block">
            <span className={labelCls}>状態</span>
            <div className="mt-1.5 rounded-lg border border-ink-800 bg-ink-900/60 px-3.5 py-2.5 text-sm text-ink-200">
              貸出中
            </div>
            <span className={hintCls}>
              貸出中の台の状態は、この欄では変えられません。返ってきたら「返却を登録」から記録してください。
            </span>
          </div>
        ) : (
          <label className="block">
            <span className={labelCls}>状態</span>
            <select
              name="state"
              defaultValue={machine?.state && stateOptions.includes(machine.state) ? machine.state : "在庫"}
              disabled={disabled}
              className={inputCls}
            >
              {stateOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className={hintCls}>
              {returned
                ? "「在庫」に戻すと、ふたたび貸し出せるようになります。"
                : "貸出中・返却済は、一覧の「貸出を登録」「返却を登録」から付きます。"}
            </span>
          </label>
        )}

        <label className="block">
          <span className={labelCls}>取得のしかた</span>
          <select
            name="acquiredKind"
            defaultValue={machine?.acquiredKind ?? ""}
            disabled={disabled}
            className={inputCls}
          >
            <option value="">未設定</option>
            {ACQUIRED_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className={labelCls}>取得日</span>
          <input
            type="date"
            name="acquiredOn"
            defaultValue={machine?.acquiredOn ?? ""}
            disabled={disabled}
            className={`${inputCls} tabnum`}
          />
        </label>

        <label className="block">
          <span className={labelCls}>保有代理店コード</span>
          <input
            type="text"
            name="holderCode"
            maxLength={20}
            list={listId}
            defaultValue={machine?.holderCode ?? ""}
            disabled={disabled}
            placeholder="例）ABCD0001"
            className={`${inputCls} tabnum`}
          />
          <datalist id={listId}>
            {agencies.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
          </datalist>
          <span className={hintCls}>この台を預かっている代理店のコードです。</span>
        </label>

        <label className="block">
          <span className={labelCls}>保有者（責任者）</span>
          <input
            type="text"
            name="holderName"
            maxLength={100}
            defaultValue={machine?.holderName ?? ""}
            disabled={disabled}
            placeholder="例）山田 太郎"
            className={inputCls}
          />
          <span className={hintCls}>
            この台を預かって管理している方のお名前です。デモ機登録フォームの「使用者名」にあたります。
            会社でお預かりの場合は会社名でも構いません。
          </span>
        </label>

        <label className="block">
          <span className={labelCls}>自社会社名</span>
          <input
            type="text"
            name="ownerCompany"
            maxLength={100}
            defaultValue={machine?.ownerCompany ?? ""}
            disabled={disabled}
            placeholder="例）個人代理店キャプテン"
            className={inputCls}
          />
          <span className={hintCls}>
            デモ機登録フォームの「自社会社名」です。自分のコードを持たない
            エリア統括代理店・個人販売代理店は、ここに名乗った名前しか残りません。
          </span>
        </label>

        <label className="block">
          <span className={labelCls}>設置先のお客様名</span>
          <input
            type="text"
            name="customerName"
            maxLength={100}
            defaultValue={machine?.customerName ?? ""}
            disabled={disabled}
            className={inputCls}
          />
          <span className={hintCls}>サロンなどに置かせていただいている場合に入れてください。</span>
        </label>

        <label className="block">
          <span className={labelCls}>用途</span>
          <input
            type="text"
            name="purpose"
            maxLength={200}
            defaultValue={machine?.purpose ?? ""}
            disabled={disabled}
            placeholder="例）体験会での試用"
            className={inputCls}
          />
        </label>

        <label className="block">
          <span className={labelCls}>販売への転用</span>
          <select
            name="converted"
            defaultValue={machine?.converted || "該当なし"}
            disabled={disabled}
            className={inputCls}
          >
            {CONVERTED_KINDS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span className={hintCls}>デモ機をそのままご購入いただいた場合は「転用済」にします。</span>
        </label>
      </div>

      <label className="block">
        <span className={labelCls}>メモ</span>
        <textarea
          name="note"
          rows={3}
          maxLength={2000}
          defaultValue={machine?.note ?? ""}
          disabled={disabled}
          placeholder="傷や付属品の有無など、引き継ぎたいことを書いてください。"
          className={`${inputCls} resize-y leading-relaxed`}
        />
      </label>
    </div>
  );
}

/* ---------- 新しいデモ機を登録する ---------- */

export function DemoForm({ agencies }: { agencies: AgencyOption[] }) {
  const [state, run, pending] = useActionState(createDemoAction, initial);
  const listId = useId();

  return (
    <div className="space-y-4 px-5 py-5">
      {/* 登録に成功したら key が変わり、入力欄が空に戻る */}
      <form key={state.savedAt ?? 0} action={run} className="space-y-4">
        <DetailFields agencies={agencies} listId={listId} disabled={pending} />
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "登録中…" : "このデモ機を登録する"}
        </button>
      </form>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </div>
  );
}

/* ---------- 一覧の1行 ---------- */

type Panel = "none" | "edit" | "lend" | "return";

/**
 * 表の1行と、「内容を修正」「貸出を登録」「返却を登録」で開く入力欄。
 * どれか1つだけが開くようにして、どの手続きをしているかを見失わないようにしている。
 */
export function DemoRow({
  machine,
  agencies,
  today,
  overdueDays,
  columnCount,
}: {
  machine: DemoView;
  agencies: AgencyOption[];
  /** 日本時間の今日。貸出日・返却日の初期値に使う。 */
  today: string;
  /**
   * 返却予定日を何日過ぎているか。過ぎていなければ 0。
   * 日数の計算は一覧側（page.tsx）でまとめて行っている。
   */
  overdueDays: number;
  /** 入力欄を表いっぱいに広げるための列数。 */
  columnCount: number;
}) {
  const [editState, save, saving] = useActionState(updateDemoAction, initial);
  const [lendState, lend, lending] = useActionState(lendDemoAction, initial);
  const [returnState, giveBack, returning] = useActionState(returnDemoAction, initial);
  const [panel, setPanel] = useState<Panel>("none");
  const listId = useId();

  const busy = saving || lending || returning;
  const overdue = overdueDays > 0;
  const onLoan = machine.state === "貸出中";
  const canLend = machine.state !== "貸出中" && machine.state !== "廃棄";
  const canReturn = onLoan || (Boolean(machine.lendOn) && !machine.returnedOn);

  // 開いている手続きの結果だけを出す（別の手続きの控えが混ざらないようにする）
  const shown =
    panel === "edit" ? editState : panel === "lend" ? lendState : panel === "return" ? returnState : initial;

  const toggle = (next: Panel) => setPanel((v) => (v === next ? "none" : next));

  return (
    <Fragment>
      <tr>
        <Td>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="tabnum font-medium text-ink-50">{machine.serialNo || "—"}</span>
            {machine.converted === "転用済" ? <Badge tone="gold">転用済</Badge> : null}
          </div>
          {machine.acquiredOn ? (
            <div className="tabnum mt-1 text-xs text-ink-400">
              {fullDate(machine.acquiredOn)} 取得
            </div>
          ) : null}
        </Td>
        <Td>{machine.model || "—"}</Td>
        {/* 取得区分（個人購入／デモ機購入／無料貸与）。
            買っていただいた台か、本部からお預けしている台かで、返却のお願いのしかたが変わる。 */}
        <Td>
          {machine.acquiredKind ? (
            <span className="whitespace-nowrap text-ink-200">{machine.acquiredKind}</span>
          ) : (
            <span className="text-ink-500">未設定</span>
          )}
        </Td>
        <Td>
          <Badge tone={stateTone(machine.state)}>{machine.state || "未設定"}</Badge>
        </Td>
        {/* どの代理店の持ち物かを、責任者名とは別の列で出す。
            責任者名だけでは、同じ苗字の方がいるとどちらの代理店か分からないため。 */}
        <Td>
          {machine.holderCode ? (
            <span className="tabnum whitespace-nowrap text-ink-200">{machine.holderCode}</span>
          ) : (
            <span className="text-ink-500">未設定</span>
          )}
        </Td>
        <Td>
          <div className="min-w-0 truncate text-ink-200">{machine.ownerCompany || "—"}</div>
        </Td>
        <Td>
          <div className="min-w-0 truncate text-ink-200">{machine.holderName || "—"}</div>
        </Td>
        <Td>
          <div className="min-w-0">
            <div className="truncate text-ink-200">{machine.lendTo || "—"}</div>
            {machine.lendOn ? (
              <div className="tabnum truncate text-xs text-ink-400">
                {fullDate(machine.lendOn)} から
              </div>
            ) : null}
            {machine.customerName ? (
              <div className="truncate text-xs text-ink-400">設置先：{machine.customerName}</div>
            ) : null}
          </div>
        </Td>
        <Td numeric className={overdue ? "whitespace-nowrap text-warn-100" : "whitespace-nowrap"}>
          {machine.returnedOn ? (
            <span className="text-ink-300">{fullDate(machine.returnedOn)} に返却</span>
          ) : (
            <>
              {fullDate(machine.returnDueOn)}
              {overdue ? (
                <div className="mt-1 text-xs font-medium text-warn-500">
                  返却予定日を {overdueDays.toLocaleString("ja-JP")} 日超過
                </div>
              ) : null}
            </>
          )}
        </Td>
        <Td align="right">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => toggle("edit")}
              disabled={busy}
              className={quietBtn}
            >
              {panel === "edit" ? "閉じる" : "内容を修正"}
            </button>
            {canLend ? (
              <button
                type="button"
                onClick={() => toggle("lend")}
                disabled={busy}
                className={quietBtn}
              >
                {panel === "lend" ? "閉じる" : "貸出を登録"}
              </button>
            ) : null}
            {canReturn ? (
              <button
                type="button"
                onClick={() => toggle("return")}
                disabled={busy}
                className={quietBtn}
              >
                {panel === "return" ? "閉じる" : "返却を登録"}
              </button>
            ) : null}
          </div>
        </Td>
      </tr>

      {panel !== "none" ? (
        <tr>
          <td colSpan={columnCount} className="border-b border-ink-850 bg-ink-950/40 px-4 py-5">
            {panel === "edit" ? (
              <form action={save} className="space-y-4">
                <input type="hidden" name="id" value={machine.id} />
                <DetailFields
                  machine={machine}
                  agencies={agencies}
                  listId={listId}
                  disabled={busy}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={busy} className={primaryBtn}>
                    {saving ? "保存中…" : "この内容で保存する"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanel("none")}
                    disabled={busy}
                    className={quietBtn}
                  >
                    やめる
                  </button>
                </div>
              </form>
            ) : null}

            {panel === "lend" ? (
              <form action={lend} className="space-y-4">
                <input type="hidden" name="id" value={machine.id} />
                <p className="text-sm text-ink-300">
                  製品番号 {machine.serialNo || "（未設定）"} を貸し出します。
                  記録すると状態が「貸出中」になります。
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className={labelCls}>貸出先</span>
                    <input
                      type="text"
                      name="lendTo"
                      required
                      maxLength={100}
                      defaultValue={machine.lendTo}
                      disabled={busy}
                      placeholder="例）○○サロン 田中様"
                      className={inputCls}
                    />
                    <span className={hintCls}>お渡しした先のお名前や店舗名を入れてください。</span>
                  </label>
                  <label className="block">
                    <span className={labelCls}>設置先のお客様名</span>
                    <input
                      type="text"
                      name="customerName"
                      maxLength={100}
                      defaultValue={machine.customerName}
                      disabled={busy}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>貸出日</span>
                    <input
                      type="date"
                      name="lendOn"
                      defaultValue={machine.lendOn || today}
                      disabled={busy}
                      className={`${inputCls} tabnum`}
                    />
                  </label>
                  <label className="block">
                    <span className={labelCls}>返却予定日</span>
                    <input
                      type="date"
                      name="returnDueOn"
                      required
                      defaultValue={machine.returnDueOn}
                      disabled={busy}
                      className={`${inputCls} tabnum`}
                    />
                    <span className={hintCls}>
                      この日を過ぎると、一覧で色を変えてお知らせします。
                    </span>
                  </label>
                </div>
                <label className="block">
                  <span className={labelCls}>用途</span>
                  <input
                    type="text"
                    name="purpose"
                    maxLength={200}
                    defaultValue={machine.purpose}
                    disabled={busy}
                    placeholder="例）体験会での試用"
                    className={inputCls}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={busy} className={primaryBtn}>
                    {lending ? "記録中…" : "貸出を記録する"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanel("none")}
                    disabled={busy}
                    className={quietBtn}
                  >
                    やめる
                  </button>
                </div>
              </form>
            ) : null}

            {panel === "return" ? (
              <form action={giveBack} className="space-y-4">
                <input type="hidden" name="id" value={machine.id} />
                <p className="text-sm text-ink-300">
                  製品番号 {machine.serialNo || "（未設定）"}
                  {machine.lendTo ? `（貸出先：${machine.lendTo}）` : ""}
                  の返却を記録します。状態は「返却済」になります。
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className={labelCls}>返却日</span>
                    <input
                      type="date"
                      name="returnedOn"
                      defaultValue={machine.returnedOn || today}
                      disabled={busy}
                      className={`${inputCls} tabnum`}
                    />
                    <span className={hintCls}>空欄のままにすると、今日の日付で記録します。</span>
                  </label>
                </div>
                <label className="block">
                  <span className={labelCls}>メモ</span>
                  <textarea
                    name="note"
                    rows={2}
                    maxLength={2000}
                    defaultValue={machine.note}
                    disabled={busy}
                    placeholder="返却時の状態（傷・付属品の欠品など）があれば書いてください。"
                    className={`${inputCls} resize-y leading-relaxed`}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={busy} className={primaryBtn}>
                    {returning ? "記録中…" : "返却を記録する"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanel("none")}
                    disabled={busy}
                    className={quietBtn}
                  >
                    やめる
                  </button>
                </div>
              </form>
            ) : null}

            {shown.error ? (
              <div className="mt-3">
                <Notice tone="bad">{shown.error}</Notice>
              </div>
            ) : null}
            {!shown.error && shown.ok ? (
              <div className="mt-3">
                <Notice tone="info">{shown.ok}</Notice>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/* ---------- 表示の細かいところ ---------- */

function stateTone(state: string): "neutral" | "good" | "warn" | "bad" | "gold" {
  if (state === "設置済") return "good";
  if (state === "貸出中") return "gold";
  if (state === "故障・修理") return "warn";
  if (state === "廃棄") return "bad";
  return "neutral";
}

/** 年をまたぐ台帳なので、日付は年まで出す。 */
function fullDate(v: string): string {
  if (!v) return "—";
  const parts = v.slice(0, 10).split("-");
  if (parts.length !== 3) return v;
  return `${parts[0]}/${Number(parts[1])}/${Number(parts[2])}`;
}
