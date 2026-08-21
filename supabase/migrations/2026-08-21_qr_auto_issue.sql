-- 既存の代理店・スタッフにも、お客様へのご案内（QR1・QR2）を行き渡らせる
--
-- 2026-08-21 に、QR2 の「研修に合格」「本部が承認」という条件をやめた。
-- 新しく登録された分は、その場で QR1・QR2 が発行されて案内メールも飛ぶ。
-- ここでは、それより前に登録されて発行されていない分を揃える。
--
-- 対象から外すもの
--   ・取次パートナー（code_kind = '01'）… 個別のQRを出さない決まり
--   ・停止・解約
--   ・QRを停止している相手（qr2_rejected_note が「【QR停止】」で始まる）
--     … 止めたURLが戻ってしまうため、解除の操作からやり直す
--
-- ※ このSQLではメールは送られません。相手にお知らせするには、
--    代理店の詳細画面で「案内メールを送り直す」を押してください。

update agencies
set
  qr2_status = '承認済',
  qr1_url = coalesce(nullif(qr1_url, ''), 'https://lin.ee/nJTVC5A?ref=' || code),
  qr2_url = coalesce(
    nullif(qr2_url, ''),
    'https://line.metore0403.com/p/fXEUN6pjHMRW?ref=' || code
  )
where code_kind <> '01'
  and status <> '停止・解約'
  and coalesce(qr2_rejected_note, '') not like '【QR停止】%'
  and (
    qr2_status is distinct from '承認済'
    or nullif(qr1_url, '') is null
    or nullif(qr2_url, '') is null
  );

-- 確認用（実行後に流すと、行き渡ったかが分かります）
-- select code, name, qr2_status, qr1_url, qr2_url
-- from agencies
-- where code_kind <> '01' and status <> '停止・解約'
-- order by code;
