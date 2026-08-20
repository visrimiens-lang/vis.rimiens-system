-- 決済ページで読み取った紹介コードの控え
--
-- ■ なぜ要るか
--
-- 代理店のQRは https://line.metore0403.com/p/…?ref=MENO0001 の形で配る。
-- ところが UTAGE は、この ?ref= を決済の通知（Webhook）に載せてくれない。
-- 実際に届いた内容のキーは9個だけで ref が無く、そのため
-- 5〜8月の実受注7件は「誰の売上か」が空のまま入り、報酬が1円も立っていない。
--
-- 決済ページのカスタムJSは ?ref= を読めている（QRの停止判定に使っている）。
-- そこで、お客様がメールアドレスを入れた時点で「このメールアドレスの方は
-- このコードから来た」という控えをここに残しておき、
-- 決済の通知が届いたときに突き合わせて売上の付け先を決める。
--
-- ■ 控えは短命でよい
--
-- 決済はページを開いてから数分〜数十分で終わる。
-- 古い控えを拾うと、同じ方が別の代理店から買い直したときに前の付け先を
-- 引き継いでしまうので、突き合わせるのは直近のものだけにする。

create table if not exists public.ref_claims (
  id          bigint generated always as identity primary key,
  ref         text not null,                 -- QRに埋めた紹介コード（代理店・スタッフ・取次のいずれか）
  email       text,                          -- 決済ページで入力されたメールアドレス
  phone       text,                          -- 同 電話番号（数字だけにそろえて入れる）
  used_by     bigint,                        -- 突き合わせに使った受注の id
  created_at  timestamptz not null default now()
);

comment on table public.ref_claims is
  '決済ページのカスタムJSが記録する「このお客様はどのQRから来たか」の控え。受注の通知に ?ref= が載らないため、メールアドレス・電話番号で突き合わせて売上の付け先を決めるのに使う。';

create index if not exists ref_claims_email_idx on public.ref_claims (email, created_at desc);
create index if not exists ref_claims_phone_idx on public.ref_claims (phone, created_at desc);
