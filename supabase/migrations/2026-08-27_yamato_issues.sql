-- ヤマトB2クラウドで発行した送り状の控え
--
-- 2026-08-27、B2クラウドAPI（データ交換規約4.3版）の直結を実装した。
-- 本部が「送り状発行」を押すと、B2クラウドで伝票番号が採番され、
-- 受注（orders.tracking_no）へ自動で入る。ここにはその控えを残す。
--
-- PDFをここに置くのは、B2クラウド側のPDFに有効期限があり、
-- かつ取得にはそのときのセッションが要るため。発行の流れの中で
-- 取得して保存しておけば、あとからいつでも印刷し直せる。
-- 送り状PDFは1枚あたり数十KB程度なので、テキスト列（base64）で足りる。

create table if not exists public.yamato_issues (
  id           bigint generated always as identity primary key,
  issue_no     text not null,            -- B2クラウドの発行番号（例 TMIN0000001638）
  order_ids    jsonb not null,           -- この発行に含めた受注のid
  label_count  integer not null,         -- 発行した送り状の枚数
  pdf_base64   text,                     -- 送り状PDF（base64）。取得に失敗した場合は null
  -- 一覧で「控えがあるか」だけを知るための印。base64本体を毎回読むと重いため
  has_pdf      boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.yamato_issues enable row level security;

create index if not exists yamato_issues_created_at_idx
  on public.yamato_issues (created_at desc);
