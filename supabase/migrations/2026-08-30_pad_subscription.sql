-- 1年後の定期パッド配送（17,500円/年）の管理列。
--
-- 本体を買った方は全員、1年後（OP①付きは2年後）から定期パッド配送が始まる
-- （2026-08-27 会議の決定）。クレジットカードのお客様は Stripe に定期を自動で
-- 作り、その契約IDを pad_subscription_id に控える。
-- 銀行振込・アプラスのお客様はカードが無く自動化できないので、
-- pad_charge_from（初回請求予定日）だけを残し、本部が期日に請求書を送る。
--
-- pad_subscription_id が空で pad_charge_from が入っているお客様＝手動請求の対象。

alter table public.customers
  add column if not exists pad_subscription_id text;

alter table public.customers
  add column if not exists pad_charge_from date;

comment on column public.customers.pad_subscription_id is
  'Stripe上の定期パッド配送の契約ID（sub_…）。自動課金が仕込めたお客様に入る。';
comment on column public.customers.pad_charge_from is
  '定期パッド配送の初回請求予定日。本体購入の1年後（OP①付きは2年後）。';
