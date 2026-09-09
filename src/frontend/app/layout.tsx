import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { config as fontAwesomeConfig } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import "./globals.css";

// Next.jsはCSSの挿入順序を制御するため、FontAwesomeの自動CSS挿入は無効化し、
// 上記のスタイルシートを明示的にインポートする（表示のちらつき防止）。
fontAwesomeConfig.autoAddCss = false;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Browser Live Bridge Demo",
  description: "ブラウザのタブを開くだけでライブ配信を体験できるデモ版展示物です。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
