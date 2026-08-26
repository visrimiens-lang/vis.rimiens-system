"use client";

import { useActionState, useEffect, useState } from "react";
import {
  changeStatusAction,
  resendGuideMailAction,
  createAgencyAction,
  updateAgencyAction,
  type AgencyActionState,
} from "@/actions/agency-actions";
import { Notice, StatusBadge } from "@/components/ui";
import { AGENCY_TYPES, STAFF_TYPES, agencyTypeOf } from "@/lib/labels";

/**
 * 本部が代理店の内容を書き換える画面。
 *
 * 稼働状況の切り替えが「承認」にあたる操作なので、いちばん上に置き、
 * 押し間違いが起きないよう必ず確認を挟む。
 * 代理店コードは他のデータ（受注・報酬・組織）が紐づいているため変更できない。
 */

/* ═══════════════ 画面が受け取る形 ═══════════════ */

export type AgencyDetail = {
  id: string;
  code: string;
  name: string;
  repName: string;
  rank: string;
  channel: string;
  codeKind: string;
  /** 組織の英字（自社代理店コード）。配下の採番に使う。 */
  orgCode: string;
  parentCode: string;
  parentName: string;
  /** 所属している会社の名前。スタッフが「どこの会社の人か」を表す。 */
  companyName: string;
  nameKana: string;
  contactName: string;
  invoiceStatus: string;
  invoiceNo: string;
  /** スタッフの種別（販売代理店／サロン代理店／個人販売代理店）。 */
  staffType: string;
  email: string;
  phone: string;
  zip: string;
  address: string;
  shopName: string;
  branchName: string;
  birthday: string;
  area: string;
  areaClass: string;
  status: string;
  suspendedReason: string;
  trainingStatus: string;
  trainingPassedOn: string;
  signStatus: string;
  limitStaff: number;
  limitHanbai: number;
  limitSalon: number;
  limitKojin: number;
  limitToritsugi: number;
  specialSlot: boolean;
  bankName: string;
  bankBranch: string;
  accountType: string;
  accountNo: string;
  accountHolder: string;
  note: string;
};

/** 上位代理店に選べる相手。 */
export type ParentOption = { code: string; name: string };

/* ═══════════════ 選べる値 ═══════════════ */

const RANKS = ["総販売代理店", "2次代理店", "取次店"] as const;
const CHANNELS = [
  "販売代理店",
  "サロン代理店",
  "個人販売パートナー",
  "サロン提携パートナー（取次）",
  "未設定",
] as const;
const CODE_KINDS: { value: string; label: string }[] = [
  { value: "00", label: "00 ・会社" },
  { value: "01", label: "01 ・取次パートナー" },
  { value: "02", label: "02 ・スタッフ" },
];
const STATUSES = ["未稼働", "稼働中", "停止・解約"] as const;
const TRAININGS = ["未受講", "受講中", "合格", "不合格"] as const;
const SIGNS = ["未署名", "署名済"] as const;
const AREA_CLASSES = [
  "本部",
  "北海道+東北",
  "関東",
  "中部",
  "関西+近畿",
  "中国+四国",
  "九州+沖縄",
] as const;
const ACCOUNT_TYPES = ["普通", "当座"] as const;

/* ═══════════════ 見た目のまとめ ═══════════════ */

const initial: AgencyActionState = {};

const inputCls =
  "mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm text-ink-50 transition focus:border-gold-500 focus:outline-none disabled:opacity-60";
const labelCls = "text-xs font-medium tracking-wide text-ink-400";
const hintCls = "mt-1.5 block text-xs leading-relaxed text-ink-400";
const sectionTitleCls =
  "text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400";

const primaryBtn =
  "rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-on-gold transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-300";
const quietBtn =
  "rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-50 disabled:cursor-not-allowed disabled:text-ink-400";
const dangerBtn =
  "rounded-lg border border-bad-500/50 bg-bad-500/15 px-4 py-2 text-sm font-semibold text-bad-100 transition hover:bg-bad-500/25 disabled:cursor-not-allowed disabled:opacity-50";

/* ═══════════════ 小さな入力部品 ═══════════════ */

function Field({
  name,
  label,
  hint,
  defaultValue,
  type = "text",
  required,
  maxLength,
  disabled,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        className={inputCls}
      />
      {hint ? <span className={hintCls}>{hint}</span> : null}
    </label>
  );
}

function NumberField({
  name,
  label,
  hint,
  defaultValue,
  disabled,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue: number;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        min={0}
        max={200}
        step={1}
        inputMode="numeric"
        disabled={disabled}
        className={`${inputCls} tabnum`}
      />
      {hint ? <span className={hintCls}>{hint}</span> : null}
    </label>
  );
}

function SelectField({
  name,
  label,
  hint,
  defaultValue,
  disabled,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        disabled={disabled}
        className={inputCls}
      >
        {children}
      </select>
      {hint ? <span className={hintCls}>{hint}</span> : null}
    </label>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日付欄に入れられる形に直す。
 * kintone から移した古いデータには「1992-10-6」のような書き方が混じっているため、
 * そのままだと日付欄が空に見えてしまい、保存すると消えてしまう。
 */
function toDateValue(v: string): string {
  const raw = (v || "").trim();
  if (!raw) return "";
  if (ISO_DATE.test(raw)) return raw;
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-ink-800 bg-ink-950/40 px-4 py-4">
      <legend className={`${sectionTitleCls} px-1`}>{title}</legend>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
}

/* ═══════════════ 稼働状況の切り替え（＝承認の操作） ═══════════════ */

export function StatusPanel({ agency }: { agency: AgencyDetail }) {
  const [state, run, pending] = useActionState(changeStatusAction, initial);
  const [next, setNext] = useState(agency.status);
  const [confirming, setConfirming] = useState(false);

  // 保存が終わって画面が新しくなったら、選び直しの状態をそろえる
  useEffect(() => {
    setNext(agency.status);
    setConfirming(false);
  }, [agency.status]);

  const changed = next !== agency.status;
  const stopping = next === "停止・解約";

  /*
   * 承認フローは廃止したので、いま申込フォームから届くものは「稼働中」で入る。
   * ここが出るのは、廃止より前に届いて未稼働のまま残っているものだけ。
   * 下の選ぶ欄から「稼働中」を選び直す必要があると気づかれないまま
   * 置かれることがあったため、ひと押しで済むボタンを残してある。
   */
  const awaitingApproval = agency.status === "未稼働";

  return (
    <div className="px-5 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-300">いまの状態</span>
        <StatusBadge status={agency.status} />
        {agency.status === "停止・解約" && agency.suspendedReason ? (
          <span className="text-xs text-ink-400">理由：{agency.suspendedReason}</span>
        ) : null}
      </div>

      {awaitingApproval ? (
        <form action={run} className="mt-4 rounded-xl border border-gold-500/40 bg-gold-500/5 p-4">
          <input type="hidden" name="id" value={agency.id} />
          <input type="hidden" name="status" value="稼働中" />
          <p className="text-sm text-ink-200">
            この代理店は<strong className="text-ink-50">まだ稼働中になっていません</strong>。
            内容を確かめたら、下のボタンで稼働中にしてください。
          </p>
          <p className="mt-1 text-xs text-ink-400">
            稼働中にすると、登録されているメールアドレスあてにログインのご案内が
            自動で送られます（メール未登録のときは送られません）。
          </p>
          <button type="submit" disabled={pending} className={`${primaryBtn} mt-3`}>
            {pending ? "変更しています…" : "この代理店を稼働中にする"}
          </button>
        </form>
      ) : null}

      <form action={run} className="mt-4 space-y-4">
        <input type="hidden" name="id" value={agency.id} />

        <label className="block max-w-sm">
          <span className={labelCls}>この代理店を次の状態にする</span>
          <select
            name="status"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setConfirming(false);
            }}
            disabled={pending}
            className={inputCls}
          >
            {STATUSES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <span className={hintCls}>
            「稼働中」にすることが、この代理店を本部が承認したという意味になります。
            未稼働のままでもポータルには入れますが、本部の確認前の扱いです。
          </span>
        </label>

        {stopping ? (
          <label className="block max-w-2xl">
            <span className={labelCls}>停止・解約にする理由（必須）</span>
            <textarea
              name="reason"
              rows={3}
              maxLength={500}
              required
              disabled={pending}
              placeholder="例）ご本人からの解約のお申し出により停止。2026年8月末で契約終了。"
              className={`${inputCls} resize-y leading-relaxed`}
            />
            <span className={hintCls}>
              入力した理由と日時は代理店の記録に残り、後から誰でも確認できます。
              停止・解約にすると、この代理店はポータルにログインできなくなります。
            </span>
          </label>
        ) : null}

        {confirming ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3">
            <span className="text-sm text-warn-100">
              {agency.name || agency.code} を「{agency.status}」から「{next}」に変更します。
              よろしいですか？
            </span>
            <button
              type="submit"
              disabled={pending}
              className={stopping ? dangerBtn : primaryBtn}
            >
              {pending ? "変更中…" : "はい、変更する"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={quietBtn}
            >
              やめる
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending || !changed}
            className={primaryBtn}
          >
            {changed ? `「${next}」に変更する` : "変更する状態を選んでください"}
          </button>
        )}
      </form>

      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}

      {agency.status === "稼働中" ? <ResendGuideMail agency={agency} /> : null}
    </div>
  );
}

/* ═══════════════ 内容の修正 ═══════════════ */

export function EditForm({
  agency,
  parents,
}: {
  agency: AgencyDetail;
  /** 上位代理店に選べる相手（自分自身と、配下にぶら下げられない相手は除いてある）。 */
  parents: ParentOption[];
}) {
  const [state, run, pending] = useActionState(updateAgencyAction, initial);

  /*
    いまのランク＋販路種別が、申込フォームの6種別のどれに当たるか。
    どれにも当たらない古いデータ（例: 取次店＋未設定）のときは、
    うっかり別の種別で上書きされないように「いまの設定のまま」を選べるようにする。
  */
  const currentAgencyType = agencyTypeOf(agency.rank, agency.channel, agency.codeKind);
  const knownAgencyType = AGENCY_TYPES.some((v) => v.value === currentAgencyType);

  // 日付として読めない生年月日は、消してしまわないよう文字のまま直してもらう
  const birthdayValue = toDateValue(agency.birthday);
  const birthdayUnreadable = Boolean(agency.birthday) && !birthdayValue;

  return (
    <div className="px-5 py-5">
      <form action={run} className="space-y-5">
        <input type="hidden" name="id" value={agency.id} />

        <Section title="基本情報">
          <label className="block">
            <span className={labelCls}>代理店コード</span>
            <input
              type="text"
              value={agency.code}
              readOnly
              disabled
              className={`${inputCls} tabnum cursor-not-allowed`}
            />
            <span className={hintCls}>
              受注・報酬・組織のデータがこのコードで結びついているため、変更できません。
              付け替えが必要なときは本部の開発担当にご相談ください。
            </span>
          </label>

          <Field
            name="name"
            label="法人名・お名前"
            defaultValue={agency.name}
            required
            maxLength={120}
            disabled={pending}
            hint="一覧や組織図に出る名前です。"
          />
          <Field
            name="repName"
            label="代表者名"
            defaultValue={agency.repName}
            maxLength={60}
            disabled={pending}
          />

          {agency.codeKind === "02" ? (
            <Field
              name="companyName"
              label="所属会社名"
              defaultValue={agency.companyName}
              maxLength={100}
              disabled={pending}
              hint="このスタッフが所属している会社の名前です。報酬をこの名前でまとめられます。個人の方は空のままで結構です。"
            />
          ) : null}

          {/*
            代理店種別を選べるのは会社（コード区分00）だけ。
            スタッフ・取次パートナーには当てはまる種別が選択肢に無く、
            欄を出すと defaultValue がどれにも一致しないまま
            先頭の「エリア統括代理店」が選ばれた状態で保存され、
            ランクが 取次店 → 2次代理店 に化けて報酬まで立ってしまう。
            欄を出さなければ、サーバー側（agency-actions.ts）は
            ランクと販路種別をいまのまま据え置く。
          */}
          {agency.codeKind === "02" ? (
            /*
              スタッフの種別。2026-08-22 から、エリア統括の下は全員スタッフになり、
              「販売代理店か、サロンか、個人か」はここで設定する
              （申込フォームからは送られてこない）。
              ランクと販路種別は触らない。触ると受注一覧の単価が動くため。
            */
            <SelectField
              name="staffType"
              label="種別"
              defaultValue={agency.staffType}
              disabled={pending}
              hint="このスタッフがどの立場で販売するかです。組織図と報酬の集計に出ます。"
            >
              <option value="">未設定</option>
              {STAFF_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </SelectField>
          ) : agency.codeKind === "01" ? (
            <div>
              <span className={labelCls}>代理店種別</span>
              <p className="mt-1.5 text-sm text-ink-200">
                {agencyTypeOf(agency.rank, agency.channel, agency.codeKind)}
              </p>
              <p className="mt-1 text-xs text-ink-400">
                コード区分が「取次パートナー」のため、代理店種別は変更できません。
              </p>
            </div>
          ) : (
            <SelectField
              name="agencyType"
              label="代理店種別"
              /*
                いまの値が選択肢に無いときは、何も選ばない状態にする。
                選択肢に無い値を defaultValue に渡すと、ブラウザは先頭
                （エリア統括代理店）を選んだ状態にしてしまう。それに気づかず
                他の項目を直して保存すると、ランクが 取次店 → 2次代理店 に化け、
                本部の報酬台帳に 62,700 円が立つ。
                （ランク＋販路種別の組が申込フォームの6種別に無い古いデータで起きる）
              */
              defaultValue={knownAgencyType ? currentAgencyType : ""}
              disabled={pending}
              hint="申込フォームの選択肢と同じです。報酬の単価と、上位の枠の数え方がこれで決まります。"
            >
              {knownAgencyType ? null : (
                <option value="">いまの設定のまま（{currentAgencyType}）</option>
              )}
              {AGENCY_TYPES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.value}
                </option>
              ))}
            </SelectField>
          )}

          <SelectField
            name="codeKind"
            label="コード区分"
            defaultValue={agency.codeKind}
            disabled={pending}
            hint="一覧のタブの振り分けに使います。上位の枠は、区分にかかわらず1名ぶん使います。"
          >
            <option value="">未設定（どのタブにも出ません）</option>
            {CODE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            name="parentCode"
            label="上位代理店"
            defaultValue={agency.parentCode}
            disabled={pending}
            hint="付け替えると組織図と報酬のたどり先が変わります。自分の配下は選べません。"
          >
            <option value="">上位なし（本部の直下）</option>
            {parents.map((p) => (
              <option key={p.code} value={p.code}>
                {p.code}　{p.name}
              </option>
            ))}
          </SelectField>
        </Section>

        <Section title="連絡先">
          <Field
            name="email"
            label="メールアドレス"
            type="email"
            defaultValue={agency.email}
            maxLength={200}
            disabled={pending}
            placeholder="info@example.co.jp"
            hint="受注のお知らせとログイン情報の送り先になります。"
          />
          <Field
            name="phone"
            label="電話番号"
            defaultValue={agency.phone}
            maxLength={30}
            disabled={pending}
          />
          <Field
            name="zip"
            label="郵便番号"
            defaultValue={agency.zip}
            maxLength={10}
            disabled={pending}
            placeholder="812-0011"
          />
          <Field
            name="address"
            label="住所"
            defaultValue={agency.address}
            maxLength={200}
            disabled={pending}
          />
          <Field
            name="shopName"
            label="店舗名"
            defaultValue={agency.shopName}
            maxLength={120}
            disabled={pending}
          />
          <Field
            name="branchName"
            label="支店名"
            defaultValue={agency.branchName}
            maxLength={120}
            disabled={pending}
          />
          {birthdayUnreadable ? (
            <Field
              name="birthday"
              label="生年月日"
              defaultValue={agency.birthday}
              maxLength={20}
              disabled={pending}
              hint="いまの書き方では日付として読み取れません。「2000-04-01」の形に直すと、次からカレンダーで選べます。"
            />
          ) : (
            <Field
              name="birthday"
              label="生年月日"
              type="date"
              defaultValue={birthdayValue}
              disabled={pending}
              hint="個人の方だけご記入ください。"
            />
          )}
        </Section>

        <Section title="状態・エリア">
          <SelectField
            name="trainingStatus"
            label="研修の進み方"
            defaultValue={agency.trainingStatus || "未受講"}
            disabled={pending}
            hint="ライセンステストの結果を本部が入れます。"
          >
            {TRAININGS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectField>
          <Field
            name="trainingPassedOn"
            label="研修に合格した日"
            type="date"
            defaultValue={agency.trainingPassedOn.slice(0, 10)}
            disabled={pending}
          />
          <SelectField
            name="signStatus"
            label="電子署名"
            defaultValue={agency.signStatus || "未署名"}
            disabled={pending}
            hint="紙で契約書を受け取ったときも、ここで署名済にしてください。"
          >
            {SIGNS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectField>
          <SelectField
            name="areaClass"
            label="エリア区分"
            defaultValue={agency.areaClass}
            disabled={pending}
            hint="エリアごとの登録上限を数えるときに使います。"
          >
            <option value="">未設定</option>
            {AREA_CLASSES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectField>
          <Field
            name="area"
            label="エリア（自由記入）"
            defaultValue={agency.area}
            maxLength={60}
            disabled={pending}
            hint="市区町村など、区分に収まらない情報を書き添えるときに。"
          />
        </Section>

        <Section title="配下を登録できる数（枠の上限）">
          <NumberField
            name="limitStaff"
            label="スタッフの枠"
            defaultValue={agency.limitStaff}
            disabled={pending}
            hint="既定は100名です。0 にすると上限なしになります。直下にいる稼働中の方は、区分にかかわらず1名ぶん枠を使います。"
          />
          <label className="flex items-start gap-2.5 sm:col-span-2">
            <input
              type="checkbox"
              name="specialSlot"
              defaultChecked={agency.specialSlot}
              disabled={pending}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gold-500 disabled:opacity-60"
            />
            <span className="min-w-0">
              <span className="block text-sm text-ink-100">特別枠にする（上限を数えない）</span>
              <span className="block text-xs leading-relaxed text-ink-400">
                入れておくと、上の枠がいっぱいでも配下を登録できます。本部が個別に認めた相手だけに使ってください。
              </span>
            </span>
          </label>
        </Section>

        <Section title="報酬の振込先">
          <Field
            name="bankName"
            label="金融機関名"
            defaultValue={agency.bankName}
            maxLength={60}
            disabled={pending}
          />
          <Field
            name="bankBranch"
            label="支店名"
            defaultValue={agency.bankBranch}
            maxLength={60}
            disabled={pending}
          />
          <SelectField
            name="accountType"
            label="預金の種類"
            defaultValue={agency.accountType}
            disabled={pending}
          >
            <option value="">未設定</option>
            {ACCOUNT_TYPES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectField>
          <Field
            name="accountNo"
            label="口座番号"
            defaultValue={agency.accountNo}
            maxLength={20}
            disabled={pending}
          />
          <Field
            name="accountHolder"
            label="口座名義（カナ）"
            defaultValue={agency.accountHolder}
            maxLength={60}
            disabled={pending}
            hint="通帳のとおり、全角カナでご記入ください。"
          />
        </Section>

        <label className="block">
          <span className={labelCls}>本部の覚書</span>
          <textarea
            name="note"
            rows={3}
            maxLength={2000}
            defaultValue={agency.note}
            disabled={pending}
            placeholder="やり取りの経緯など、次に見る人へ残したいことを書いてください。"
            className={`${inputCls} resize-y leading-relaxed`}
          />
          <span className={hintCls}>本部だけが見ます。代理店の画面には出ません。</span>
        </label>

        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "保存中…" : "変更を保存する"}
        </button>
      </form>

      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════ 本部が配下を手で登録する ═══════════════ */

/**
 * 電話やFAXで届いた申込を、本部がこの代理店の配下として登録する。
 * 代理店コードは組織の英字と区分から自動で採番するので、入力は要らない。
 */
export function NewChildForm({
  parentCode,
  parentName,
}: {
  parentCode: string;
  parentName: string;
}) {
  const [state, run, pending] = useActionState(createAgencyAction, initial);

  return (
    <div className="px-5 py-5">
      {/* 登録できたら key が変わり、入力欄が空に戻る */}
      <form key={state.at ?? 0} action={run} className="space-y-4">
        <input type="hidden" name="parentCode" value={parentCode} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            name="name"
            label="法人名・お名前"
            required
            maxLength={120}
            disabled={pending}
            placeholder="例）株式会社リミエンス"
          />
          <Field name="repName" label="代表者名" maxLength={60} disabled={pending} />
          <SelectField
            name="codeKind"
            label="コード区分"
            defaultValue="00"
            disabled={pending}
            hint="コードには出ません。会社・取次パートナー・スタッフの区別に使います。"
          >
            {CODE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            name="agencyType"
            label="代理店種別"
            defaultValue="販売代理店"
            disabled={pending}
          >
            {AGENCY_TYPES.map((v) => (
              <option key={v.value} value={v.value}>
                {v.value}
              </option>
            ))}
          </SelectField>
          <SelectField name="areaClass" label="エリア区分" defaultValue="" disabled={pending}>
            <option value="">未設定</option>
            {AREA_CLASSES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectField>
          <Field
            name="email"
            label="メールアドレス"
            type="email"
            maxLength={200}
            disabled={pending}
            placeholder="info@example.co.jp"
          />
          <Field name="phone" label="電話番号" maxLength={30} disabled={pending} />
        </div>

        <label className="block">
          <span className={labelCls}>本部の覚書</span>
          <textarea
            name="note"
            rows={2}
            maxLength={2000}
            disabled={pending}
            placeholder="例）8/11 に電話でお申し込み。契約書は郵送済み。"
            className={`${inputCls} resize-y leading-relaxed`}
          />
        </label>

        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "登録中…" : `${parentName || parentCode} の配下として登録する`}
        </button>

        <p className="text-xs leading-relaxed text-ink-400">
          登録した直後は「未稼働」です。内容を確かめてから、上の欄で「稼働中」に切り替えてください。
          ポータルのログイン情報は、代理店管理の一覧の下にある発行欄から出せます。
        </p>
      </form>

      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}
    </div>
  );
}


/**
 * 案内メールをもう一度送る。
 *
 * 代理店から「届いていない」と言われたときに使う。
 * 承認のときは二重に送らない作りにしているため、送り直しはここからだけ。
 */
function ResendGuideMail({ agency }: { agency: AgencyDetail }) {
  const [state, run, pending] = useActionState(resendGuideMailAction, initial);
  return (
    <form action={run} className="mt-4 border-t border-ink-800 pt-4">
      <input type="hidden" name="id" value={agency.id} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={quietBtn}>
          {pending ? "送信中…" : "案内メールを送り直す"}
        </button>
        <span className={hintCls}>
          「案内のメールが届いていない」とご連絡があったときにお使いください。
        </span>
      </div>
      {state.error ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Notice tone="info">{state.ok}</Notice>
        </div>
      ) : null}
    </form>
  );
}
