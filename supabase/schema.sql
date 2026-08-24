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

-- ────────────────────────────────────────────
-- 顧客（App8）
-- ────────────────────────────────────────────
create table if not exists public.customers (
  id                bigint generated always as identity primary key,
  name              text not null,
  name_kana         text,
  email             text,
  phone             text,
  zip               text,
  address           text,
  building          text,

  referrer_code     text,                          -- 紹介元（入口）＝取次店コードなど
  closer_code       text,                          -- 契約担当（出口）
  agency_code       text,                          -- 売った代理店
  staff_code        text,                          -- 誰が売ったか（8/7会議で追加要望）

  review_status     text default '申込中' check (review_status in ('申込中','審査完了','審査NG')),
  payment_status    text default '未決済' check (payment_status in ('未決済','審査中','決済完了','否決・キャンセル')),
  payment_method    text,
  contracted_on     date,
  consented_on      date,

  ship_status       text default '未出荷' check (ship_status in ('未出荷','出荷手配中','出荷済')),
  tracking_no       text,
  delivered_on      date,
  serial_no         text,

  warranty_status   text default '未登録' check (warranty_status in ('未登録','仮保証','本保証')),
  pad_subscription  text default '未登録' check (pad_subscription in ('未登録','登録済','決済エラー','解約済')),
  points            integer default 0,

  line_user_id      text,
  line_name         text,
  line_registered_at timestamptz,

  receipt_name      text,
  family_rep_id     text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists customers_agency_idx   on public.customers (agency_code);
create index if not exists customers_referrer_idx on public.customers (referrer_code);
create index if not exists customers_phone_idx    on public.customers (phone);

-- ────────────────────────────────────────────
-- 受注（App10）
-- ────────────────────────────────────────────
create table if not exists public.orders (
  id                bigint generated always as identity primary key,
  ordered_on        date not null default current_date,
  customer_id       bigint references public.customers(id) on delete set null,
  customer_name     text not null,
  phone             text,
  zip               text,
  address           text,
  building          text,

  product_name      text,
  product_id        bigint references public.products(id) on delete set null,
  quantity          integer not null default 1,
  amount            integer not null default 0,     -- 販売金額（円）
  payment_method    text check (payment_method is null or payment_method in ('九州信販','アプラス','ライフカード','Stripe','スクエア','代引き')),

  -- 誰の売上か（3階層ぶん保持する）
  agency_code       text,                           -- 売った代理店
  staff_code        text,                           -- 売ったスタッフ
  niji_code         text,                           -- 2次代理店（統括）
  zeroth_code       text,                           -- ゼロ次代理店
  referrer_code     text,                           -- 取次紹介コード
  match_status      text default '直販' check (match_status in ('照合済','要確認','直販')),

  review_result     text check (review_result is null or review_result in ('承認','否決','電話確認待ち')),
  credit_ref_no     text,                           -- 信販受付番号
  stripe_payment_id text,
  subscription_id   text,
  pad_first_debit_on date,
  auto_debit_agreed_at timestamptz,

  ship_status       text not null default '出荷待ち'
                    check (ship_status in ('出荷待ち','出荷手配中','出荷済','キャンセル')),
  tracking_no       text,                           -- ヤマト送り状番号
  shipped_on        date,

  points            integer default 0,
  status_history    text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_agency_idx   on public.orders (agency_code);
create index if not exists orders_niji_idx     on public.orders (niji_code);
create index if not exists orders_referrer_idx on public.orders (referrer_code);
create index if not exists orders_date_idx     on public.orders (ordered_on desc);

-- ────────────────────────────────────────────
-- 報酬（App11）
--   受注1件から、階層ごとに複数行が立つ
--   （2次代理店の報酬と取次店の報酬が同時に発生するため）
-- ────────────────────────────────────────────
create table if not exists public.rewards (
  id                bigint generated always as identity primary key,
  order_id          bigint references public.orders(id) on delete cascade,
  agency_code       text not null,                  -- 受け取る代理店
  agency_rank       text,                           -- 計上時点のランク（後で変わっても履歴は残す）
  month             text not null,                  -- 対象月 'YYYY-MM'
  amount            integer not null default 0,
  kind              text not null default '販売報酬',
  status            text not null default '未確定'
                    check (status in ('未確定','確定','支払済','取消')),
  confirmed_on      date,                           -- 配送完了で確定する
  paid_on           date,
  cancel_reason     text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists rewards_agency_month_idx on public.rewards (agency_code, month);
create index if not exists rewards_order_idx on public.rewards (order_id);

-- ────────────────────────────────────────────
-- デモ機（App13 / App15）
-- ────────────────────────────────────────────
create table if not exists public.demo_machines (
  id                bigint generated always as identity primary key,
  serial_no         text unique,
  model             text default 'VIS本体',
  acquired_kind     text check (acquired_kind is null or acquired_kind in ('個人購入','デモ機購入','無料貸与')),
  acquired_on       date,
  state             text not null default '在庫'
                    check (state in ('在庫','設置済','貸出中','返却済','故障・修理','廃棄')),
  holder_code       text,                           -- 保有代理店コード
  holder_name       text,
  customer_name     text,
  lend_to           text,
  lend_on           date,
  return_due_on     date,
  returned_on       date,
  purpose           text,
  converted         text default '該当なし' check (converted in ('該当なし','転用済','未転用')),
  photo_url         text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists demo_holder_idx on public.demo_machines (holder_code);

-- ────────────────────────────────────────────
-- トスアップ（App14）
--   取次パートナーがお客様を紹介する
-- ────────────────────────────────────────────
create table if not exists public.leads (
  id                bigint generated always as identity primary key,
  customer_name     text not null,
  phone             text,
  phone_normalized  text,                           -- ハイフン等を除いた形。照合に使う
  referrer_code     text not null,                  -- 取次店コード
  status            text not null default 'トスアップ済'
                    check (status in ('トスアップ済','商談中','成約','不成立','体験同意・検討中')),
  tossed_at         timestamptz not null default now(),
  closed_on         date,
  order_id          bigint references public.orders(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists leads_referrer_idx on public.leads (referrer_code);
create index if not exists leads_phone_idx    on public.leads (phone_normalized);

-- ────────────────────────────────────────────
-- 操作の記録
--   誰がいつ何を承認したかを残す（薬機法まわりの追跡用）
-- ────────────────────────────────────────────
create table if not exists public.audit_log (
  id            bigint generated always as identity primary key,
  actor         text not null,                      -- 'HQ' または代理店コード
  action        text not null,                      -- 'QR2承認' '増枠承認' 'パスワード発行' など
  target_type   text,                               -- 'agency' 'order' など
  target_key    text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists audit_created_idx on public.audit_log (created_at desc);

-- ────────────────────────────────────────────
-- 外部から届いた生データの控え
--   JotForm・決済の webhook をそのまま保存する。
--   取り込みに失敗しても、ここから作り直せるようにするため。
-- ────────────────────────────────────────────
create table if not exists public.inbox (
  id            bigint generated always as identity primary key,
  source        text not null,                      -- 'jotform' 'utage' 'stripe'
  form_id       text,
  external_id   text,                               -- 送信ID。重複取り込みの防止に使う
  payload       jsonb not null,
  processed     boolean not null default false,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

create unique index if not exists inbox_external_idx
  on public.inbox (source, external_id) where external_id is not null;
create index if not exists inbox_unprocessed_idx
  on public.inbox (created_at) where processed = false;

-- ────────────────────────────────────────────
-- 全テーブルで RLS を有効化する。
-- ポリシーは作らない ＝ 公開キーからは一切読めない。
-- サーバー（秘密鍵）だけが読み書きする。
-- ────────────────────────────────────────────
alter table public.agencies      enable row level security;
alter table public.products      enable row level security;
alter table public.customers     enable row level security;
alter table public.orders        enable row level security;
alter table public.rewards       enable row level security;
alter table public.demo_machines enable row level security;
alter table public.leads         enable row level security;
alter table public.audit_log     enable row level security;
alter table public.inbox         enable row level security;

-- updated_at を自動で更新する
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['agencies','products','customers','orders','rewards','demo_machines','leads']
  loop
    execute format(
      'drop trigger if exists %I_touch on public.%I; '
      'create trigger %I_touch before update on public.%I '
      'for each row execute function public.touch_updated_at()',
      t, t, t, t);
  end loop;
end $$;


-- ═══════════════════════════════════════════════════════════
--  ポータルの運営に使う表
--
--  上の9つ（代理店・受注など）が業務のデータなのに対して、
--  ここから下はポータルを動かすための表。
--  本番には作ってあるが、この設計書に書き漏らしていた（2026-08-11 に追記）。
--  ここが無いまま作り直すと、次の4つが「エラーも出さずに」効かなくなる:
--    ・ログインの回数制限（総当たりが素通りする）
--    ・パスワード再発行の申請（申請が保存されず宙に浮く）
--    ・お知らせ／資料（代理店側に「準備中」とだけ出る）
-- ═══════════════════════════════════════════════════════════

-- ログインの失敗回数。総当たりを止めるために使う。
-- key は "login:<代理店コード>" と "login-ip:<IPアドレス>" の2種類。
create table if not exists public.portal_login_attempts (
  id             bigint generated by default as identity primary key,
  key            text        not null unique,
  failures       integer     not null default 0,
  last_failed_at timestamptz not null default now(),
  locked_until   timestamptz
);
create index if not exists portal_login_attempts_key_idx
  on public.portal_login_attempts (key);

-- 「パスワードを忘れた」の申請。本部が代理店管理の画面で受け取る。
create table if not exists public.portal_password_requests (
  id          bigint generated by default as identity primary key,
  agency_code text        not null,
  contact     text        not null,
  note        text,
  status      text        not null default 'pending'
                check (status in ('pending','done','rejected')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists portal_password_requests_status_idx
  on public.portal_password_requests (status, created_at desc);

-- 本部から代理店へのお知らせ。published が false のものは代理店に出さない。
create table if not exists public.portal_notices (
  id           bigint generated by default as identity primary key,
  title        text        not null,
  body         text        not null default '',
  published_on date        not null default current_date,
  important    boolean     not null default false,
  published    boolean     not null default true,
  created_at   timestamptz not null default now()
);

-- 資料の一覧。ファイル本体は Storage の公開バケット portal-docs に置く。
-- ★ このバケットも別途作る必要がある（Storage > New bucket > 公開）。
create table if not exists public.portal_documents (
  id          bigint generated by default as identity primary key,
  name        text        not null,
  category    text        not null default 'その他',
  description text,
  file_url    text,
  file_name   text,
  file_size   bigint,
  updated_on  date        not null default current_date,
  published   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- 上の4つも、業務のデータと同じく秘密鍵からしか読めないようにする。
alter table public.portal_login_attempts    enable row level security;
alter table public.portal_password_requests enable row level security;
alter table public.portal_notices           enable row level security;
alter table public.portal_documents         enable row level security;
