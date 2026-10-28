-- 2026-10-29_rename_rim_to_rimi.sql の取り消し（RIMI → RIM に戻す）
--
-- migrations/ に置くと「流すべきもの」に見えるので、ここに分けてある。
-- 改名 SQL を流したあとに問題が出たときだけ、Supabase の SQL Editor で丸ごと実行する。
--
-- 戻さないもの:
--   ・agencies.invite_code / org_code の 'RIMI' … 本部が手で設定した正しい値
--   ・audit_log の「代理店コード変更」の行 … 消さずに「取り消し」を1行足して経緯を残す
--   ・inbox.payload / audit_log.detail … 元から触っていない
-- コード側（src/lib/code-alias.ts）は新旧どちらの綴りでも引けるので、DB だけ戻しても動く。
-- 恒久的に戻すなら ZEROTH_CODE を "RIM" に戻し、読み替え表から RIM を外す。

begin;

do $$
declare n integer;
begin
  select count(*) into n from public.agencies where code = 'RIMI';
  if n <> 1 then
    raise exception 'agencies.code = RIMI の行が % 件あります（1件のはず）。中止します', n;
  end if;
  select count(*) into n from public.agencies where code = 'RIM';
  if n <> 0 then
    raise exception 'agencies.code = RIM が既に % 件あります。中止します', n;
  end if;
end $$;

update public.agencies set code        = 'RIM' where code        = 'RIMI';
update public.agencies set parent_code = 'RIM' where parent_code = 'RIMI';
update public.agencies set zeroth_code = 'RIM' where zeroth_code = 'RIMI';
update public.agencies
   set qr1_url = regexp_replace(qr1_url, '([?&]ref=)RIMI$', '\1RIM')
 where qr1_url ~ '[?&]ref=RIMI$';
update public.agencies
   set qr2_url = regexp_replace(qr2_url, '([?&]ref=)RIMI$', '\1RIM')
 where qr2_url ~ '[?&]ref=RIMI$';

update public.customers set agency_code   = 'RIM' where agency_code   = 'RIMI';
update public.customers set referrer_code = 'RIM' where referrer_code = 'RIMI';
update public.customers set closer_code   = 'RIM' where closer_code   = 'RIMI';
update public.customers set staff_code    = 'RIM' where staff_code    = 'RIMI';

update public.orders set agency_code   = 'RIM' where agency_code   = 'RIMI';
update public.orders set staff_code    = 'RIM' where staff_code    = 'RIMI';
update public.orders set niji_code     = 'RIM' where niji_code     = 'RIMI';
update public.orders set zeroth_code   = 'RIM' where zeroth_code   = 'RIMI';
update public.orders set referrer_code = 'RIM' where referrer_code = 'RIMI';

update public.rewards set agency_code = 'RIM' where agency_code = 'RIMI';
update public.ref_claims set ref = 'RIM' where ref = 'RIMI';
update public.leads set referrer_code = 'RIM' where referrer_code = 'RIMI';
update public.demo_machines set holder_code = 'RIM' where holder_code = 'RIMI';
update public.portal_password_requests set agency_code = 'RIM' where agency_code = 'RIMI';

update public.audit_log set target_key = 'RIM' where target_type = 'agency' and target_key = 'RIMI';
update public.audit_log set actor      = 'RIM' where actor = 'RIMI';

insert into public.audit_log (actor, action, target_type, target_key, detail)
values ('HQ', '代理店コード変更の取り消し', 'agency', 'RIM',
        jsonb_build_object('戻した先', 'RIM', '戻す前', 'RIMI',
                           '方法', 'supabase/rollback/2026-10-29_rollback_rimi_to_rim.sql'));

do $$
declare n integer;
begin
  select
      (select count(*) from public.agencies
        where code = 'RIMI' or parent_code = 'RIMI' or zeroth_code = 'RIMI'
           or qr1_url ~ '[?&]ref=RIMI$' or qr2_url ~ '[?&]ref=RIMI$')
    + (select count(*) from public.orders
        where agency_code = 'RIMI' or zeroth_code = 'RIMI' or niji_code = 'RIMI')
    + (select count(*) from public.rewards where agency_code = 'RIMI')
    + (select count(*) from public.ref_claims where ref = 'RIMI')
  into n;
  if n <> 0 then
    raise exception 'RIMI が % 件残っています。全部取り消します', n;
  end if;
  select count(*) into n from public.agencies where code = 'RIM';
  if n <> 1 then
    raise exception 'agencies.code = RIM が % 件です（1件のはず）。全部取り消します', n;
  end if;
end $$;

commit;

select 'agencies.code = RIM（1 のはず）' as item, (select count(*) from public.agencies where code = 'RIM')::text as value
union all select 'RIM の qr2_url', coalesce((select qr2_url from public.agencies where code = 'RIM'), '');
