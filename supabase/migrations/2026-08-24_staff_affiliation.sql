-- スタッフに「所属会社名」と「種別」を持たせる
--
-- 2026-08-22 の方針変更（庄司さん）:
--   ・代理店システム登録フォームはエリア統括代理店の申込専用になった
--   ・その配下は全員スタッフとして、エリア統括の4文字コード＋4桁で採番する
--       例) 株式会社佐々木(SASA) の下に SASA0001・SASA0002 …
--   ・「どこの会社の人か」「種別（販売代理店／サロン代理店／個人販売代理店）」は
--     申込フォームからは送られてこない。エリア統括代理店が自分の管理画面で設定する
--
-- 種別に既存の channel 列を使い回さない理由:
--   channel は「販路種別」として、報酬の単価（取次店27,500 か 販売代理店55,000 か）、
--   枠の振り分け、支払額の既定値、案内メールの文面の5系統に効いている。
--   スタッフに「販売代理店」を入れると受注一覧の単価が 27,500 → 55,000 に化ける。
--   意味の違うものを同じ列に入れないよう、種別は独立した列にする。

alter table public.agencies
  add column if not exists company_name text,
  add column if not exists staff_type text;

comment on column public.agencies.company_name is
  '所属している会社の名前。エリア統括の下のスタッフが、どこの会社の人かを表す。会社そのものの行では空。';
comment on column public.agencies.staff_type is
  'スタッフの種別（販売代理店／サロン代理店／個人販売代理店）。エリア統括代理店が管理画面で設定する。';

-- 種別は3つだけ。空（未設定）も許す。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agencies_staff_type_check'
  ) then
    alter table public.agencies
      add constraint agencies_staff_type_check
      check (
        staff_type is null
        or staff_type in ('販売代理店', 'サロン代理店', '個人販売代理店')
      );
  end if;
end $$;

-- 既存のスタッフには、いまの上位（所属している会社）の名前を写しておく。
-- 旧方式（会社が自分の4文字コードを持つ）の行が、所属だけ空欄に見えるのを防ぐ。
update public.agencies
set company_name = parent_name
where code_kind = '02'
  and coalesce(company_name, '') = ''
  and coalesce(parent_name, '') <> '';

-- 会社名と種別で絞り込む画面が増えるので index を足す
create index if not exists agencies_company_name_idx on public.agencies (company_name);
