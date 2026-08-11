import type { NextConfig } from "next";

/**
 * すべての応答に付ける安全のための指定。
 *
 * ・Content-Security-Policy … 万一この画面に外部の script を差し込まれても、
 *   自分のところ以外からは読み込ませない。Next.js は開発中に eval を、
 *   本番でもインラインの起動用 script を使うので、script-src はそこだけ許す。
 *   接続先は自分自身と Supabase に絞る（データの持ち出し先を限る）。
 * ・X-Frame-Options … 別のサイトの枠の中に、この画面を隠して重ねられるのを防ぐ
 *   （気づかないうちに承認ボタンを押させる手口への対策）。
 * ・X-Content-Type-Options … 送った種類と違うものとして解釈させない。
 * ・Referrer-Policy … 別のサイトへ移るとき、こちらのURL（代理店コードを含む）を渡さない。
 * ・Permissions-Policy … カメラ・マイク・位置情報は使わないので閉じておく。
 */
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // Next.js の起動用インライン script。開発中は差分更新のため eval も要る。
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // Tailwind はビルド時に CSS にするが、一部のスタイルはインラインで入る。
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 問い合わせ先は自分自身と保存先（Supabase）だけ。
  `connect-src 'self' https://*.supabase.co${isDev ? " ws: http://localhost:*" : ""}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  experimental: {
    // 本部の「資料の配布」でファイルをアップロードする。既定の 1MB のままだと
    // 数MB の販促PDFが送信段階で弾かれ、画面に理由が出せない。上限の 10MB に
    // 通信のぶんの余裕を足しておき、超過の案内はアプリ側の日本語メッセージで出す。
    serverActions: { bodySizeLimit: "12mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
