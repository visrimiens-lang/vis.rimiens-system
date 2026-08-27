-- お支払いのステータス（着金待ち / 決済完了）。2026-08-27 会議。
--   クレジットカードは自動で「決済完了」。
--   銀行振込・アプラスは「着金待ち」から始まり、本部が確認して「決済完了」に変える。

-- 受注側。列を足すだけ（値の種類はアプリ側 lib/payment-status.ts が持つ）。
alter table public.orders
  add column if not exists payment_status text;

-- 顧客台帳側。「着金待ち」を許す。
-- 既存の許可値（未決済・審査中・決済完了・否決・キャンセル）はそのまま残す。
alter table public.customers
  drop constraint if exists customers_payment_status_check;
alter table public.customers
  add constraint customers_payment_status_check
  check (payment_status in ('未決済','審査中','着金待ち','決済完了','否決・キャンセル'));
