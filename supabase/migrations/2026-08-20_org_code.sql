-- 自社代理店コード（組織の英字）を持たせる
--
-- 2026-08-20 の打合せで、代理店コードの決め方が変わった。
--
--   これまで … 上位代理店のコードから英字を引き継ぐ（RIM0003 の配下は RIM01xx）
--   これから … 申込者が自分で決めた半角大文字4文字が、その会社の組織になる
--              （目のトレーニング株式会社 → MENO、コンバス → COMV、アスペクト → ASUE）
--
-- 会社はその英字がそのまま代理店コードになり（RIM・MET と同じ形）、
-- スタッフ・取次パートナー・個人販売代理店は「英字＋4桁の通し番号」で採番する。
-- 区分（会社00・取次パートナー01・スタッフ02）はコードの文字から外し、
-- これまでどおり code_kind 列だけで持つ。

alter table public.agencies
  add column if not exists org_code text;

comment on column public.agencies.org_code is
  'その代理店が属する組織の英字（自社代理店コード）。会社は自分自身、配下はその会社の英字。採番はこの列で数える。';

-- 採番は org_code で数えるので、引きやすくしておく
create index if not exists agencies_org_code_idx
  on public.agencies (org_code);

-- 既存17件を埋める
--
-- いまのコードは「英字＋数字」なので、頭の英字がそのまま組織になる。
-- RIM 系 → RIM ／ MET 系 → MET ／ TEST01・TEST02 → TEST
update public.agencies
   set org_code = upper((regexp_match(code, '^[A-Za-z]+'))[1])
 where org_code is null
   and code ~ '^[A-Za-z]+';

-- ゼロ次（総販売代理店）が空のままの行を埋める
--
-- これまでは空のときコードの頭の英字で補っていた。RIM しか組織が無いうちは
-- それで正しく RIM を指していたが、会社ごとに英字が変わるとその補完が
-- 実在しない代理店（COMV など）を指してしまい、総販売代理店への 77,000 円が
-- エラーも出ないまま計上されなくなる。先に実体を入れておく。
update public.agencies
   set zeroth_code = 'RIM'
 where (zeroth_code is null or zeroth_code = '')
   and code <> 'RIM';

-- スタッフの販路種別を「未設定」に戻す
--
-- スタッフ（区分02）が販路種別「販売代理店」で登録されていると、
-- 支払額の欄が3次代理店の既定（1台あたり5万円）を表示してしまう。
-- スタッフが売った売上は所属先の会社に付き、本人への支払いは発生しないため、
-- 画面にだけ支払額が出ている状態だった。
update public.agencies
   set channel = '未設定'
 where code_kind = '02'
   and channel = '販売代理店';
