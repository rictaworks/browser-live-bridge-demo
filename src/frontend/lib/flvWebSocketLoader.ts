// flv.jsのカスタムローダー実装（requirements.md 10節・12.2節）。
//
// 中継からのFLVタグ列はWebSocket（ws(s)://<relay-host>/ws/monitor/:broadcast_token）
// でそのまま届く契約になっている。flv.jsの標準ローダーはHTTP(S)前提のため、
// flv.jsのMediaDataSource.customLoader差し替え機構（BaseLoaderインターフェース）
// を使い、実際のWebSocket接続・状態管理はユニットテスト済みのMonitorClientへ
// 委譲する。このアダプタはflv.js⇔MonitorClientの薄い橋渡し層に留める。

import { MonitorClient, type MonitorState, type MonitorWebSocketCtor } from "./monitorClient";

/** flv.js BaseLoaderが要求する最小限のインターフェース（flv.js/d.ts/flv.d.ts準拠）。 */
export interface FlvBaseLoaderLike {
  readonly type: string;
  readonly status: number;
  readonly needStashBuffer: boolean;
  onContentLengthKnown: ((contentLength: number) => void) | null;
  onURLRedirect: ((redirectedURL: string) => void) | null;
  onDataArrival: ((chunk: ArrayBuffer, byteStart: number, receivedLength?: number) => void) | null;
  onError: ((errorType: string, errorInfo: { code: number; msg: string }) => void) | null;
  onComplete: ((rangeFrom: number, rangeTo: number) => void) | null;
  destroy(): void;
  isWorking(): boolean;
  open(dataSource: { url: string }, range?: { from: number; to: number }): void;
  abort(): void;
}

/** flv.jsのLoaderStatus定数と対応する値（flv.js側との整合のため同じ値を用いる）。 */
export const FLV_LOADER_STATUS = {
  IDLE: 0,
  CONNECTING: 1,
  BUFFERING: 2,
  ERROR: 3,
  COMPLETE: 4,
} as const;

export interface FlvWebSocketLoaderOptions {
  WebSocketCtor: MonitorWebSocketCtor;
  /** MonitorClientの状態（connecting/live/ended/unreachable）をモニター画面のUIへ伝える。 */
  onMonitorStateChange?: (state: MonitorState) => void;
  /** データを受信するたびに呼ばれる（12.2節の遅延表示＝直近受信からの経過時間の算出用）。 */
  onDataReceived?: () => void;
}

/**
 * flv.jsのMediaDataSource.customLoaderへ渡すためのローダークラスを生成する。
 * flv.jsはCustomLoaderConstructor（`new (seekHandler, config) => BaseLoader`）を
 * 要求するため、options（実WebSocketコンストラクタ等）をクロージャで束縛した
 * クラスをファクトリ経由で返す。
 */
export function createFlvWebSocketLoaderClass(
  options: FlvWebSocketLoaderOptions,
): new () => FlvBaseLoaderLike {
  return class FlvWebSocketLoader implements FlvBaseLoaderLike {
    readonly type = "browser-live-bridge-ws-flv-loader";
    private _status: number = FLV_LOADER_STATUS.IDLE;
    private receivedLength = 0;
    private monitorClient: MonitorClient | null = null;

    onContentLengthKnown: ((contentLength: number) => void) | null = null;
    onURLRedirect: ((redirectedURL: string) => void) | null = null;
    onDataArrival: ((chunk: ArrayBuffer, byteStart: number, receivedLength?: number) => void) | null =
      null;
    onError: ((errorType: string, errorInfo: { code: number; msg: string }) => void) | null = null;
    onComplete: ((rangeFrom: number, rangeTo: number) => void) | null = null;

    get status(): number {
      return this._status;
    }

    get needStashBuffer(): boolean {
      // FLVタグ境界を跨いだ細切れ配信でもflv.jsのデマルチプレクサが安定して
      // 処理できるよう、flv.js側でのバッファリングを有効にする。
      return true;
    }

    isWorking(): boolean {
      return this._status === FLV_LOADER_STATUS.CONNECTING || this._status === FLV_LOADER_STATUS.BUFFERING;
    }

    destroy(): void {
      this.abort();
    }

    open(dataSource: { url: string }): void {
      this._status = FLV_LOADER_STATUS.CONNECTING;
      this.monitorClient = new MonitorClient({
        url: dataSource.url,
        WebSocketCtor: options.WebSocketCtor,
        onData: (bytes) => {
          this._status = FLV_LOADER_STATUS.BUFFERING;
          options.onDataReceived?.();
          const byteStart = this.receivedLength;
          this.receivedLength += bytes.byteLength;
          const chunk = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          this.onDataArrival?.(chunk, byteStart, this.receivedLength);
        },
        onStateChange: (state) => {
          options.onMonitorStateChange?.(state);
          if (state === "ended") {
            this._status = FLV_LOADER_STATUS.COMPLETE;
            this.onComplete?.(0, this.receivedLength);
          } else if (state === "unreachable") {
            this._status = FLV_LOADER_STATUS.ERROR;
            this.onError?.("Exception", { code: 0, msg: "モニターに到達できません" });
          }
        },
      });
      this.monitorClient.connect();
    }

    abort(): void {
      this.monitorClient?.disconnect();
      this.monitorClient = null;
    }
  };
}
