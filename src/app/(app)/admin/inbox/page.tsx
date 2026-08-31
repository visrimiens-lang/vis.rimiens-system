import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { selectAll } from "@/lib/db";
import { INBOX_KEEP_DAYS } from "@/lib/intake";
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
  cn,
} from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DismissButton } from "./DismissButton";
import { ReprocessButton } from "./ReprocessButton";

/**
 * 受信箱 ― JotForm と決済から届いたものの控え。
 *
 * 申込や決済は、届いた内容をまず丸ごとここに保存してから処理する
 * （src/lib/intake.ts の receive）。処理に失敗しても、届いた事実と中身は
 * ここに残る。この画面が無いと、取り込みに失敗した申込が誰の目にも触れず、
 * お客様からの問い合わせで初めて気づくことになる。
 *
 * 見るべきは「取り込めていない」の件数。ここが 0 なら、届いたものは
 * すべて代理店・受注・顧客のどれかになっている。
 */

export const dynamic = "force-dynamic";

/** 30秒ごとに新しくする。決済は時間帯によって続けて届く。 */
const REFRESH_SECONDS = 30;

/** 一度に読む上限。これを超えることは通常ない（保険）。 */
const HARD_LIMIT = 5000;

type Row = Record<string, unknown>;

function s_(r: Row, k: string): string {
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

/** 届いた元の呼び方。source の値をそのまま出すと利用者に伝わらない。 */
function sourceLabel(source: string): string {
  if (source === "jotform") return "JotForm（申込フォーム）";
  if (source === "utage") return "UTAGE・決済";
  return source || "不明";
}

/** 日時を「8/11 18:03」の形にする。 */
function stamp(v: string): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v.slice(0, 16);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const m = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${m}/${day} ${hh}:${mm}`;
}

/**
 * 届いた中身から、人が見て分かる名前を1つ拾う。
 * 項目名はフォームごとに違うので、よくある言い方を順に当たる。
 */
function guessName(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const flat = payload as Record<string, unknown>;
  const keys = [
    "customer_name", "注文者名", "会社名", "サロン名", "法人名",
    "お名前", "氏名", "name",
  ];
  for (const want of keys) {
    for (const [k, v] of Object.entries(flat)) {
      // JotForm は「q6_input3」のように頭に q番号_ が付く
      const key = k.replace(/^q\d+_/, "");
      if (key !== want && !key.includes(want)) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        const joined = [o.last, o.first].filter(Boolean).join(" ").trim();
        if (joined) return joined;
        continue;
      }
      const t = String(v).trim();
      if (t) return t;
    }
  }
  return "";
}

/** 届いた中身を、そのまま読める形の文字列にする。 */
function prettyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export default async function AdminInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const params = await searchParams;
  const rawShow = params.show;
  const show = Array.isArray(rawShow) ? rawShow[0] : rawShow;
  /** 既定は「取り込めていないものだけ」。ここが本部の見るべきところ。 */
  const onlyFailed = show !== "all";

  let rows: Row[] = [];
  let error: string | null = null;
  try {
    rows = await selectAll<Row>("inbox?select=*&order=id.desc", {
      hardLimit: HARD_LIMIT,
    });
  } catch (e) {
    error =
      e instanceof Error
        ? e.message
        : "時間をおいて、画面を開き直してください。";
  }

  const failed = rows.filter((r) => r["processed"] !== true);
  const shown = onlyFailed ? failed : rows;

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const todayCount = rows.filter((r) =>
    s_(r, "created_at").startsWith(today),
  ).length;

  const tabCls = (active: boolean) =>
    cn(
      "rounded-lg border px-3 py-1.5 text-sm transition",
      active
        ? "border-gold-500/50 bg-gold-500/12 text-gold-300"
        : "border-ink-700 text-ink-300 hover:bg-ink-850 hover:text-ink-100",
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="受信箱（届いた申込・決済）"
        description="JotForm の申込フォームと決済から届いた内容の控えです。取り込みに失敗したものはここに残るので、この画面で気づいて手当てします。"
        actions={<AutoRefresh seconds={REFRESH_SECONDS} label="受信箱" />}
      />

      {error ? (
        <Notice tone="bad">
          受信箱を読み込めませんでした。{error}
          <br />
          しばらく待っても直らない場合は、データベースの接続設定をご確認ください。
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="取り込めていない"
          value={failed.length.toLocaleString("ja-JP")}
          unit="件"
          tone={failed.length > 0 ? "warn" : "default"}
          hint={
            failed.length > 0
              ? "下の一覧をご確認ください"
              : "届いたものはすべて取り込めています"
          }
        />
        <StatTile
          label="今日届いた"
          value={todayCount.toLocaleString("ja-JP")}
          unit="件"
          hint="申込フォームと決済の合計"
        />
        <StatTile
          label="これまでに届いた"
          value={rows.length.toLocaleString("ja-JP")}
          unit="件"
          hint="受信箱に残っている全件"
        />
      </div>

      {failed.length > 0 ? (
        <Notice tone="warn">
          <p className="font-medium">
            取り込めていない申込・決済が {failed.length} 件あります。
          </p>
          <p className="mt-1.5">
            届いた内容は下に残っているので、消えてはいません。次のどちらかで手当てしてください。
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <span className="text-ink-100">送り直してもらう</span> …
              JotForm の管理画面から同じ送信を再送すると、もう一度取り込まれます。
            </li>
            <li>
              <span className="text-ink-100">手で登録する</span> …
              下の内容を見ながら、代理店管理または受注一覧から登録します。
            </li>
          </ul>
        </Notice>
      ) : null}

      <Card
        title={onlyFailed ? "取り込めていないもの" : "届いたものすべて"}
        action={
          <div className="flex flex-wrap gap-2">
            <a href="/admin/inbox" className={tabCls(onlyFailed)}>
              取り込めていないもの {failed.length}
            </a>
            <a href="/admin/inbox?show=all" className={tabCls(!onlyFailed)}>
              すべて {rows.length}
            </a>
          </div>
        }
      >
        {shown.length === 0 ? (
          <EmptyState
            title={
              onlyFailed
                ? "取り込めていないものはありません"
                : "まだ何も届いていません"
            }
            description={
              onlyFailed
                ? "届いた申込・決済はすべて、代理店・受注・顧客のいずれかとして登録されています。"
                : "JotForm の申込フォームか決済から通知が届くと、ここに残ります。運用を始める前は空です。"
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>届いた日時</Th>
                <Th>届いた元</Th>
                <Th>お名前など</Th>
                <Th>状態</Th>
                <Th>うまくいかなかった理由</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const ok = r["processed"] === true;
                const name = guessName(r["payload"]);
                return (
                  <tr key={s_(r, "id")} className="align-top">
                    <Td numeric>{stamp(s_(r, "created_at"))}</Td>
                    <Td>
                      <div>{sourceLabel(s_(r, "source"))}</div>
                      {s_(r, "form_id") ? (
                        <div className="tabnum mt-0.5 text-xs text-ink-500">
                          フォーム {s_(r, "form_id")}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <div>{name || <span className="text-ink-500">—</span>}</div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-ink-400 underline underline-offset-4 hover:text-ink-200">
                          届いた内容を見る
                        </summary>
                        <pre className="scroll-x mt-2 max-h-72 rounded-lg border border-ink-800 bg-ink-950 p-3 text-xs leading-relaxed text-ink-300">
                          {prettyPayload(r["payload"])}
                        </pre>
                      </details>
                    </Td>
                    <Td>
                      {ok ? (
                        <Badge tone="good">取り込み済み</Badge>
                      ) : (
                        <Badge tone="warn">取り込めていない</Badge>
                      )}
                      {/*
                        取り込めなかったものは、ここから取り込み直せる。
                        届いた内容は丸ごと残っているので、原因を直したあとに
                        送り主へ再送をお願いしなくても本部の操作だけで済む。
                        決済など送り元から届き直すものは対象外（アクション側で弾く）。
                      */}
                      {!ok && s_(r, "source") === "jotform" ? (
                        <ReprocessButton id={s_(r, "id")} />
                      ) : null}
                      {/*
                        決済から届いたものは送り元から届き直さないので取り込み直せない。
                        本部が中身を見て手当てを終えたら、ここで片付ける。
                      */}
                      {!ok ? (
                        <div className="mt-2">
                          <DismissButton id={s_(r, "id")} />
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      {s_(r, "error") ? (
                        <span className="break-words text-bad-100">
                          {s_(r, "error")}
                        </span>
                      ) : ok ? (
                        <span className="text-ink-500">—</span>
                      ) : (
                        <span className="text-ink-400">
                          処理の途中で止まっています。もう一度お送りいただくか、手で登録してください。
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

      <Card title="この画面について">
        <div className="space-y-2.5 px-5 py-4 text-sm leading-relaxed text-ink-300">
          <p>
            申込フォームと決済から届いた内容は、処理する前にまるごとここへ控えます。
            そのため、登録の途中で失敗しても、お客様が入力した内容が失われることはありません。
          </p>
          <p>
            <span className="text-ink-100">毎朝ここを開いて</span>、
            「取り込めていない」が 0 件であることをご確認ください。
            0 件なら、届いたものはすべて代理店・受注・顧客のいずれかになっています。
          </p>
          <p className="text-ink-400">
            同じ内容が二度届いても、一度取り込めているものは二重に登録しません。
            取り込みに失敗したものは、送り直していただくとやり直します。
          </p>
          {/*
            控えには氏名・電話・住所がそのまま入っているので、用が済んだものは残さない。
            消えるのはこの控えだけで、取り込み済みの受注・顧客・代理店はそのまま残る。
          */}
          <p className="text-ink-400">
            ここに残るのは {INBOX_KEEP_DAYS} 日ぶんです。
            それより古い控えは、次に申込・決済が届いたときにまとめて消えます。
            取り込めていないものも消えるので、
            <span className="text-ink-100">{INBOX_KEEP_DAYS} 日以内に片付けてください</span>。
          </p>
        </div>
      </Card>
    </div>
  );
}
