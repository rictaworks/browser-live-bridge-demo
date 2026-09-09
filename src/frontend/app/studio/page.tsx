"use client";

// 配信スタジオ画面（requirements.md 12.1節）。
//
// 実際のブラウザ配線（getDisplayMedia/WebCodecs/WebSocket等）はuseBroadcastStudio
// （このディレクトリのuseBroadcastStudio.ts）が担う。このコンポーネントは
// その状態を画面へ描画する表示層に徹する。

import { useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircle,
  faCopy,
  faDesktop,
  faMicrophone,
  faPaperPlane,
  faPlay,
  faStop,
  faTriangleExclamation,
  faTv,
  faVideo,
  faVolumeHigh,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./studio.module.css";
import { useBroadcastStudio, type SourceStatus } from "./useBroadcastStudio";
import type { BroadcastState, EventType, SourceKind } from "@/lib/types";

const CONTROLLABLE_SOURCE_KINDS: SourceKind[] = ["screen", "camera", "mic", "tab_audio"];

const SOURCE_LABELS: Record<SourceKind, string> = {
  screen: "画面共有",
  camera: "カメラ",
  mic: "マイク",
  tab_audio: "タブ音声",
  test: "テストカード",
};

const SOURCE_ICONS: Record<SourceKind, typeof faDesktop> = {
  screen: faDesktop,
  camera: faVideo,
  mic: faMicrophone,
  tab_audio: faVolumeHigh,
  test: faTv,
};

const SOURCE_STATE_LABELS: Record<SourceStatus["state"], string> = {
  idle: "未取得",
  detached: "未取得",
  requesting: "取得中です",
  active: "取得済みです",
  denied: "許可されませんでした",
  lost: "喪失しました",
  substituted: "代替中です",
};

function sourceStateTone(state: SourceStatus["state"]): "active" | "idle" | "warn" | "error" {
  if (state === "active") return "active";
  if (state === "denied" || state === "lost") return "error";
  if (state === "requesting" || state === "substituted") return "warn";
  return "idle";
}

const BROADCAST_STATE_LABELS: Record<BroadcastState, string> = {
  idle: "未開始",
  preparing: "準備中です",
  ready: "準備が完了しました",
  connecting: "接続中です",
  live: "配信中です",
  degraded: "配信品質が劣化しています",
  reconnecting: "再接続中です",
  stopping: "停止処理中です",
  failed: "配信に失敗しました",
  ended: "配信を終了しました",
};

function broadcastStateTone(state: BroadcastState): "live" | "warn" | "error" | undefined {
  if (state === "live") return "live";
  if (state === "degraded" || state === "reconnecting" || state === "connecting" || state === "preparing") {
    return "warn";
  }
  if (state === "failed") return "error";
  return undefined;
}

const LAYOUT_PRESETS: Array<{ value: string; label: string }> = [
  { value: "screen_with_camera_wipe", label: "画面共有 + カメラワイプ" },
  { value: "screen_only", label: "画面共有のみ" },
  { value: "camera_only", label: "カメラのみ" },
];

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  source_attached: "ソースを取得しました",
  source_lost: "ソースを喪失しました",
  source_substituted: "ソースを代替しました",
  source_detached: "ソースを解除しました",
  broadcast_started: "配信を開始しました",
  broadcast_stopped: "配信を停止しました",
  broadcast_failed: "配信に失敗しました",
  degraded: "配信品質が劣化しました",
  recovered: "配信品質が回復しました",
  reconnecting: "再接続を試みています",
  reconnected: "再接続しました",
  reconnect_failed: "再接続に失敗しました",
  throttled: "送出を抑制しました",
  keyframe_requested: "キーフレームを再送しました",
  gap_filled: "映像の空白を補いました",
  lock_lost: "配信ロックが失われました",
  duplicate_broadcast_blocked: "重複配信をブロックしました",
  chat_posted: "コメントを投稿しました",
};

function formatEventType(type: EventType): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

export default function StudioPage() {
  const studio = useBroadcastStudio();
  const [title, setTitle] = useState("");
  const [layoutPreset, setLayoutPreset] = useState(LAYOUT_PRESETS[0].value);
  const [chatDraft, setChatDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // ハニーポット欄（requirements.md 21節）。人間の利用者には見えない位置に置き、
  // 空のまま送信されることを期待する。フォームを機械的に全項目埋めて送信する
  // 単純なボットのみを検知する対策であり、reCAPTCHAは使用しない。
  const [hpField, setHpField] = useState("");

  const canStart = studio.capabilities.ok && studio.broadcastState === "idle";
  const canStop = !["idle", "stopping", "ended", "failed"].includes(studio.broadcastState);

  const monitorUrl = useMemo(() => {
    if (!studio.broadcastToken || typeof window === "undefined") {
      return null;
    }
    return `${window.location.origin}/monitor/${studio.broadcastToken}`;
  }, [studio.broadcastToken]);

  const handleStart = async () => {
    await studio.start({ title: title.trim() || undefined, layoutPreset, hpField });
  };

  const handleStop = async () => {
    await studio.stop("user_stopped");
  };

  const handleCopyMonitorUrl = async () => {
    if (!monitorUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(monitorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // クリップボードAPI非対応環境では複製操作を諦める（デモ版のUXとして許容）。
      // ネイティブダイアログ（alert等）は使用しない方針のため、通知は表示しない。
    }
  };

  const handleChatSubmit = async (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    const body = chatDraft.trim();
    if (!body) {
      return;
    }
    setChatDraft("");
    await studio.postChat(body);
  };

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>配信スタジオ</h1>
        <span className={styles.stateBadge} data-tone={broadcastStateTone(studio.broadcastState)}>
          <FontAwesomeIcon icon={faCircle} className={styles.stateDot} />
          {BROADCAST_STATE_LABELS[studio.broadcastState]}
        </span>
      </div>

      {!studio.capabilities.ok && (
        <div className={styles.warningBanner} role="alert">
          <FontAwesomeIcon icon={faTriangleExclamation} />
          <div>
            <div>このブラウザでは配信を開始できません。</div>
            <ul>
              {studio.capabilities.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className={styles.grid}>
        <div className={styles.column}>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>プレビュー</h2>
            <div className={styles.previewWrap}>
              <canvas ref={studio.canvasRef} width={1280} height={720} className={styles.previewCanvas} />
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>配信制御</h2>
            <div className={styles.controlsRow}>
              <label className={styles.field}>
                タイトル（任意）
                <input
                  type="text"
                  value={title}
                  onChange={(evt) => setTitle(evt.target.value)}
                  disabled={studio.broadcastState !== "idle"}
                  placeholder="配信タイトルを入力します"
                />
              </label>
              <label className={styles.field}>
                レイアウト
                <select
                  value={layoutPreset}
                  onChange={(evt) => setLayoutPreset(evt.target.value)}
                  disabled={studio.broadcastState !== "idle"}
                >
                  {LAYOUT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* ハニーポット欄（requirements.md 21節）。画面上には表示されず、
                  スクリーンリーダーからも隠される。人間の利用者は入力できないため
                  常に空のまま送信される。 */}
              <label className={styles.honeypot} aria-hidden="true">
                この項目は入力しないでください
                <input
                  type="text"
                  name="hp_field"
                  tabIndex={-1}
                  autoComplete="off"
                  value={hpField}
                  onChange={(evt) => setHpField(evt.target.value)}
                />
              </label>
            </div>
            <div className={styles.controlsRow}>
              <button type="button" className={styles.buttonPrimary} onClick={handleStart} disabled={!canStart}>
                <FontAwesomeIcon icon={faPlay} />
                配信を開始します
              </button>
              <button type="button" className={styles.buttonDanger} onClick={handleStop} disabled={!canStop}>
                <FontAwesomeIcon icon={faStop} />
                配信を停止します
              </button>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>ソース制御</h2>
            <div className={styles.sourceList}>
              {CONTROLLABLE_SOURCE_KINDS.map((kind) => {
                const state = studio.sources[kind];
                const isActive = state === "active";
                return (
                  <div className={styles.sourceRow} key={kind}>
                    <span className={styles.sourceLabel}>
                      <FontAwesomeIcon icon={SOURCE_ICONS[kind]} />
                      {SOURCE_LABELS[kind]}
                    </span>
                    <span className={styles.sourceStatus}>
                      <FontAwesomeIcon
                        icon={faCircle}
                        className={styles.stateDot}
                        data-tone={sourceStateTone(state)}
                      />
                      {SOURCE_STATE_LABELS[state]}
                      {kind === "tab_audio" ? (
                        isActive ? (
                          <button
                            type="button"
                            className={styles.button}
                            onClick={() => studio.detachSource(kind)}
                          >
                            <FontAwesomeIcon icon={faXmark} />
                            利用停止
                          </button>
                        ) : (
                          <span className={styles.emptyNote}>画面共有と同時に自動取得されます</span>
                        )
                      ) : isActive ? (
                        <button type="button" className={styles.button} onClick={() => studio.detachSource(kind)}>
                          <FontAwesomeIcon icon={faXmark} />
                          解除
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => studio.attachSource(kind)}
                          disabled={state === "requesting"}
                        >
                          取得
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className={styles.emptyNote}>
              画面共有・カメラのいずれも取得できない場合は、常時利用可能なテストカードが自動的に主映像として表示されます。
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>健全性</h2>
            <div className={styles.healthGrid}>
              <div className={styles.healthItem}>
                <span className={styles.healthLabel}>送出ビットレート</span>
                <span className={styles.healthValue}>{studio.health.sentBitrateKbps.toFixed(0)} kbps</span>
              </div>
              <div className={styles.healthItem}>
                <span className={styles.healthLabel}>目標ビットレート</span>
                <span className={styles.healthValue}>{studio.health.targetBitrateKbps.toFixed(0)} kbps</span>
              </div>
              <div className={styles.healthItem}>
                <span className={styles.healthLabel}>滞留時間</span>
                <span className={styles.healthValue}>{studio.health.queueDelayMs.toFixed(0)} ms</span>
              </div>
              <div className={styles.healthItem}>
                <span className={styles.healthLabel}>破棄フレーム数</span>
                <span className={styles.healthValue}>{studio.health.droppedFrames}</span>
              </div>
              <div className={styles.healthItem}>
                <span className={styles.healthLabel}>接続状態</span>
                <span className={styles.healthValue}>{studio.health.connected ? "接続中" : "未接続"}</span>
              </div>
            </div>
          </section>
        </div>

        <div className={styles.column}>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>視聴情報</h2>
            <div className={styles.audienceRow}>
              <span className={styles.viewerCount}>{studio.audience.viewerCount} 人が視聴中です</span>
            </div>
            <p className={styles.simulatedNote}>視聴者数は擬似生成された値です。</p>
            {monitorUrl && (
              <div className={styles.monitorUrlRow}>
                <input type="text" value={monitorUrl} readOnly />
                <button type="button" className={styles.button} onClick={handleCopyMonitorUrl}>
                  <FontAwesomeIcon icon={faCopy} />
                  複製
                </button>
              </div>
            )}
            {copied && <span className={styles.copiedNote}>モニターURLをコピーしました。</span>}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>チャット</h2>
            <p className={styles.simulatedNote}>擬似生成されたチャットです。配信者の投稿は区別して表示されます。</p>
            <div className={styles.chatList}>
              {studio.audience.messages.length === 0 && <p className={styles.emptyNote}>まだ投稿がありません。</p>}
              {studio.audience.messages.map((message) => (
                <div className={styles.chatMessage} key={message.id} data-origin={message.origin}>
                  <span className={styles.chatAuthor}>{message.authorLabel}</span>
                  <span>{message.body}</span>
                </div>
              ))}
            </div>
            <form className={styles.chatForm} onSubmit={handleChatSubmit}>
              <input
                type="text"
                value={chatDraft}
                onChange={(evt) => setChatDraft(evt.target.value)}
                placeholder="コメントを入力します"
                disabled={!studio.broadcastId}
              />
              <button type="submit" className={styles.button} disabled={!studio.broadcastId || !chatDraft.trim()}>
                <FontAwesomeIcon icon={faPaperPlane} />
                送信
              </button>
            </form>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>イベントログ</h2>
            <div className={styles.eventLog}>
              {studio.events.length === 0 && <p className={styles.emptyNote}>イベントはまだありません。</p>}
              {studio.events.map((event, index) => (
                <div className={styles.eventRow} key={`${event.occurredAt}-${index}`}>
                  <span className={styles.eventTime}>
                    {new Date(event.occurredAt).toLocaleTimeString("ja-JP")}
                  </span>
                  <span>
                    {formatEventType(event.type)}
                    {event.detail ? `：${event.detail}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
