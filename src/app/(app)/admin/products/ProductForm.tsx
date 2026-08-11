"use client";

import { useActionState, useState } from "react";
import {
  createProductAction,
  toggleActiveAction,
  updateProductAction,
  type Product,
  type ProductFormState,
} from "@/actions/product-actions";
import { channelLabel, rankLabel } from "@/lib/labels";
import { Badge, Notice, Td, cn, yen } from "@/components/ui";

const initial: ProductFormState = {};

/** 一覧の列数。見出し（page.tsx）と数を合わせる。入力欄を1行ぶち抜きで開くときに使う。 */
export const PRODUCT_COLUMN_COUNT = 10;

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-500";

const primaryBtn =
  "rounded-lg bg-gold-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-3.5 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-500";
const stopBtn =
  "rounded-lg border border-warn-500/50 bg-warn-500/10 px-3.5 py-2 text-sm font-medium text-warn-100 transition hover:bg-warn-500/20 disabled:cursor-not-allowed disabled:opacity-50";

/* ---------- 入力欄 ---------- */

function MoneyField({
  name,
  label,
  hint,
  defaultValue,
  required,
  disabled,
  max,
  unit = "円",
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: number | null;
  required?: boolean;
  disabled?: boolean;
  max: number;
  unit?: string;
}) {
  return (
    <label className="block">
      <span className={labelCls}>
        {label}
        {unit ? `（${unit}）` : ""}
      </span>
      <input
        type="number"
        name={name}
        min={0}
        max={max}
        step={1}
        inputMode="numeric"
        required={required}
        disabled={disabled}
        defaultValue={defaultValue ?? ""}
        placeholder={required ? "例）185000" : "空欄＝未設定"}
        className={`${inputCls} tabnum`}
      />
      {hint ? <span className={hintCls}>{hint}</span> : null}
    </label>
  );
}

function Check({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 shrink-0 accent-gold-500 disabled:opacity-60"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink-100">{label}</span>
        <span className="block text-xs leading-relaxed text-ink-500">{hint}</span>
      </span>
    </label>
  );
}

/** 新規追加と修正で共通の入力欄。 */
function Fields({ product, disabled }: { product?: Product; disabled?: boolean }) {
  return (
    <div className="space-y-5">
      <label className="block">
        <span className={labelCls}>商品名</span>
        <input
          type="text"
          name="name"
          required
          maxLength={200}
          disabled={disabled}
          defaultValue={product?.name ?? ""}
          placeholder="例）眼筋トレーニングマシンVIS本体 185,000円 ／ 事務手数料 3,300円"
          className={inputCls}
        />
        <span className={hintCls}>
          受注に記録される商品名と、この名前をそのまま突き合わせて報酬額を出します。
          販売ページの表記と1文字も違わないようにしてください（全角・半角、スペースも含みます）。
        </span>
      </label>

      <MoneyField
        name="price"
        label="販売単価（税込）"
        defaultValue={product?.price}
        required
        disabled={disabled}
        max={9_999_999}
        hint="お客様のお支払額です。報酬額の計算には使いません。"
      />

      <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-950/60 px-4 py-3.5">
        <Check
          name="rewardTarget"
          label="報酬の対象にする"
          hint="外すと、この商品が売れても報酬は発生しません。事務手数料など、報酬を付けないものは外してください。"
          defaultChecked={product ? product.rewardTarget : true}
          disabled={disabled}
        />
        <Check
          name="bonus10"
          label="10台ボーナスの対象にする"
          hint="kintone の商品マスタから引き継いだ区分です。10台ボーナスの集計に含める商品だけチェックしてください。"
          defaultChecked={product?.bonus10 ?? false}
          disabled={disabled}
        />
      </div>

      <div>
        <div className="text-xs font-medium tracking-wide text-ink-400">
          ランク別の報酬額（1台あたり）
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
          空欄のままにすると「未設定」として保存し、一覧では「—」と出ます。
          報酬を出さないと決めている場合は 0 を入れてください（「未設定」と「0円」は区別しています）。
        </p>
        {/* 呼び方は src/lib/labels.ts に寄せる。保存先の列名（amount_niji など）は
            そのままなので、報酬の計算も過去の受注の金額も変わらない。 */}
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MoneyField
            name="amountSo"
            label={rankLabel("総販売代理店")}
            defaultValue={product?.amountSo}
            disabled={disabled}
            max={9_999_999}
          />
          <MoneyField
            name="amountNiji"
            label={rankLabel("2次代理店")}
            defaultValue={product?.amountNiji}
            disabled={disabled}
            max={9_999_999}
          />
          <MoneyField
            name="amountHanbai"
            label={channelLabel("販売代理店")}
            defaultValue={product?.amountHanbai}
            disabled={disabled}
            max={9_999_999}
          />
          <MoneyField
            name="amountToritsugi"
            label={rankLabel("取次店")}
            defaultValue={product?.amountToritsugi}
            disabled={disabled}
            max={9_999_999}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyField
          name="points"
          label="ポイント"
          unit="ポイント"
          defaultValue={product?.points}
          disabled={disabled}
          max={100_000}
          hint="お客様に付くポイント数です。無ければ空欄で構いません。"
        />
        <MoneyField
          name="sortOrder"
          label="並び順"
          unit=""
          defaultValue={product?.sortOrder}
          disabled={disabled}
          max={9_999}
          hint="小さい数字ほど一覧の上に出ます。同じ数字なら登録の古い順です。"
        />
      </div>
    </div>
  );
}

/* ---------- 新しい商品を追加する ---------- */

export function ProductForm() {
  const [state, run, pending] = useActionState(createProductAction, initial);

  return (
    <div className="space-y-4 px-5 py-5">
      {/* 追加に成功したら key が変わり、入力欄が空に戻る */}
      <form key={state.savedAt ?? 0} action={run} className="space-y-5">
        <Fields disabled={pending} />
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "追加しています…" : "この商品を追加する"}
        </button>
      </form>

      {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
      {state.ok ? <Notice tone="info">{state.ok}</Notice> : null}
    </div>
  );
}

/* ---------- 一覧の1行 ---------- */

function moneyCells(p: Product) {
  return [p.amountSo, p.amountNiji, p.amountHanbai, p.amountToritsugi];
}

/** 報酬の対象なのに、4つのランクすべてが未設定か0円になっている。 */
function rewardMissing(p: Product): boolean {
  return p.rewardTarget && moneyCells(p).every((v) => v === null || v === 0);
}

/** 報酬額が販売単価を超えている。桁の打ち間違いのことが多い。 */
function rewardOverPrice(p: Product): boolean {
  const price = p.price;
  if (!p.rewardTarget || price === null) return false;
  return moneyCells(p).some((v) => v !== null && v > price);
}

/** 販売単価が未入力。「0円」は無料と決めた商品なので、空欄だけを拾う。 */
function priceMissing(p: Product): boolean {
  return p.price === null;
}

/**
 * 商品1件ぶんの行。「内容を直す」を押すと、同じ入力欄が下に開く。
 * 削除は用意しない。過去の受注が商品名でこの行を参照しているため、
 * 使わない商品は取扱を止めて一覧の下にまとめる。
 */
export function ProductRow({ product }: { product: Product }) {
  const [editState, save, saving] = useActionState(updateProductAction, initial);
  const [toggleState, toggle, toggling] = useActionState(toggleActiveAction, initial);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const busy = saving || toggling;
  const message = editState.error || editState.ok || toggleState.error || toggleState.ok;
  const amounts = moneyCells(product);
  const noPrice = priceMissing(product);
  const noReward = rewardMissing(product);
  // 取扱中なのに金額が空欄。売る前に手当てが要るので、行ごと色を変えて目立たせる。
  // 取扱を止めた商品は売らないので、色は付けない（直す必要のない行が光ると見落としが増える）。
  const needsInput = product.active && (noPrice || noReward);
  // 取扱を止められたら（＝取扱中でなくなったら）確認の問いかけは役目を終える。
  // 保存に失敗したときは取扱中のままなので、問いかけを残して理由を読んでもらう。
  const confirmOpen = confirming && product.active;

  return (
    <>
      {/* 取扱を止めた商品は背景を落として見分けられるようにし、
          金額が空欄のままの商品は左端に色を付けて、直す行がひと目で分かるようにする。 */}
      <tr
        className={cn(
          !product.active && "bg-ink-950/50",
          needsInput && "bg-warn-500/[0.07] [&>td:first-child]:border-l-2 [&>td:first-child]:border-l-warn-500",
        )}
      >
        <Td>
          {/* 「眼筋トレーニングマシンVIS本体　185,000円 ／ …」のような長い商品名が入る。
              幅を決めて折り返し、はみ出しても表ごと横スクロールで読めるようにする。 */}
          <div
            className={cn(
              "w-[22rem] break-words font-medium leading-relaxed",
              product.active ? "text-ink-100" : "text-ink-400",
            )}
          >
            {product.name || "（商品名未設定）"}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {product.active ? null : <Badge tone="neutral">取扱停止</Badge>}
            {product.bonus10 ? <Badge tone="gold">10台ボーナス</Badge> : null}
            {noPrice ? <Badge tone="warn">販売単価が未入力</Badge> : null}
            {noReward ? <Badge tone="warn">報酬額が未入力</Badge> : null}
            {rewardOverPrice(product) ? (
              <Badge tone="warn">報酬額が販売単価より高い</Badge>
            ) : null}
          </div>
        </Td>
        <Td numeric align="right" className="whitespace-nowrap">
          {noPrice ? (
            <span className="font-medium text-warn-100">未入力</span>
          ) : (
            yen(product.price)
          )}
        </Td>
        <Td align="center">
          {product.rewardTarget ? (
            <Badge tone="good">対象</Badge>
          ) : (
            <Badge tone="neutral">対象外</Badge>
          )}
        </Td>
        {amounts.map((v, i) => (
          <Td key={i} numeric align="right" className="whitespace-nowrap">
            {product.rewardTarget ? (
              yen(v)
            ) : (
              <span className="text-ink-500">—</span>
            )}
          </Td>
        ))}
        <Td numeric align="right">
          {product.points ? product.points.toLocaleString("ja-JP") : "—"}
        </Td>
        <Td numeric align="right">
          {product.sortOrder}
        </Td>
        <Td align="right">
          <div className="flex justify-end gap-2 whitespace-nowrap">
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                setConfirming(false);
              }}
              disabled={busy}
              className={quietBtn}
            >
              {editing ? "閉じる" : "内容を直す"}
            </button>
            {product.active ? (
              <button
                type="button"
                onClick={() => {
                  setConfirming(true);
                  setEditing(false);
                }}
                disabled={busy}
                className={quietBtn}
              >
                取扱を止める
              </button>
            ) : (
              <form action={toggle}>
                <input type="hidden" name="id" value={product.id} />
                <input type="hidden" name="next" value="resume" />
                <button
                  type="submit"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className={quietBtn}
                >
                  {toggling ? "戻しています…" : "取扱を再開する"}
                </button>
              </form>
            )}
          </div>
        </Td>
      </tr>

      {confirmOpen || editing || message ? (
        <tr>
          <td
            colSpan={PRODUCT_COLUMN_COUNT}
            className="border-b border-ink-850 bg-ink-950/50 px-4 py-4"
          >
            {confirmOpen ? (
              <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3.5">
                <p className="text-sm leading-relaxed text-warn-100">
                  「{product.name}」の取扱を止めますか？
                  一覧の「取扱を止めた商品」に移るだけで、削除はしません。
                  過去の受注と、計上ずみの報酬はそのまま残ります。いつでも取扱を再開できます。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <form action={toggle}>
                    <input type="hidden" name="id" value={product.id} />
                    <input type="hidden" name="next" value="stop" />
                    <button type="submit" disabled={busy} className={stopBtn}>
                      {toggling ? "止めています…" : "はい、取扱を止める"}
                    </button>
                  </form>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className={quietBtn}
                  >
                    やめる
                  </button>
                </div>
              </div>
            ) : null}

            {editing ? (
              <form action={save} className="space-y-5">
                <input type="hidden" name="id" value={product.id} />
                <Fields product={product} disabled={busy} />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={busy} className={primaryBtn}>
                    {saving ? "保存しています…" : "変更を保存する"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                    className={quietBtn}
                  >
                    閉じる
                  </button>
                </div>
              </form>
            ) : null}

            {message ? (
              <div className={confirmOpen || editing ? "mt-3" : undefined}>
                <Notice tone={editState.error || toggleState.error ? "bad" : "info"}>
                  {message}
                </Notice>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
