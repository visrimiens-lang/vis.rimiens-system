"use client";

import { useActionState, useRef } from "react";
import { Download, Truck } from "lucide-react";
import { issueYamatoAction, type YamatoState } from "@/actions/yamato-actions";
import { Badge, Notice, Table, Td, Th } from "@/components/ui";

const initial: YamatoState = {};

export type ShippingRow = {
  id: string;
  orderedOn: string;
  customerName: string;
  phone: string;
  zip: string;
  address: string;
  productName: string;
  quantity: number;
  shipStatus: string;
  reviewResult: string;
  /** 宛先に不足があるときの説明。空なら発行できる */
  problem: string;
};

/**
 * 送り状の発行フォーム。
 *
 * 対象の受注にチェックを付けて発行する。既定は「発行できるものすべて」。
 * 発行には B2クラウドとのやり取り（データチェック → 発行 → 印刷待ち →
 * 伝票番号の受け取り）が入るので、押してから十数秒かかることがある。
 */
export function IssueForm({
  rows,
  canIssue,
}: {
  rows: ShippingRow[];
  /** APIの認証キーが揃っているか。揃うまではCSVでの発行になる */
  canIssue: boolean;
}) {
  const [state, run, pending] = useActionState(issueYamatoAction, initial);
  const ready = rows.filter((r) => !r.problem);
  const formRef = useRef<HTMLFormElement>(null);

  /* チェックの付いた受注だけをCSVに出す。 */
  function downloadCsv() {
    const form = formRef.current;
    if (!form) return;
    const ids = Array.from(
      form.querySelectorAll<HTMLInputElement>('input[name="order"]:checked'),
    ).map((el) => el.value);
    if (ids.length === 0) {
      window.alert("CSVに出す受注を選んでください。");
      return;
    }
    window.location.href = `/api/yamato/csv?ids=${ids.join(",")}`;
  }

  return (
    <form action={run} ref={formRef}>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-ink-300">
          送り状が必要な受注はありません（出荷待ち・送り状番号なしの受注が対象です）。
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th> </Th>
              <Th>受注日</Th>
              <Th>お客様</Th>
              <Th>お届け先</Th>
              <Th>商品</Th>
              <Th align="right">台数</Th>
              <Th>状態</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.problem ? "opacity-60" : ""}>
                <Td>
                  <input
                    type="checkbox"
                    name="order"
                    value={r.id}
                    defaultChecked={!r.problem}
                    disabled={Boolean(r.problem) || pending}
                    aria-label={`受注 ${r.id} を発行の対象にする`}
                    className="h-4 w-4 accent-[var(--color-brand)]"
                  />
                </Td>
                <Td numeric className="whitespace-nowrap">
                  {r.orderedOn}
                </Td>
                <Td>
                  <div className="text-ink-100">{r.customerName || "（名前なし）"}</div>
                  <div className="tabnum mt-0.5 text-xs text-ink-400">{r.phone || "電話番号なし"}</div>
                </Td>
                <Td>
                  <div className="text-xs leading-relaxed text-ink-300">
                    {r.zip ? `〒${r.zip}　` : ""}
                    {r.address || "住所なし"}
                  </div>
                  {r.problem ? (
                    <div className="mt-1 text-xs text-warn-100">{r.problem}</div>
                  ) : null}
                </Td>
                <Td className="max-w-[16rem]">
                  <div className="truncate text-xs text-ink-300">{r.productName}</div>
                  {r.quantity > 1 ? (
                    <div className="mt-1 text-xs text-warn-100">
                      {r.quantity}台の受注です。送り状は1枚だけ発行されるので、2箱以上に
                      分ける場合は残りをB2クラウド画面からお出しください。
                    </div>
                  ) : null}
                </Td>
                <Td numeric align="right">
                  {r.quantity}
                </Td>
                <Td>
                  <Badge tone={r.reviewResult === "承認" ? "good" : "neutral"}>
                    {r.reviewResult || "審査結果なし"}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="space-y-3 border-t border-ink-800 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {canIssue ? (
            <button
              type="submit"
              disabled={pending || ready.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Truck className="h-4 w-4" />
              {pending ? "発行しています…（十数秒かかります）" : "選んだ受注の送り状を発行する"}
            </button>
          ) : null}
          {/*
            APIの認証キーが揃うまでの発行手段。キーが揃ってからも、
            B2クラウドの画面で出したい場面（1件だけ出し直す等）に使える。
          */}
          <button
            type="button"
            onClick={downloadCsv}
            disabled={pending || ready.length === 0}
            className={
              (canIssue
                ? "border border-ink-700 bg-ink-900 text-ink-100 hover:bg-ink-850"
                : "bg-brand text-on-gold hover:bg-brand-strong") +
              " inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <Download className="h-4 w-4" />
            B2クラウド取込用のCSVを出す
          </button>
          <span className="text-xs text-ink-400">
            {canIssue
              ? "発行すると伝票番号が採番され、受注とお客様の台帳に自動で入ります。"
              : "CSVをB2クラウドの「送り状発行データ取込」で読ませて発行し、伝票番号を下の欄に貼ってください。"}
          </span>
        </div>

        {state.error ? <Notice tone="bad">{state.error}</Notice> : null}
        {state.rowErrors && state.rowErrors.length > 0 ? (
          <div className="rounded-lg border border-bad-500/40 bg-bad-500/10 px-4 py-3 text-sm">
            <ul className="space-y-2">
              {state.rowErrors.map((r) => (
                <li key={r.orderId}>
                  <span className="font-medium text-bad-100">
                    受注{r.orderId}
                    {r.name ? `（${r.name}）` : ""}：
                  </span>
                  <span className="text-bad-100">{r.messages.join(" ／ ")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.ok ? (
          <Notice tone="info">
            {state.ok}
            {state.issueId ? (
              <>
                {" "}
                <a
                  href={`/api/yamato/label/${state.issueId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-4"
                >
                  送り状PDFを開く
                </a>
              </>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
