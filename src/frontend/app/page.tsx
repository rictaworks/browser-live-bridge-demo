import styles from "./page.module.css";

// 雛形段階のトップページです。ビジネスロジックは含みません。
export default function Home() {
  return (
    <main className={styles.main}>
      <h1>ブラウザ配信デモ（雛形）</h1>
      <p>
        配信スタジオ画面・モニター画面は今後のissueで実装します。
        稼働確認には <code>/api/health</code> をご利用ください。
      </p>
    </main>
  );
}
