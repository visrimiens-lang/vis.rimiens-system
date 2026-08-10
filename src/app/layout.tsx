import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VIS 代理店ポータル",
  description: "眼筋トレーニングマシン VIS の代理店向け管理ポータル",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
