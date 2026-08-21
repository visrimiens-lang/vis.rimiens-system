import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { selectAll } from "@/lib/db";
import { statusTone } from "@/lib/labels";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { StopButton } from "./StopButton";

/**
 * 全スタッフコードの一覧。
 *
 * 本部が「どのコードが生きていて、誰のものか」を1枚で見て、
 * 問題のあった相手のQRをその場で止められるようにするための画面。
 *
 * これまで止める操作は代理店の詳細画面の中だけにあり、
 * まず相手を探し当てないと止められなかった。
 * 不適切な販売が分かったときに探している時間はないので、一覧から直接止められるようにする。
 *
 * 載せるのは QR を持ちうるコードだけ（会社＝区分00 と スタッフ＝区分02）。
 * 取次パートナー（区分01）には個別のQRを出さない決まりなので、止める対象にならない。
 */

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;
const s_ = (r: Row, k: string): string => {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
};

/**
 * 停止（凍結）を見分ける目印。
 * ★ actions/qr-actions.ts と admin/agencies/[code]/QrPanel.tsx にも同じ文字列がある。
 *   どれか1つだけ変えると停止中を見分けられなくなるので、必ず全部そろえること。
 */
const FREEZE_MARK = "【QR停止】";

function isFrozen(r: Row): boolean {
  return s_(r, "qr2_status") === "差戻し" && s_(r, "qr2_rejected_note").startsWith(FREEZE_MARK);
}
function freezeReasonOf(r: Row): string {
  return s_(r, "qr2_rejected_note").slice(FREEZE_MARK.length).trim();
}

const KIND_LABEL: Record<string, string> = {
  "00": "会社",
  "02": "スタッフ",
};

export default async function AdminStaffPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  let rows: Row[] = [];
  let error = "";
  try {
    rows = await selectAll<Row>(
      "agencies?select=code,name,rep_name,code_kind,rank,parent_code,parent_name," +
        "status,training_status,qr2_status,qr2_rejected_note,qr1_url,qr2_url,email,phone" +
        "&code_kind=in.(00,02)&order=code.asc",
    );
  } catch (e) {
    error = e instanceof Error ? e.message : "一覧を読み込めませんでした。";
  }

  /*
   * 「所属」と「上位」を分けて出すための対応表。
   *
   * これまで1つの列に「所属（上位）」とまとめていたため、
   *   スタッフ … 所属する会社
   *   会社     … その会社の上位代理店
   * という別のものが同じ欄に並び、どちらの意味か読み取れなかった。
   *
   *   スタッフ ITSU0001 … 所属＝株式会社樹（ITSU）／上位＝株式会社佐々木（SASA）
   *   会社     ITSU     … 所属＝—              ／上位＝株式会社佐々木（SASA）
   *
   * 所属会社の上位を出すために、全代理店の「上位コードと名前」を控えておく。
   */
  let ancestors = new Map<string, { code: string; name: string }>();
  try {
    const all = await selectAll<Row>("agencies?select=code,parent_code,parent_name");
    ancestors = new Map(
      all.map((a) => [
        s_(a, "code"),
        { code: s_(a, "parent_code"), name: s_(a, "parent_name") },
      ]),
    );
  } catch {
    // 引けなくても一覧は出す（上位の欄が空になるだけ）
  }

  const frozen = rows.filter(isFrozen);
  const issued = rows.filter((r) => s_(r, "qr1_url") || s_(r, "qr2_url"));
  const staff = rows.filter((r) => s_(r, "code_kind") === "02");

  return (
    <div className="space-y-6">
      <PageHeader
        title="スタッフコード一覧"
        description={
          "QRをお渡ししているコードの一覧です。問題があった相手は、この画面からその場で止められます。" +
          "止めても稼働状況は変わらないので、ポータルには入れて売上や報酬の確認は続けられます。"
        }
      />

      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="コード" value={`${rows.length}`} unit="件" />
        <StatTile label="うちスタッフ" value={`${staff.length}`} unit="名" />
        <StatTile label="いま止めている" value={`${frozen.length}`} unit="件" />
      </div>

      <Notice tone="info">
        止めると、当システムからのご案内（QR1・QR2）が消え、QR2の発行申請は「差戻し」に戻ります。
        <strong className="text-ink-100">
          すでにお渡し済み・印刷済みのQRは、この操作では読み取れなくなりません。
        </strong>
        読み取り先が当システムの外（公式LINE・決済フォーム）にあるためです。
        現物の回収と、お客様へのご連絡は別途お願いします。
      </Notice>

      <Card title="コードの一覧">
        <p className="mb-3 text-xs text-ink-400">
          発行済み {issued.length} 件 ／ 取次パートナー（区分01）は個別のQRを出さないため載せていません
        </p>
        {rows.length === 0 ? (
          <EmptyState
            title="表示できるコードがありません"
            description="代理店やスタッフが登録されると、ここに並びます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>コード</Th>
                <Th>お名前</Th>
                <Th>区分</Th>
                <Th>所属</Th>
                <Th>上位</Th>
                <Th>研修</Th>
                <Th>QR</Th>
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const code = s_(r, "code");
                const isStaff = s_(r, "code_kind") === "02";
                /*
                 * 上位の出し方。
                 *   スタッフ … 所属している会社の、さらに上の代理店
                 *   会社     … その会社の上位代理店（これまでどおり）
                 */
                const upper = isStaff
                  ? ancestors.get(s_(r, "parent_code")) ?? { code: "", name: "" }
                  : { code: s_(r, "parent_code"), name: s_(r, "parent_name") };
                const stopped = isFrozen(r);
                const hasQr = Boolean(s_(r, "qr1_url") || s_(r, "qr2_url"));
                return (
                  <tr key={code} className="align-top">
                    <Td>
                      <Link
                        href={`/admin/agencies/${encodeURIComponent(code)}`}
                        className="tabnum underline underline-offset-4 hover:text-ink-50"
                      >
                        {code}
                      </Link>
                    </Td>
                    <Td>
                      <div>{s_(r, "name") || "—"}</div>
                      {s_(r, "rep_name") ? (
                        <div className="mt-0.5 text-xs text-ink-500">{s_(r, "rep_name")}</div>
                      ) : null}
                    </Td>
                    <Td>{KIND_LABEL[s_(r, "code_kind")] ?? "—"}</Td>
                    {/*
                      所属 … スタッフが属している会社。会社そのものには所属が無いので「—」。
                      上位 … その上の代理店。会社なら自分の上位、スタッフなら所属会社の上位。
                    */}
                    <Td>
                      {isStaff ? (
                        <>
                          <div className="tabnum text-xs text-ink-400">
                            {s_(r, "parent_code") || "—"}
                          </div>
                          <div>{s_(r, "parent_name") || ""}</div>
                        </>
                      ) : (
                        <span className="text-ink-500">—</span>
                      )}
                    </Td>
                    <Td>
                      {upper.code ? (
                        <>
                          <div className="tabnum text-xs text-ink-400">{upper.code}</div>
                          <div>{upper.name || ""}</div>
                        </>
                      ) : (
                        <span className="text-ink-500">—</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={s_(r, "training_status") === "合格" ? "good" : "neutral"}>
                        {s_(r, "training_status") || "未受講"}
                      </Badge>
                    </Td>
                    <Td>
                      {stopped ? (
                        <>
                          <Badge tone="bad">停止中</Badge>
                          {freezeReasonOf(r) ? (
                            <div className="mt-1 break-words text-xs text-ink-400">
                              {freezeReasonOf(r)}
                            </div>
                          ) : null}
                        </>
                      ) : hasQr ? (
                        <Badge tone="good">発行済み</Badge>
                      ) : (
                        <Badge tone="neutral">未発行</Badge>
                      )}
                      <div className="mt-1">
                        <Badge tone={statusTone(s_(r, "status"))}>{s_(r, "status")}</Badge>
                      </div>
                    </Td>
                    <Td>
                      {hasQr || stopped ? (
                        <StopButton code={code} name={s_(r, "name")} frozen={stopped} />
                      ) : (
                        <span className="text-xs text-ink-500">
                          QRが未発行のため、止める対象がありません
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
