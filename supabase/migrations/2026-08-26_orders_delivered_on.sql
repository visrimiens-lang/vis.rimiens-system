-- 受注に「配達完了日」を持たせる
--
-- 2026-08-26 の決定。
-- 売上・報酬は「配達完了になったら反映」に変える。
-- それまでは出荷完了日（shipped_on）で月を切っていた。
--
-- 配達完了日はこれまで顧客台帳（customers.delivered_on）にしか無かった。
-- お客様1人が2件買うと、あとから保存したほうの日付で上書きされてしまい、
-- 受注ごとの売上を配達完了で切ることができない。受注の側に持たせる。

alter table public.orders add column if not exists delivered_on date;

comment on column public.orders.delivered_on is
  '配達が完了した日。売上・報酬はこの日付の月で集計する（2026-08-26〜）。';

-- ── 既存分の移送 ────────────────────────────────────────
-- (1) 顧客台帳に配達完了日が入っているものは、それを写す
update public.orders o
set delivered_on = c.delivered_on
from public.customers c
where o.customer_id = c.id
  and c.delivered_on is not null
  and o.delivered_on is null;

-- (2) 残りは、出荷完了日をそのまま配達完了日として移す
--     切り替えた瞬間に、これまでの売上が一斉に消えるのを防ぐため。
--     キャンセルは対象外（届いていないため）。
update public.orders
set delivered_on = shipped_on
where delivered_on is null
  and shipped_on is not null
  and coalesce(ship_status, '') <> 'キャンセル';

create index if not exists orders_delivered_on_idx
  on public.orders (delivered_on);

-- 確認用（実行後に流すと、移送できたかが分かります）
-- select id, customer_name, ship_status, shipped_on, delivered_on
-- from public.orders order by id desc limit 20;
