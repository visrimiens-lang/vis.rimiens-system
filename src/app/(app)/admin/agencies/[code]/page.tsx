import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { select, selectOne, val } from "@/lib/db";
import { listAllAgencies, slotLimitsOf } from "@/lib/agencies";
import { agencyTypeOf, codeTermOf, isOrgStyleCode } from "@/lib/labels";
import { areaUsage, breakdownSlots, slotModelOf } from "@/lib/slots";
import type { Agency } from "@/lib/types";
import type { QrSource } from "@/lib/qr";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  cn,
  jpDate,
} from "@/components/ui";
import {
  EditForm,
  NewChildForm,
  StatusPanel,
  type AgencyDetail,
  type ParentOption,
} from "./EditForm";
import { OrgCodeForm } from "./OrgCodeForm";
import { QrPanel } from "./QrPanel";

/**
 * 本部が代理店1件の中身を見て、直す画面。
 *
 * kintone のレコード詳細にあたる。承認（稼働中への切り替え）もここで行うため、
 * 「いま何が起きているか」が上から順に読めるように並べている。
 */

type Row = Record<string, unknown>;

function s(r: Row | null, k: string): string {
  if (!r) return "";
  const v = r[k];
  return v === null || v === undefined ? "" : String(v);
}

function n(r: Row | null, k: string): number {
  if (!r) return 0;
  const v = r[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** 日本時間の「8/11 14:32」。操作の記録に使う。 */
function jpMoment(v: string): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** 操作の記録に添えられた中身を、1行の日本語にする。 */
function detailText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v || "—";
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== "")
      .map(([k, x]) => `${k}：${typeof x === "object" ? JSON.stringify(x) : String(x)}`);
    return parts.length > 0 ? parts.join(" / ") : "—";
  }
  return String(v);
}

function kindLabel(kind: string): string {
  if (kind === "00") return "会社";
  if (kind === "01") return "取次パートナー";
  if (kind === "02") return "スタッフ";
  return "区分未設定";
}

/* ---------- 項目をならべる ---------- */

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-ink-100">{children}</dd>
    </div>
  );
}

function orDash(v: string): ReactNode {
  return v ? v : <span className="text-ink-400">—</span>;
}

function InfoGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-5 px-5 py-5 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </dl>
  );
}

/* ---------- 枠の使用状況（数え方は共通の枠ルールに合わせる） ---------- */

type SlotRow = {
  key: string;
  label: string;
  note: string;
  /** いま使っている数 */
  used: number;
  /** null は「上限なし」。上限0は申込の受付でも止めないため、数として出さない。 */
  limit: number | null;
  remaining: number | null;
  isFull: boolean;
  members: Agency[];
};

type SlotView = {
  rows: SlotRow[];
  used: number;
  /** 合計の上限。ひとつでも「上限なし」があれば null */
  limit: number | null;
  /** 販路種別が入っておらず、どの枠にも数えられていない配下 */
  unclassified: Agency[];
};

/** 販路種別ごとに、この代理店に入っている上限を引く。0 は「上限なし」。 */
function storedLimitOf(agency: AgencyDetail, kind: string): number {
  if (kind === "サロン代理店") return agency.limitSalon;
  if (kind === "個人販売パートナー") return agency.limitKojin;
  if (kind === "サロン提携パートナー（取次）") return agency.limitToritsugi;
  return agency.limitHanbai;
}

/**
 * 配下の枠の使用状況をまとめる。
 *
 * 数えるのは共通の枠ルール（lib/slots.ts）にそのまま任せる。
 * ・総販売代理店の配下＝統括代理店なので「エリア枠（全国60社）」
 * ・統括代理店（2次代理店）の配下＝販路種別ごとの枠（販売10／サロン30／個人30／取次30）
 * ・枠を消費しないのはスタッフ（コード区分02）だけ。取次パートナーも取次枠を使う。
 */
function buildSlotView(
  me: Agency,
  agency: AgencyDetail,
  children: Agency[],
  everyone: Agency[],
): SlotView | null {
  const model = slotModelOf(me);
  if (model === "none") return null;

  if (model === "area") {
    const usage = areaUsage(everyone);
    return {
      rows: usage.rows.map((r) => ({
        key: r.area,
        label: r.area,
        note: "エリアごとの統括代理店の上限",
        used: r.used,
        limit: r.limit,
        remaining: r.remaining,
        isFull: r.isFull,
        members: r.members,
      })),
      used: usage.total.used,
      limit: usage.total.limit,
      unclassified: [],
    };
  }

  const breakdown = breakdownSlots(me, children, slotLimitsOf(me));
  const rows: SlotRow[] = breakdown.lines.map((line) => {
    const stored = storedLimitOf(agency, line.key);
    // 上限0は「上限なし」、特別枠も上限を数えない。どちらも申込の受付で止めていない。
    const noLimit = agency.specialSlot || stored <= 0;
    return {
      key: line.key,
      label: line.label,
      note: line.note,
      used: line.used,
      limit: noLimit ? null : stored,
      remaining: noLimit ? null : Math.max(0, stored - line.used),
      isFull: !noLimit && line.used >= stored,
      members: line.members,
    };
  });

  return {
    rows,
    used: breakdown.totalUsed,
    limit: rows.some((r) => r.limit === null)
      ? null
      : rows.reduce((sum, r) => sum + (r.limit ?? 0), 0),
    unclassified: breakdown.unclassified,
  };
}

/** 上限の見せ方。0 は「上限なし」（この枠では申込を止めない）。 */
function limitText(v: number): string {
  return v > 0 ? String(v) : "上限なし";
}

/* ---------- 画面 ---------- */

export default async function AgencyDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  if (viewer.kind !== "hq") redirect("/dashboard");

  const { code: rawCode } = await params;
  const code = (rawCode ?? "").trim();

  let row: Row | null = null;
  let logs: Row[] = [];
  // 枠の数え方を代理店側の画面とそろえるため、代理店マスタは共通の読み取りを使う
  let everyone: Agency[] = [];
  let loadError: string | null = null;

  try {
    row = await selectOne<Row>(
      `agencies?select=*&code=eq.${encodeURIComponent(code)}`,
    );
    if (row) {
      const quoted = encodeURIComponent(val(code));
      [logs, everyone] = await Promise.all([
        select<Row>(
          `audit_log?select=id,actor,action,target_type,target_key,detail,created_at&or=(target_key.eq.${quoted},actor.eq.${quoted})&order=created_at.desc&limit=20`,
        ),
        listAllAgencies(),
      ]);
    }
  } catch (e) {
    loadError =
      e instanceof Error
        ? e.message
        : "代理店マスタの読み込みに失敗しました。時間をおいて開き直してください。";
  }

  /*
   * 所属する会社の、さらに上の代理店。
   * スタッフ・取次パートナーは「所属」と「上位」が別なので、両方を出す。
   *   ITSU0001（スタッフ）… 所属＝株式会社樹（ITSU）／上位＝株式会社佐々木（SASA）
   */
  const parentOfParent = (() => {
    const pc = s(row, "parent_code");
    if (!pc) return null;
    const company = everyone.find((a) => a.code === pc);
    if (!company || !company.parentCode) return null;
    return { code: company.parentCode, name: company.parentName };
  })();

  const backLink = (
    <Link
      href="/admin/agencies"
      className="text-sm text-ink-200 underline underline-offset-4 hover:text-gold-300"
    >
      代理店の一覧に戻る
    </Link>
  );

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="代理店の詳細"
          description={`代理店コード ${code || "（未指定）"} の内容です。`}
          actions={backLink}
        />
        <Notice tone="bad">
          この代理店の情報を読み込めませんでした。{loadError}
          <br />
          しばらく待っても直らない場合は、接続設定（保管先のURLと認証情報）をご確認ください。
        </Notice>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="代理店の詳細"
          description={`代理店コード ${code || "（未指定）"} の内容です。`}
          actions={backLink}
        />
        <Notice tone="warn">
          代理店コード「{code}」の登録は見つかりませんでした。
          コードの打ち間違いか、すでに削除された可能性があります。一覧から選び直してください。
        </Notice>
      </div>
    );
  }

  /**
   * QRの発行欄に渡す項目。
   * 研修の合否（training_status）や発行申請の状況（qr2_status）は
   * 代理店マスタの行にしか入っていないため、下の AgencyDetail では代用できない。
   * ただし行をまるごと渡すとログイン用のパスワードや口座番号まで
   * ブラウザ側へ送られてしまうので、QRの発行に使う項目だけを取り出す。
   */
  const agencyRow: QrSource = {
    code: s(row, "code"),
    name: s(row, "name"),
    code_kind: s(row, "code_kind"),
    status: s(row, "status"),
    training_status: s(row, "training_status"),
    training_passed_on: s(row, "training_passed_on"),
    qr2_status: s(row, "qr2_status"),
    qr2_requested_on: s(row, "qr2_requested_on"),
    qr2_rejected_note: s(row, "qr2_rejected_note"),
    qr1_url: s(row, "qr1_url"),
    qr2_url: s(row, "qr2_url"),
  };

  const agency: AgencyDetail = {
    id: s(row, "id"),
    code: s(row, "code"),
    name: s(row, "name"),
    repName: s(row, "rep_name"),
    rank: s(row, "rank"),
    channel: s(row, "channel"),
    codeKind: s(row, "code_kind"),
    orgCode: s(row, "org_code"),
    parentCode: s(row, "parent_code"),
    parentName: s(row, "parent_name"),
    email: s(row, "email"),
    phone: s(row, "phone"),
    zip: s(row, "zip"),
    address: s(row, "address"),
    shopName: s(row, "shop_name"),
    branchName: s(row, "branch_name"),
    birthday: s(row, "birthday"),
    area: s(row, "area"),
    areaClass: s(row, "area_class"),
    status: s(row, "status"),
    suspendedReason: s(row, "suspended_reason"),
    trainingStatus: s(row, "training_status"),
    trainingPassedOn: s(row, "training_passed_on"),
    signStatus: s(row, "sign_status"),
    limitHanbai: n(row, "limit_hanbai"),
    limitSalon: n(row, "limit_salon"),
    limitKojin: n(row, "limit_kojin"),
    limitToritsugi: n(row, "limit_toritsugi"),
    specialSlot: row["special_slot"] === true,
    bankName: s(row, "bank_name"),
    bankBranch: s(row, "bank_branch"),
    accountType: s(row, "account_type"),
    accountNo: s(row, "account_no"),
    accountHolder: s(row, "account_holder"),
    note: s(row, "note"),
  };

  const title = agency.name || "（名称未登録）";

  /* --- 上位代理店に選べる相手。取次店・スタッフ・停止分と自分自身は外す --- */
  const parents: ParentOption[] = everyone
    .filter((a) => {
      if (!a.code || a.code === agency.code) return false;
      if (a.status === "停止・解約") return false;
      if (a.codeKind === "01" || a.codeKind === "02") return false;
      if (a.rank === "取次店") return false;
      return true;
    })
    .map((a) => ({ code: a.code, name: a.name || "（名称未登録）" }));

  // いま設定されている上位が候補に無い場合でも選び直せるよう、先頭に足しておく
  if (agency.parentCode && !parents.some((p) => p.code === agency.parentCode)) {
    parents.unshift({
      code: agency.parentCode,
      name: agency.parentName || "（名称未登録）",
    });
  }

  /* --- 配下と枠の使用状況 --- */
  // 枠の数え方は共通の枠ルール（lib/slots）に任せる。この画面で数え直すと、
  // 代理店側のダッシュボードや申込の受付判定と数字がずれてしまう。
  const me = everyone.find((a) => a.code === agency.code) ?? null;
  const children = everyone
    .filter((a) => a.parentCode === agency.code && a.code !== agency.code)
    .sort((a, b) => a.code.localeCompare(b.code));

  const slotModel = me ? slotModelOf(me) : "none";
  const slots = me ? buildSlotView(me, agency, children, everyone) : null;
  const anySlotFull = slots ? slots.rows.some((r) => r.isFull) : false;
  // スタッフ（コード区分02）だけが枠を消費しない
  const staff = children.filter(
    (a) => a.codeKind === "02" && a.status !== "停止・解約",
  );

  /*
   * この人が属している会社の代理店コード（英字4文字）。
   * 会社そのもの（SASA・METO）には出さない。自分がその会社だから。
   */
  const orgCodeOf = (a: { code: string; orgCode: string; parentCode: string }): string =>
    isOrgStyleCode(a.code) ? "" : a.orgCode || (isOrgStyleCode(a.parentCode) ? a.parentCode : "");

  const canHaveChildren =
    !["01", "02"].includes(agency.codeKind) && agency.rank !== "取次店";

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={`${codeTermOf(agency.code)} ${agency.code}${
          orgCodeOf(agency) ? `・代理店コード ${orgCodeOf(agency)}` : ""
        }・${kindLabel(agency.codeKind)}・${agencyTypeOf(agency.rank, agency.channel, agency.codeKind)}`}
        actions={backLink}
      />

      {agency.status === "停止・解約" ? (
        <Notice tone="bad">
          この代理店は停止・解約です。ポータルにログインできません。
          {agency.suspendedReason ? <>理由：{agency.suspendedReason}</> : null}
        </Notice>
      ) : null}

      {agency.status === "未稼働" ? (
        <Notice tone="warn">
          まだ本部の確認が済んでいません。内容を確かめたうえで、下の「稼働状況の切り替え」で
          稼働中にしてください。
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="稼働状況"
          value={agency.status || "未設定"}
          tone={agency.status === "稼働中" ? "default" : "warn"}
          hint={
            agency.status === "稼働中"
              ? "本部の確認が済んでいます"
              : "本部の確認が必要です"
          }
        />
        <StatTile
          label={slotModel === "area" ? "エリア枠（全国60社）" : "配下の枠の使用"}
          value={
            !slots
              ? "—"
              : slots.limit === null
                ? String(slots.used)
                : `${slots.used} / ${slots.limit}`
          }
          unit={!slots ? undefined : slotModel === "area" ? "社" : "件"}
          tone={anySlotFull ? "warn" : "default"}
          hint={
            !slots
              ? "取次パートナー・スタッフ・取次店は配下を持ちません"
              : slotModel === "area"
                ? anySlotFull
                  ? "埋まっているエリアがあります"
                  : "エリアごとの上限で数えています"
                : agency.specialSlot
                  ? "特別枠のため上限は数えません"
                  : anySlotFull
                    ? "埋まっている販路種別があります"
                    : "販路種別ごとに数えています"
          }
        />
        <StatTile
          label="直下のスタッフ"
          value={String(staff.length)}
          unit="名"
          hint="枠を消費しないのはスタッフだけです"
        />
        <StatTile
          label="研修"
          value={agency.trainingStatus || "未受講"}
          tone={agency.trainingStatus === "合格" ? "gold" : "default"}
          hint={
            agency.trainingPassedOn
              ? `${jpDate(agency.trainingPassedOn)} 合格`
              : "ライセンステストの結果"
          }
        />
      </div>

      {/* ── 承認にあたる操作を、いちばん手に取りやすい場所に置く ── */}
      <Card title="稼働状況の切り替え（本部の承認）">
        <StatusPanel agency={agency} />
      </Card>

      <Card title="基本情報">
        <InfoGrid>
          <Info label={codeTermOf(agency.code)}>
            <span className="tabnum">{agency.code}</span>
          </Info>
          {/* 会社そのものでないコードは、どの会社の下の番号かを併せて出す */}
          {orgCodeOf(agency) ? (
            <Info label="代理店コード">
              <span className="tabnum">{orgCodeOf(agency)}</span>
            </Info>
          ) : null}
          <Info label="法人名・お名前">{orDash(agency.name)}</Info>
          <Info label="代表者名">{orDash(agency.repName)}</Info>
          {/* 申込フォームと同じ呼び方で出す。データベースの持ち方（ランク＋販路種別）も併記する */}
          <Info label="代理店種別">
            {agencyTypeOf(agency.rank, agency.channel, agency.codeKind)}
            <div className="mt-0.5 text-xs text-ink-400">
              {orDash(agency.rank)} ／ {orDash(agency.channel)}
            </div>
          </Info>
          <Info label="コード区分">
            {agency.codeKind ? `${agency.codeKind}・${kindLabel(agency.codeKind)}` : orDash("")}
          </Info>
          {/*
            スタッフ・取次パートナーは「所属する会社」と「その上の代理店」が別。
            1つの欄にまとめると、どちらの意味か読み取れない。
          */}
          <Info label={agency.codeKind === "00" ? "上位代理店" : "所属する会社"}>
            {agency.parentCode ? (
              <Link
                href={`/admin/agencies/${encodeURIComponent(agency.parentCode)}`}
                className="underline underline-offset-4 hover:text-gold-300"
              >
                {agency.parentName || agency.parentCode}
                <span className="tabnum ml-1.5 text-xs text-ink-400">
                  {agency.parentCode}
                </span>
              </Link>
            ) : (
              <span className="text-ink-400">上位なし（本部の直下）</span>
            )}
          </Info>
          {/* 会社以外は、所属する会社の「さらに上」も出す */}
          {agency.codeKind !== "00" ? (
            <Info label="上位代理店">
              {parentOfParent ? (
                <Link
                  href={`/admin/agencies/${encodeURIComponent(parentOfParent.code)}`}
                  className="underline underline-offset-4 hover:text-gold-300"
                >
                  {parentOfParent.name || parentOfParent.code}
                  <span className="tabnum ml-1.5 text-xs text-ink-400">{parentOfParent.code}</span>
                </Link>
              ) : (
                <span className="text-ink-400">—</span>
              )}
            </Info>
          ) : null}
          <Info label="エリア区分">{orDash(agency.areaClass || agency.area)}</Info>
          <Info label="登録の経緯">{orDash(s(row, "registered_via"))}</Info>
        </InfoGrid>
      </Card>

      <Card title="連絡先">
        <InfoGrid>
          <Info label="メールアドレス">
            {agency.email ? (
              <a
                href={`mailto:${agency.email}`}
                className="underline underline-offset-4 hover:text-gold-300"
              >
                {agency.email}
              </a>
            ) : (
              orDash("")
            )}
          </Info>
          <Info label="電話番号">{orDash(agency.phone)}</Info>
          <Info label="郵便番号">{orDash(agency.zip)}</Info>
          <Info label="住所">{orDash(agency.address)}</Info>
          <Info label="店舗名">{orDash(agency.shopName)}</Info>
          <Info label="支店名">{orDash(agency.branchName)}</Info>
        </InfoGrid>
      </Card>

      <Card title="状態">
        <InfoGrid>
          <Info label="稼働状況">
            <StatusBadge status={agency.status} />
          </Info>
          <Info label="研修">
            <StatusBadge status={agency.trainingStatus} />
            {agency.trainingPassedOn ? (
              <span className="ml-2 text-xs text-ink-400">
                {jpDate(agency.trainingPassedOn)} 合格
              </span>
            ) : null}
          </Info>
          <Info label="電子署名">
            <StatusBadge status={agency.signStatus} />
            {s(row, "sign_method") ? (
              <span className="ml-2 text-xs text-ink-400">{s(row, "sign_method")}</span>
            ) : null}
            {s(row, "signed_on") ? (
              <span className="ml-2 text-xs text-ink-400">
                {jpDate(s(row, "signed_on"))} 署名
              </span>
            ) : null}
          </Info>
          {/* ご契約のご案内（QR2）の申請・承認は、下の「QRのご案内」欄にまとめている */}
          <Info label="停止・解約の理由">
            {agency.suspendedReason ? (
              <>
                {agency.suspendedReason}
                {s(row, "suspended_at") ? (
                  <span className="ml-2 text-xs text-ink-400">
                    {jpMoment(s(row, "suspended_at"))}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-ink-400">なし</span>
            )}
          </Info>
          <Info label="枠の上限">
            <span className="tabnum">
              販売 {limitText(agency.limitHanbai)} ／ サロン{" "}
              {limitText(agency.limitSalon)} ／ 個人 {limitText(agency.limitKojin)} ／ 取次{" "}
              {limitText(agency.limitToritsugi)}
            </span>
            {agency.specialSlot ? (
              <span className="ml-2 align-middle">
                <Badge tone="gold">特別枠</Badge>
              </span>
            ) : null}
            <span className="mt-1 block text-xs text-ink-400">
              0 は「上限なし」の扱いで、その販路種別の申し込みを止めません。
            </span>
          </Info>
        </InfoGrid>
      </Card>

      {/* ── お客様にお渡しするご案内（QR）の発行・承認 ── */}
      <QrPanel agency={agencyRow} />

      <Card title="報酬の振込先">
        {agency.bankName ||
        agency.bankBranch ||
        agency.accountNo ||
        agency.accountHolder ? (
          <InfoGrid>
            <Info label="金融機関名">{orDash(agency.bankName)}</Info>
            <Info label="支店名">{orDash(agency.bankBranch)}</Info>
            <Info label="預金の種類">{orDash(agency.accountType)}</Info>
            <Info label="口座番号">
              <span className="tabnum">{orDash(agency.accountNo)}</span>
            </Info>
            <Info label="口座名義（カナ）">{orDash(agency.accountHolder)}</Info>
          </InfoGrid>
        ) : (
          <EmptyState
            title="振込先がまだ登録されていません"
            description="報酬をお支払いするには、下の「内容を直す」で金融機関名・支店名・口座番号・口座名義をご登録ください。"
          />
        )}
      </Card>

      <Card
        title={
          slotModel === "area"
            ? "配下の枠　エリア枠（全国60社）"
            : "配下の枠　販路種別ごと"
        }
      >
        {!slots ? (
          <EmptyState
            title="この代理店には配下の枠がありません"
            description="取次パートナー・スタッフ・取次店ランクは配下を登録できないため、枠を数えていません。"
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>{slotModel === "area" ? "エリア" : "販路種別"}</Th>
                  <Th align="right">登録済</Th>
                  <Th align="right">上限</Th>
                  <Th align="right">残り</Th>
                  <Th>状況</Th>
                  <Th>数えている相手</Th>
                </tr>
              </thead>
              <tbody>
                {slots.rows.map((r) => (
                  <tr key={r.key}>
                    <Td>
                      <div className="min-w-0">
                        <div className="font-medium text-ink-100">{r.label}</div>
                        <div className="text-xs text-ink-400">{r.note}</div>
                      </div>
                    </Td>
                    <Td numeric align="right">
                      <span
                        className={cn(
                          "font-semibold",
                          r.isFull ? "text-warn-500" : "text-ink-100",
                        )}
                      >
                        {r.used}
                      </span>
                    </Td>
                    <Td numeric align="right">
                      {r.limit === null ? (
                        <span className="text-ink-400">上限なし</span>
                      ) : (
                        r.limit
                      )}
                    </Td>
                    <Td numeric align="right">
                      {r.remaining === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        r.remaining
                      )}
                    </Td>
                    <Td>
                      {r.isFull ? (
                        <Badge tone="warn">満枠</Badge>
                      ) : r.limit === null ? (
                        <Badge>上限なし</Badge>
                      ) : r.used === 0 ? (
                        <Badge>未登録</Badge>
                      ) : (
                        <Badge tone="good">空きあり</Badge>
                      )}
                    </Td>
                    <Td>
                      {r.members.length === 0 ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {r.members.map((m) => (
                            <span
                              key={m.code}
                              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-xs text-ink-200"
                              title={m.code}
                            >
                              {m.name || m.code}
                            </span>
                          ))}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="space-y-3 px-5 py-4">
              <p className="text-xs leading-relaxed text-ink-400">
                {slotModel === "area"
                  ? "総販売代理店の配下は統括代理店（2次代理店）です。1社ずつではなく、全国60社のエリア枠で数えます。エリア区分が「本部」の統括代理店は数えていません。"
                  : "どの枠に入るかは販路種別で決まります（コード区分ではありません）。スタッフ以外は枠を消費します（取次パートナーも取次枠を1件使います）。停止・解約になった配下は数えていません。"}
                {agency.specialSlot
                  ? "　この代理店は特別枠のため、上限では申し込みを止めません。"
                  : null}
              </p>
              {staff.length > 0 && slotModel !== "area" ? (
                <p className="text-xs leading-relaxed text-ink-400">
                  このほかに直下のスタッフが {staff.length} 名います（
                  {staff.map((a) => a.name || a.code).join("、")}）。
                  スタッフは代理店ではないため、枠を使いません。
                </p>
              ) : null}
              {slots.unclassified.length > 0 ? (
                <Notice tone="warn">
                  販路種別が入っていない配下が {slots.unclassified.length} 件あり、
                  どの枠にも数えられていません（
                  {slots.unclassified.map((a) => a.name || a.code).join("、")}）。
                  その代理店の画面で販路種別を入れると、正しい枠に数えられます。
                </Notice>
              ) : null}
            </div>
          </>
        )}
      </Card>

      <Card title={`配下の一覧　${children.length} 件`}>
        {children.length === 0 ? (
          <EmptyState
            title="配下はまだいません"
            description="この代理店が配ったQRから申し込みが入るか、下の欄で本部が手で登録すると、ここに並びます。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>コード</Th>
                <Th>法人名・お名前</Th>
                <Th>区分</Th>
                <Th>ランク</Th>
                <Th>販路種別</Th>
                <Th>稼働状況</Th>
                <Th>登録日</Th>
              </tr>
            </thead>
            <tbody>
              {children.map((c) => (
                <tr key={c.recordId || c.code}>
                  <Td numeric className="whitespace-nowrap font-medium text-ink-100">
                    <Link
                      href={`/admin/agencies/${encodeURIComponent(c.code)}`}
                      className="underline underline-offset-4 hover:text-gold-300"
                    >
                      {c.code || "—"}
                    </Link>
                  </Td>
                  <Td>
                    <div className="min-w-0">
                      <div className="truncate text-ink-100">
                        {c.name || "（名称未登録）"}
                      </div>
                      {c.representative ? (
                        <div className="truncate text-xs text-ink-400">
                          {c.representative}
                        </div>
                      ) : null}
                    </div>
                  </Td>
                  <Td>{kindLabel(c.codeKind)}</Td>
                  <Td>{c.rank || "—"}</Td>
                  <Td>{c.channel || "—"}</Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                  <Td numeric className="whitespace-nowrap">
                    {jpDate(c.createdAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {agency.codeKind === "00" ? (
        <Card title="自社代理店コード（配下の採番に使う英字）">
          <OrgCodeForm code={agency.code} name={agency.name} current={agency.orgCode} />
        </Card>
      ) : null}

      <Card title="内容を直す">
        <EditForm agency={agency} parents={parents} />
      </Card>

      {canHaveChildren ? (
        <Card title="この代理店の配下を、本部が手で登録する">
          <NewChildForm parentCode={agency.code} parentName={agency.name} />
        </Card>
      ) : (
        <Notice tone="info">
          取次パートナー・スタッフ・取次店ランクの下には代理店を登録できません（4次以降の禁止）。
          新しく登録する場合は、ひとつ上の代理店の画面から行ってください。
        </Notice>
      )}

      <Card title="操作の記録　新しい順に最大20件">
        {logs.length === 0 ? (
          <EmptyState
            title="記録はまだありません"
            description="この画面での承認・修正や、申込フォームからの登録があると、日時と担当が残ります。"
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>日時</Th>
                <Th>操作</Th>
                <Th>行った人</Th>
                <Th>内容</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={s(l, "id")}>
                  <Td numeric className="whitespace-nowrap">
                    {jpMoment(s(l, "created_at"))}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-100">{s(l, "action")}</Td>
                  <Td className="whitespace-nowrap">{s(l, "actor") || "—"}</Td>
                  <Td>{detailText(l["detail"])}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-ink-400">
        代理店コードは変更できません。受注・報酬・組織のデータがこのコードで結びついているためです。
      </p>
    </div>
  );
}
