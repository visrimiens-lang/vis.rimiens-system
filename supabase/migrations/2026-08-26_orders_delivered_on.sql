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

-- ── 顧客台帳にも写す ──────────────────────────────────
-- 本部の顧客一覧とお客様マイページは顧客台帳（customers）を見ている。
-- 受注側にだけ配達完了日を入れると、同じお客様が
-- 代理店の画面では「配達完了」、マイページでは「未出荷」に見えてしまう。
--
-- 1人が複数買っている場合は、いちばん新しい受注の状態を写す。
update public.customers c
set delivered_on = o.delivered_on,
    ship_status  = case o.ship_status
                     when '出荷待ち' then '未出荷'
                     when 'キャンセル' then c.ship_status
                     else o.ship_status
                   end
from (
  select distinct on (customer_id)
         customer_id, delivered_on, ship_status
  from public.orders
  where customer_id is not null
  order by customer_id, coalesce(delivered_on, shipped_on, ordered_on) desc, id desc
) o
where c.id = o.customer_id
  and (c.delivered_on is distinct from o.delivered_on
       or c.ship_status is distinct from o.ship_status);
