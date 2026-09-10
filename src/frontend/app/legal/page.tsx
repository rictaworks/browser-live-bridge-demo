import Link from "next/link";
import type { Metadata } from "next";
import styles from "./legal.module.css";

export const metadata: Metadata = {
  title: "利用規約・免責事項・連絡先 | ブラウザ配信デモ",
};

export default function LegalPage() {
  return (
    <div className={styles.page}>
      <Link href="/" className={styles.backLink}>
        ← ブラウザ配信デモに戻る
      </Link>

      <h1 className={styles.title}>利用規約・免責事項・連絡先</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>利用規約</h2>
        <ul className={styles.list}>
          <li>本サービスはデモンストレーション目的のみで提供されます。商用利用・再配布は禁止します。</li>
          <li>サービスの内容は予告なく変更・停止する場合があります。</li>
          <li>配信データ（配信レコード・チャット・視聴ログ等）は毎日 JST 03:00 に自動削除されます。</li>
          <li>本サービスの利用に際し、本規約に同意したものとみなします。</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>免責事項</h2>
        <ul className={styles.list}>
          <li>本サービスはブラウザからの配信技術（画面共有・カメラ・マイクの合成配信）を体験させるためのデモであり、実際の配信サービスへの送出は行いません。</li>
          <li>本サービスの利用により生じた損害について、Ricta Works は一切の責任を負いません。</li>
          <li>サービスの可用性・正確性・継続性を保証しません。</li>
          <li>配信中の映像・音声は視聴用モニター画面のリンクを知る第三者が閲覧できる場合があります。公開してよい内容のみを配信してください。</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>連絡先</h2>
        <dl className={styles.contactList}>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>屋号</dt>
            <dd className={styles.contactValue}>Ricta Works</dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>住所</dt>
            <dd className={styles.contactValue}>〒190-0022 東京都立川市錦町1丁目4-20 TSCビル5階</dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>電話</dt>
            <dd className={styles.contactValue}>070-5148-0380</dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>メール</dt>
            <dd className={styles.contactValue}>
              <a href="mailto:info@rictaworks.jp">info@rictaworks.jp</a>
            </dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>Web</dt>
            <dd className={styles.contactValue}>
              <a href="https://rictaworks.jp" target="_blank" rel="noopener noreferrer">
                https://rictaworks.jp
              </a>
            </dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>X</dt>
            <dd className={styles.contactValue}>
              <a href="https://x.com/rictaworks" target="_blank" rel="noopener noreferrer">
                @rictaworks
              </a>
            </dd>
          </div>
          <div className={styles.contactRow}>
            <dt className={styles.contactLabel}>GitHub</dt>
            <dd className={styles.contactValue}>
              <a href="https://github.com/rictaworks" target="_blank" rel="noopener noreferrer">
                github.com/rictaworks
              </a>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
