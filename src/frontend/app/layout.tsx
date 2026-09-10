import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import Link from "next/link";
import { config as fontAwesomeConfig } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCommentDots, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import "./globals.css";
import styles from "./layout.module.css";

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

// 全デモアプリ共通のGA4プロパティ（demo-common-ui.md）。
const GA_MEASUREMENT_ID = "G-C04W1XKS16";

export const metadata: Metadata = {
  title: "Browser Live Bridge Demo",
  description: "ブラウザのタブを開くだけでライブ配信を体験できるデモ版展示物です。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <div className={styles.header}>
          <div className={styles.banner}>
            <FontAwesomeIcon icon={faTriangleExclamation} />
            これはデモ版です。データはサーバー再起動時にリセットされる場合があります。
          </div>
          <nav className={styles.nav}>
            <div className={styles.navInner}>
              <Link href="/" className={styles.brand}>
                ブラウザ配信デモ
              </Link>
              <a href="https://rictaworks.jp/#demos" className={styles.backLink}>
                ← デモ一覧へ
              </a>
            </div>
          </nav>
        </div>

        {children}

        <footer className={styles.footer}>
          <Link href="/legal" className={styles.footerLink}>
            利用規約・免責事項・連絡先
          </Link>
          <span className={styles.footerDivider}>|</span>
          <span>© 2026 Ricta Works</span>
        </footer>

        <a
          href="https://rictaworks.jp/"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.consultButton}
        >
          <FontAwesomeIcon icon={faCommentDots} />
          ご相談はこちら
        </a>

        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_MEASUREMENT_ID}');
          `}
        </Script>
      </body>
    </html>
  );
}
