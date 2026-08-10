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

