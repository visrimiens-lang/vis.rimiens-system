-- 枠を「スタッフ100名」の1本にする
--
-- 2026-08-22 の方針変更（庄司さん）: 「組織と枠 → 100名（スタッフ）」
--
-- これまでは販路種別ごとに4本の枠を持っていた。
--   販売代理店10 ／ サロン代理店30 ／ 個人販売パートナー30 ／ 取次パートナー30 ＝ 合計100
-- エリア統括の下が全員スタッフになるため、種別ごとに分ける意味がなくなった。
--
-- 既存の4列は消さない。
--   ・増枠を承認した実績（RIM0003 は販売枠を10→20に増やしてある）が残っている
--   ・本部の操作記録に「販売代理店の枠を10→20に変更」と残っており、
--     列を消すとその履歴が読めなくなる

alter table public.agencies
  add column if not exists limit_staff integer not null default 100;

comment on column public.agencies.limit_staff is
  '直下に登録できるスタッフの上限（既定100名）。2026-08-22 から枠はこの1本。';

-- 既存行の初期値は、いまの4枠の合計にする。
-- 増枠を承認済みの代理店（RIM0003 = 110）の実績をそのまま引き継ぐため。
-- どれか1つでも 0（＝上限なしの意味で使われている）なら、合計も 0（上限なし）にする。
update public.agencies
set limit_staff = case
  when coalesce(limit_hanbai, 0) = 0
    or coalesce(limit_salon, 0) = 0
    or coalesce(limit_kojin, 0) = 0
    or coalesce(limit_toritsugi, 0) = 0
  then 0
  else coalesce(limit_hanbai, 0)
     + coalesce(limit_salon, 0)
     + coalesce(limit_kojin, 0)
     + coalesce(limit_toritsugi, 0)
end
where limit_staff = 100;

-- 確認用
-- select code, name, limit_hanbai, limit_salon, limit_kojin, limit_toritsugi, limit_staff
-- from agencies where code_kind = '00' order by code;
