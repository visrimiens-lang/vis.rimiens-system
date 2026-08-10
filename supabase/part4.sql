-- ────────────────────────────────────────────
-- 全テーブルで RLS を有効化する。
-- ポリシーは作らない ＝ 公開キーからは一切読めない。
-- サーバー（秘密鍵）だけが読み書きする。
-- ────────────────────────────────────────────
alter table public.agencies      enable row level security;
alter table public.products      enable row level security;
alter table public.customers     enable row level security;
alter table public.orders        enable row level security;
alter table public.rewards       enable row level security;
alter table public.demo_machines enable row level security;
alter table public.leads         enable row level security;
alter table public.audit_log     enable row level security;
alter table public.inbox         enable row level security;

-- updated_at を自動で更新する
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['agencies','products','customers','orders','rewards','demo_machines','leads']
  loop
    execute format(
      'drop trigger if exists %I_touch on public.%I; '
      'create trigger %I_touch before update on public.%I '
      'for each row execute function public.touch_updated_at()',
      t, t, t, t);
  end loop;
end $$;
