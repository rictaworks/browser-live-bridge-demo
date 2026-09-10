import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>ブラウザ配信デモ</h1>
      <p className={styles.lead}>
        配信ソフト（OBS等）は不要です。ブラウザのタブを開くだけで、画面共有・カメラ・マイクを合成してライブ配信できることを体験できます。配信を開始すると、視聴用のモニター画面リンクが発行されます。
      </p>
      <Link href="/studio" className={styles.cta}>
        <FontAwesomeIcon icon={faPlay} />
        配信を始める
      </Link>
      <p className={styles.note}>
        稼働確認には <code>/api/health</code> をご利用ください。
      </p>
    </main>
  );
}
