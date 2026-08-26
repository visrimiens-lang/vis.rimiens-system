-- スタッフの種別に「取次店」を足す
--
-- 2026-08-26 決定。エリア統括の下に、紹介だけを行う取次店も置けるようにする。
-- 支払額の既定は「取次店だけ 25,000円、それ以外は 50,000円」（lib/pay-defaults.ts）。

alter table public.agencies drop constraint if exists agencies_staff_type_check;

alter table public.agencies
  add constraint agencies_staff_type_check
  check (
    staff_type is null
    or staff_type in ('販売代理店', 'サロン代理店', '個人販売代理店', '取次店')
  );
