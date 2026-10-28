-- 総販売代理店（株式会社Rimiens）の代理店コードを RIM → RIMI にそろえる（2026-10-29）
--
-- RIM は最初期に作った代理店で3文字のまま残っていた。会社のコードは英字4文字が決まり
-- （MENO・ASUE・ADPG …）なので、総販売代理店もそれに合わせる。
-- 本部画面で自社コード（org_code）と招待コード（invite_code）はすでに RIMI に変えてあり、
-- 配下のスタッフは RIMI0001・RIMI0002 として採番済み。残っているのが code そのものと、
-- それを写している各テーブルの列。
--
-- ■ 流す順番（必ず守る）
--   1. ZEROTH_CODE を RIMI にしたコード（src/lib/intake.ts）を本番に配備し、Ready を確認する
--   2. この SQL を Supabase の SQL Editor で丸ごと実行する（1つのトランザクション）
--   3. 流し終えたら最後の select で RIM が 0 件・RIMI の代理店が 1 件であることを目で確かめる
--
-- ■ 置き換えの方針
--   ・完全一致（= 'RIM'）だけを置き換える。RIM0001 のような「RIM で始まる別のコード」には触らない
--   ・URL（qr1_url / qr2_url）は末尾の ?ref=RIM だけを RIMI にする
--   ・inbox.payload（受け取った生データ）と audit_log.detail（当時の記録文）は書き換えない。
--     「当時は RIM だった」という事実をそのまま残す。受信箱から取り込み直しても、
--     コードの読み替え表（src/lib/code-alias.ts）が RIM を RIMI として扱う
--   ・途中でひとつでも想定と違えば raise exception で全部なかったことにする
--
-- ■ 元に戻すには
--   下の update を 'RIMI' → 'RIM' の向きに書き換えて流す（agencies.invite_code / org_code は
--   本部が手で RIMI にしたものなので戻さない）。コード側の ZEROTH_CODE も戻すこと。

begin;

-- 1. 事前確認（1件ちょうどの RIM があり、RIMI がまだ無いこと）
do $$
declare n integer;
begin
  select count(*) into n from public.agencies where code = 'RIM';
  if n <> 1 then
    raise exception 'agencies.code = RIM の行が % 件あります（1件のはず）。中止します', n;
  end if;
  select count(*) into n from public.agencies where code = 'RIMI';
  if n <> 0 then
    raise exception 'agencies.code = RIMI が既に % 件あります。中止します', n;
  end if;
end $$;

-- 2. 代理店マスタ
update public.agencies set code        = 'RIMI' where code        = 'RIM';
update public.agencies set parent_code = 'RIMI' where parent_code = 'RIM';
update public.agencies set zeroth_code = 'RIMI' where zeroth_code = 'RIM';
update public.agencies set invite_code = 'RIMI' where invite_code = 'RIM';
update public.agencies set org_code    = 'RIMI' where org_code    = 'RIM';
update public.agencies
   set qr1_url = regexp_replace(qr1_url, '([?&]ref=)RIM$', '\1RIMI')
 where qr1_url ~ '[?&]ref=RIM$';
update public.agencies
   set qr2_url = regexp_replace(qr2_url, '([?&]ref=)RIM$', '\1RIMI')
 where qr2_url ~ '[?&]ref=RIM$';

-- 3. 顧客・受注・報酬・紹介の控え・見込み客・デモ機・パスワード再発行
update public.customers set agency_code   = 'RIMI' where agency_code   = 'RIM';
update public.customers set referrer_code = 'RIMI' where referrer_code = 'RIM';
update public.customers set closer_code   = 'RIMI' where closer_code   = 'RIM';
update public.customers set staff_code    = 'RIMI' where staff_code    = 'RIM';

update public.orders set agency_code   = 'RIMI' where agency_code   = 'RIM';
update public.orders set staff_code    = 'RIMI' where staff_code    = 'RIM';
update public.orders set niji_code     = 'RIMI' where niji_code     = 'RIM';
update public.orders set zeroth_code   = 'RIMI' where zeroth_code   = 'RIM';
update public.orders set referrer_code = 'RIMI' where referrer_code = 'RIM';

update public.rewards set agency_code = 'RIMI' where agency_code = 'RIM';

update public.ref_claims set ref = 'RIMI' where ref = 'RIM';

update public.leads set referrer_code = 'RIMI' where referrer_code = 'RIM';

update public.demo_machines set holder_code = 'RIMI' where holder_code = 'RIM';

update public.portal_password_requests set agency_code = 'RIMI' where agency_code = 'RIM';

-- 4. 操作履歴の宛先（本部画面が target_key / actor で履歴を引くので、改名後も RIMI の画面に出るようにする）
update public.audit_log set target_key = 'RIMI' where target_type = 'agency' and target_key = 'RIM';
update public.audit_log set actor      = 'RIMI' where actor = 'RIM';

-- 5. 改名そのものを履歴に残す
insert into public.audit_log (actor, action, target_type, target_key, detail)
values (
  'HQ',
  '代理店コード変更',
  'agency',
  'RIMI',
  jsonb_build_object(
    '旧コード', 'RIM',
    '新コード', 'RIMI',
    '理由', '他の会社と同じ英字4文字にそろえる',
    '方法', 'supabase/migrations/2026-10-29_rename_rim_to_rimi.sql'
  )
);

-- 6. 事後確認（RIM が1件でも残っていれば全部取り消す）
do $$
declare n integer;
begin
  select
      (select count(*) from public.agencies
        where code = 'RIM' or parent_code = 'RIM' or zeroth_code = 'RIM'
           or invite_code = 'RIM' or org_code = 'RIM'
           or qr1_url ~ '[?&]ref=RIM$' or qr2_url ~ '[?&]ref=RIM$')
    + (select count(*) from public.customers
        where agency_code = 'RIM' or referrer_code = 'RIM' or closer_code = 'RIM' or staff_code = 'RIM')
    + (select count(*) from public.orders
        where agency_code = 'RIM' or staff_code = 'RIM' or niji_code = 'RIM'
           or zeroth_code = 'RIM' or referrer_code = 'RIM')
    + (select count(*) from public.rewards where agency_code = 'RIM')
    + (select count(*) from public.ref_claims where ref = 'RIM')
    + (select count(*) from public.leads where referrer_code = 'RIM')
    + (select count(*) from public.demo_machines where holder_code = 'RIM')
    + (select count(*) from public.portal_password_requests where agency_code = 'RIM')
    + (select count(*) from public.audit_log where (target_type = 'agency' and target_key = 'RIM') or actor = 'RIM')
  into n;
  if n <> 0 then
    raise exception 'RIM が % 件残っています。全部取り消します', n;
  end if;
  select count(*) into n from public.agencies where code = 'RIMI';
  if n <> 1 then
    raise exception 'agencies.code = RIMI が % 件です（1件のはず）。全部取り消します', n;
  end if;
end $$;

commit;

-- 7. 目で確かめる（期待値: 1行目が RIMI の会社、以降は 2026-10-29 時点の件数 15 / 34 / 5 / 5 / 13 / 10 / 24 / 7）
select code, name, rank, parent_code, zeroth_code, invite_code, org_code, qr1_url, qr2_url
  from public.agencies where code = 'RIMI';
select 'agencies.parent_code' as col, count(*) from public.agencies where parent_code = 'RIMI'
union all select 'agencies.zeroth_code', count(*) from public.agencies where zeroth_code = 'RIMI'
union all select 'customers.agency_code', count(*) from public.customers where agency_code = 'RIMI'
union all select 'orders.agency_code', count(*) from public.orders where agency_code = 'RIMI'
union all select 'orders.zeroth_code', count(*) from public.orders where zeroth_code = 'RIMI'
union all select 'rewards.agency_code', count(*) from public.rewards where agency_code = 'RIMI'
union all select 'ref_claims.ref', count(*) from public.ref_claims where ref = 'RIMI'
union all select 'audit_log.target_key', count(*) from public.audit_log where target_type = 'agency' and target_key = 'RIMI';
