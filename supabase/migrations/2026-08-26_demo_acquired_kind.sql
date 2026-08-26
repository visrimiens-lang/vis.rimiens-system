-- デモ機の「購入区分」に、いまのフォームの選択肢を通す
--
-- VISデモ機登録フォーム（261833737598069）の購入区分は
--   ・スターターセットとして購入
--   ・個人購入製品をデモ機として登録
-- の2つ。ところが列の制約は kintone 時代の3つ
--   （個人購入・デモ機購入・無料貸与）のままだった。
--
-- そのため申込が届いても保存できず、受信箱に
--   new row for relation "demo_machines" violates check constraint
--   "demo_machines_acquired_kind_check"
-- として溜まっていた（2026-08-26 に発覚）。
--
-- 言い換えて古い3つに寄せる手もあるが、申込者が実際に選んだ言葉を
-- そのまま台帳に残したいので、制約のほうを広げる。

alter table public.demo_machines
  drop constraint if exists demo_machines_acquired_kind_check;

alter table public.demo_machines
  add constraint demo_machines_acquired_kind_check
  check (
    acquired_kind is null
    or acquired_kind in (
      '個人購入',
      'デモ機購入',
      '無料貸与',
      'スターターセットとして購入',
      '個人購入製品をデモ機として登録'
    )
  );
