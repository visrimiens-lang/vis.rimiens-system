-- お支払いのステータス（着金待ち / 決済完了）。2026-08-27 会議。
--   クレジットカードは自動で「決済完了」。
--   銀行振込・アプラスは「着金待ち」から始まり、本部が確認して「決済完了」に変える。
alter table public.orders
  add column if not exists payment_status text;
