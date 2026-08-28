-- アプラス（ショッピングクレジット）の申込URLを送ったかどうかを記録する。
--
-- アプラスはAPIで連携できず、担当者がお客様へ申込URLをメールで送る手作業になる。
-- 「送ったつもりで送っていない」「送ったか分からず二重に送る」が起きると、
-- お客様の審査がいつまでも始まらないまま、受注だけが着金待ちで止まる。
-- 送った日時を残して、受注一覧・顧客管理から一目で分かるようにする。
--
-- 2026-08-27 の打合せでの依頼（ヒューマンエラーをなくしたい）。

alter table public.orders
  add column if not exists aplus_url_sent_at timestamptz;

comment on column public.orders.aplus_url_sent_at is
  'アプラスの申込URLをお客様へ送った日時。未送付は null。';
