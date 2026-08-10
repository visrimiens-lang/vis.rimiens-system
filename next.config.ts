import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // 本部の「資料の配布」でファイルをアップロードする。既定の 1MB のままだと
    // 数MB の販促PDFが送信段階で弾かれ、画面に理由が出せない。上限の 10MB に
    // 通信のぶんの余裕を足しておき、超過の案内はアプリ側の日本語メッセージで出す。
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
