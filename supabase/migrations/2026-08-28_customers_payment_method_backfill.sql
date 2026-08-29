-- 顧客台帳の「決済方法」が空のままのお客様を、受注から埋める。
--
-- 決済方法は 2026-08-27 に受注へ足した項目で、そのあと顧客台帳にも写すようにした。
-- それより前に入ったお客様は空のままで、顧客管理の画面では
-- 「クレジットカードなのか振込なのか」が分からない。
-- お支払いを手で直せるかどうかの判断にも使うので、受注から写しておく。
--
-- 同じお客様に受注が複数あるときは、いちばん新しい受注の決済方法を採る。

update public.customers c
set payment_method = o.payment_method
from (
  select distinct on (customer_id)
         customer_id,
         payment_method
  from public.orders
  where customer_id is not null
    and coalesce(payment_method, '') <> ''
  order by customer_id, id desc
) o
where c.id = o.customer_id
  and coalesce(c.payment_method, '') = '';
