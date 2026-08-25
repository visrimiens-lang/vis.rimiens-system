-- 申込フォームで受け取っているのに台帳へ写していなかった項目の置き場
--
-- 会社名フリガナ・担当者・法人番号・インボイスは、受信箱の生データには
-- 残っているが、代理店の台帳（agencies）に列が無く、適格請求書の照合や
-- 担当者への連絡のたびに受信箱を開くことになっていた。

alter table public.agencies
  add column if not exists name_kana text,
  add column if not exists contact_name text,
  add column if not exists corporate_no text,
  add column if not exists invoice_status text,
  add column if not exists invoice_no text;

comment on column public.agencies.name_kana is '会社名（フリガナ）';
comment on column public.agencies.contact_name is '担当者氏名（代表者と別のとき）';
comment on column public.agencies.corporate_no is '法人番号（任意）';
comment on column public.agencies.invoice_status is 'インボイス登録（登録済／未登録／申請中）';
comment on column public.agencies.invoice_no is 'インボイス登録番号（任意）';
