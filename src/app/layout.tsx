import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VIS 代理店ポータル",
  description: "眼筋トレーニングマシン VIS の代理店向け管理ポータル",
};

/*
 * 画面が描かれる前に、選ばれている配色を <html> に付ける。
 *
 * ここを React に任せると、いったん暗い配色で描かれてから明るい配色に
 * 切り替わり、読み込みのたびに画面が一瞬光る。それを避けるため、
 * 中身が届く前に動く素の JavaScript にしている。
 * 何も選んでいないときは、パソコン・スマホ側の設定に従う。
 */
const THEME_SCRIPT = `(function(){try{
var v=localStorage.getItem('vis-theme');
if(v!=='light'&&v!=='dark'){v=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
document.documentElement.setAttribute('data-theme',v);
document.documentElement.style.colorScheme=v;
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* 上のスクリプトが <html> に印を付けるので、サーバーとの差は出て当たり前 */
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
