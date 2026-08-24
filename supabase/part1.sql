-- ============================================================
-- VIS 代理店管理システム データベース設計
--
-- kintone（全13アプリ）と kViewer を、このアプリ1つに置き換える。
-- 元の定義は kintone-backup/20260810/ に保存してある。
--
-- 方針:
--  ・kintone の「アプリ」= ここのテーブル
--  ・kintone の選択肢フィールド = text + CHECK 制約（後から値を足しやすいため）
--  ・kintone の計算式フィールド = アプリ側で計算（DBには保存しない）
--  ・金額は円単位の integer（小数は扱わない）
--  ・RLS は全テーブルで有効。読み書きはサーバー（秘密鍵）からのみ。
-- ============================================================

-- ────────────────────────────────────────────
-- 代理店マスタ（kintone App9 の置き換え）
-- ────────────────────────────────────────────
create table if not exists public.agencies (
  id                bigint generated always as identity primary key,
  code              text not null unique,          -- 代理店コード（RIM0003 など）
  name              text not null,                 -- 法人名または氏名
  rep_name          text,                          -- 代表者名
  rank              text not null default '取次店'
                    check (rank in ('総販売代理店','2次代理店','取次店')),
  channel           text default '未設定'
                    check (channel in ('サロン提携パートナー（取次）','サロン代理店','個人販売パートナー','販売代理店','未設定')),
  code_kind         text,                          -- 00=会社 01=取次パートナー 02=スタッフ
  branch_no         integer,                       -- 枝番
  parent_code       text,                          -- 上位代理店コード
  parent_name       text,
  zeroth_code       text,                          -- ゼロ次代理店コード（集計用）
  invite_code       text,                          -- 招待コード
  area              text,
  area_class        text
                    check (area_class is null or area_class in ('本部','北海道+東北','関東','中部','関西+近畿','中国+四国','九州+沖縄')),
  status            text not null default '未稼働'
                    check (status in ('未稼働','稼働中','停止・解約')),

  -- 連絡先
  email             text,
  phone             text,
  zip               text,
  address           text,
  shop_name         text,
  branch_name       text,
  birthday          text,

  -- 枠（配下に登録できる数の上限。既定は 2026-07-30 会議で決めた 10/30/30/30）
  limit_hanbai      integer not null default 10,   -- 販売代理店枠
  limit_salon       integer not null default 30,   -- サロン代理店枠
  limit_kojin       integer not null default 30,   -- 個人販売パートナー枠
  limit_toritsugi   integer not null default 30,   -- 取次パートナー枠
  pay_unit integer,
  pay_unit_note text,
  org_code text,
  -- 2026-08-22 から枠は「スタッフ100名」の1本。上の4列は過去の記録用に残している
  limit_staff integer not null default 100,
  -- スタッフが所属している会社の名前と種別（エリア統括が管理画面で設定する）
  company_name text,
  staff_type text check (staff_type is null or staff_type in ('販売代理店', 'サロン代理店', '個人販売代理店')),
  special_slot      boolean not null default false, -- 特別枠（上限の対象外）
  slot_request      text not null default 'なし'
                    check (slot_request in ('なし','申請中','承認済','却下')),

  -- 研修・署名・QR
  training_status   text not null default '未受講'
                    check (training_status in ('未受講','受講中','合格','不合格')),
  training_passed_on date,
  sign_status       text not null default '未署名'
                    check (sign_status in ('未署名','署名済')),
  sign_method       text,
  signed_on         date,
  qr2_status        text not null default '未申請'
                    check (qr2_status in ('未申請','申請中','承認済','差戻し')),
  qr2_requested_on  date,
  qr2_rejected_note text,
  qr1_url           text,
  qr2_url           text,

  -- 振込先
  bank_name         text,
  bank_branch       text,
  account_type      text check (account_type is null or account_type in ('普通','当座')),
  account_no        text,
  account_holder    text,                          -- 口座名義（カナ）

  -- ポータルのログイン
  portal_password   text,                          -- bcrypt ハッシュ。平文は保存しない
  portal_last_login timestamptz,

  -- デモ機・LINE
  demo_status       text check (demo_status is null or demo_status in ('未保有','デモ機購入','個人購入転用','無料貸与')),
  line_status       text default '未登録' check (line_status in ('未登録','登録済')),

  -- 登録の経緯（JotForm から入ってくる）
  registered_via    text check (registered_via is null or registered_via in ('代理店システム登録','取次パートナー登録','スタッフ登録','手動登録')),
  jotform_id        text,                          -- JotForm の送信ID（重複登録の防止に使う）
  applied_at        timestamptz,
  applied_ip        text,
  applied_ua        text,
  guide_mailed_at   timestamptz,                   -- 案内メールを送った日時（二重送信の防止）

  suspended_at      timestamptz,
  suspended_reason  text,
  last_active_on    date,
  note              text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists agencies_parent_idx on public.agencies (parent_code);
create index if not exists agencies_rank_idx   on public.agencies (rank);
create index if not exists agencies_status_idx on public.agencies (status);
create unique index if not exists agencies_jotform_idx
  on public.agencies (jotform_id) where jotform_id is not null;

-- ────────────────────────────────────────────
-- 商品マスタ（App12）
--   代理店ランクごとの報酬単価を持つ。
-- ────────────────────────────────────────────
create table if not exists public.products (
  id                bigint generated always as identity primary key,
  name              text not null,
  price_incl_tax    integer,                       -- 販売単価（税込）
  reward_target     text not null default '対象' check (reward_target in ('対象','対象外')),
  amount_so         integer,                       -- 総販売代理店の報酬額
  amount_niji       integer,                       -- 2次代理店の報酬額
  amount_hanbai     integer,                       -- 販売代理店の報酬額
  amount_toritsugi  integer,                       -- 取次店の報酬額
  bonus_10          text default '対象外' check (bonus_10 in ('対象','対象外')),
  points            integer default 0,
  sort_order        integer default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

