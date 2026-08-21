-- 支払いまわりの安全装置（2026-08-21）

-- ─────────────────────────────────────────────
-- ① 報酬の行に「いつ状態が変わったか」を残す
--
-- rewards.updated_at が作成時刻のまま更新されず、
-- 未確定→取消のような変化がいつ起きたのか行から追えなかった。
-- 状態の変化は支払額に直結するので、更新のたびに時刻を刻む。
-- ─────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists rewards_touch_updated_at on public.rewards;
create trigger rewards_touch_updated_at
  before update on public.rewards
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- ② 株式会社Kimius のダミー口座を消す
--
-- RIM0002 の口座は 番号 00000000001・名義トヅカマサタカ と、
-- 法人名と別人の名義かつ実在しない番号のまま残っていた。
-- RIM0005 も銀行名・支店名が文字列「テスト」のダミー。
-- 4項目が埋まっていると支払済みの操作が通ってしまうため、
-- 正しい口座を本人に確認できるまで空にして、支払いの入口で止まるようにする。
-- （ポータル側にも口座番号の形のチェックを足したが、データも掃除しておく）
-- ─────────────────────────────────────────────

update public.agencies
   set bank_name = null,
       bank_branch = null,
       account_no = null,
       account_holder = null
 where code in ('RIM0002', 'RIM0005');

-- 実行後の確認用:
-- select code, name, bank_name, bank_branch, account_no, account_holder
--   from public.agencies where code in ('RIM0002','RIM0005');
