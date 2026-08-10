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

