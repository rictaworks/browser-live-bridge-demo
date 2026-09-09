"use client";

// モニター画面（requirements.md 10節・12.2節）。
//
// 中継のws(s)://<relay-host>/ws/monitor/:broadcast_tokenからFLVタグ列が
// そのまま届く契約になっている。flv.jsのcustomLoader機構
// （lib/flvWebSocketLoader.ts）でMonitorClient（ユニットテスト済み）と
// flv.jsのMSE再生を橋渡しする。

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
// flv.jsのUMDバンドルはトップレベルで`self`を参照するため、Node.js上での
// SSR評価（"use client"コンポーネントもサーバーで一度評価される）で
// ReferenceErrorになる。そのためモジュール本体は型のみ静的importし、
// 実体はクライアント確定後（useEffect内）に動的importする。
import type FlvJsNamespace from "flv.js";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircle, faTriangleExclamation, faVideoSlash } from "@fortawesome/free-solid-svg-icons";
import styles from "./monitor.module.css";
import { createFlvWebSocketLoaderClass } from "@/lib/flvWebSocketLoader";
import type { MonitorState, MonitorWebSocketCtor } from "@/lib/monitorClient";

const RELAY_WS_URL = (process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:3002").replace(
  /^http/,
  "ws",
);

const STATE_LABELS: Record<MonitorState, string> = {
  connecting: "接続中です",
  live: "配信中です",
  ended: "配信が終了しました",
  unreachable: "この配信には到達できません",
};

function stateTone(state: MonitorState): "live" | "warn" | "error" | "neutral" {
  switch (state) {
    case "live":
      return "live";
    case "connecting":
      return "warn";
    case "unreachable":
      return "error";
    case "ended":
      return "neutral";
  }
}

function formatDelay(lastDataAtMs: number | null, nowMs: number): string {
  if (lastDataAtMs === null) {
    return "受信待ちです";
  }
  const seconds = Math.max(0, Math.round((nowMs - lastDataAtMs) / 1000));
  return `${seconds}秒前に受信しました`;
}

export default function MonitorPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastDataAtRef = useRef<number | null>(null);

  const [state, setState] = useState<MonitorState>("connecting");
  const [supported, setSupported] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    let player: FlvJsNamespace.Player | null = null;

    void (async () => {
      const { default: flvjs } = await import("flv.js");
      if (cancelled) {
        return;
      }
      if (!flvjs.isSupported()) {
        setSupported(false);
        return;
      }

      const LoaderClass = createFlvWebSocketLoaderClass({
        WebSocketCtor: WebSocket as unknown as MonitorWebSocketCtor,
        onMonitorStateChange: setState,
        onDataReceived: () => {
          lastDataAtRef.current = Date.now();
        },
      });

      const mediaDataSource: Parameters<typeof flvjs.createPlayer>[0] = {
        type: "flv",
        isLive: true,
        // urlはMediaDataSourceの必須項目だが、実際のI/Oは下記customLoader
        // （MonitorClient経由のWebSocket）が行うため参照はされない。
        url: `${RELAY_WS_URL}/ws/monitor/${token}`,
      };
      const config: Parameters<typeof flvjs.createPlayer>[1] = {
        isLive: true,
        customLoader: LoaderClass as unknown as NonNullable<
          Parameters<typeof flvjs.createPlayer>[1]
        >["customLoader"],
      };

      player = flvjs.createPlayer(mediaDataSource, config);
      if (videoRef.current) {
        player.attachMediaElement(videoRef.current);
      }
      player.load();
      void player.play()?.catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [token]);

  const delayLabel = formatDelay(lastDataAtRef.current, nowTick);

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>モニター</h1>
        <span className={styles.stateBadge} data-tone={stateTone(state)}>
          <FontAwesomeIcon icon={faCircle} className={styles.stateDot} />
          {STATE_LABELS[state]}
        </span>
      </div>

      {!supported && (
        <div className={styles.warningBanner} role="alert">
          <FontAwesomeIcon icon={faTriangleExclamation} />
          お使いのブラウザはこの再生方式に対応していません。
        </div>
      )}

      <div className={styles.playerWrap}>
        <video ref={videoRef} className={styles.player} controls muted playsInline />
        {state !== "live" && (
          <div className={styles.overlay}>
            <FontAwesomeIcon icon={faVideoSlash} size="2x" />
            <span>{STATE_LABELS[state]}</span>
          </div>
        )}
      </div>

      <p className={styles.delayNote}>{delayLabel}</p>
    </main>
  );
}
