-- 代理店ごとの支払単価
--
-- ■ 何のために足すか
--
-- いま報酬の単価は商品マスタにランク別で1組だけ持っていて、全代理店に同じ額が当たる。
-- 「推奨は 55,000円だが、佐々木さんだけ 30,000円にしたい」ができない。
-- インボイス登録の有無で額を変えたいという話も出ている。
--
-- そこで「この代理店に払う額」を代理店自身のレコードに持たせる。
-- 入っていればその額を使い、空なら今までどおり商品マスタの額を使う。
--
-- ■ 誰が決めるか
--
-- その代理店の上位（エリア統括代理店）と本部。
-- 上位が自分の配下に払う額を自分で決められるようにするための欄なので、
-- 本人が自分の額を書き換えられてはいけない。権限はアプリ側で見る。
--
-- ■ すでに計上した報酬は変えない
--
-- 変更しても過去の報酬レコードには触らない。
-- 報酬は受注のたびに計上され、配送完了で確定する。
-- 遡って書き換えると「先月払った額が今月変わる」が起きるため、
-- 変更は次の受注から効く。

alter table public.agencies
  add column if not exists pay_unit integer;

comment on column public.agencies.pay_unit is
  '上位からこの代理店に払う1台あたりの報酬額。空なら商品マスタのランク別単価を使う。';

alter table public.agencies
  add column if not exists pay_unit_note text;

comment on column public.agencies.pay_unit_note is
  '支払単価を既定と変えた理由（インボイス未登録、個別契約など）。';

-- 決済方法に「振込」を追加
--
-- 2026-08-19 の打合せで、QR2 の決済にアプラスと振込を足すことが決まった。
-- アプラスは最初から受け付けているが、振込は無かったため、
-- UTAGE が「振込」を送ってくると受注の登録が制約違反で失敗してしまう。
-- 受け付ける言葉に「振込」を足す。

alter table public.orders
  drop constraint if exists orders_payment_method_check;

alter table public.orders
  add constraint orders_payment_method_check
  check (payment_method is null or payment_method in
    ('九州信販','アプラス','ライフカード','Stripe','スクエア','代引き','振込'));
