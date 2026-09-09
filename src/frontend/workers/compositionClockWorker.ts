// 合成ループ駆動用のクロックWorker（requirements.md 6.3節）。
//
// タブが非アクティブ・最小化された状態でもタイマーがスロットリングされ
// にくいWeb Worker上でtickを生成し、メインスレッドへpostMessageで通知する。
// メインスレッド側はメッセージ受信（タイマーではない）をトリガに合成・
// エンコードを実行するため、rAFはもちろん、メインスレッドのタイマー
// スロットリングの影響も受けにくい構成になる。
//
// 実際の描画（Canvas 2D）・エンコード（WebCodecs）はメインスレッドで行う
// （lib/useBroadcastStudio.tsが受信側）。このファイル自体はごく薄い glue
// のため、jsdom上でのユニットテストは行わず、tick生成ロジック本体は
// lib/timeDrivenScheduler.ts（ユニットテスト済み）を利用することで
// 品質を担保する。

import { TimeDrivenScheduler } from "../lib/timeDrivenScheduler";

export type WorkerInboundMessage =
  | { type: "start"; intervalMs: number }
  | { type: "stop" };

export type WorkerOutboundMessage = { type: "tick" };

let scheduler: TimeDrivenScheduler | null = null;

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data;
  if (message.type === "start") {
    scheduler?.stop();
    scheduler = new TimeDrivenScheduler({
      intervalMs: message.intervalMs,
      onTick: () => {
        const outbound: WorkerOutboundMessage = { type: "tick" };
        (self as unknown as Worker).postMessage(outbound);
      },
    });
    scheduler.start();
  } else if (message.type === "stop") {
    scheduler?.stop();
    scheduler = null;
  }
};

export {};
