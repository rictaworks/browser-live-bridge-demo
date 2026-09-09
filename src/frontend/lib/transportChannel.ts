// 転送チャネル（requirements.md 6.6節・8節）。
//
// - 送信側→中継: 開始通知（セッションキー・配信トークン・エンコードプロファイル）
// - 中継→送信側: 受領応答・キーフレーム要求・抑制指示・致命通知
// - 接続断からは指数バックオフで再接続する。上限間隔・打ち切り時間を設ける
// - 再接続後は（呼び出し側が）設定情報を再送し、キーフレームを発行する
//   （このクラスはソケットの開閉とフレーム送受信のみを担当し、
//   「何を再送するか」はBroadcastController側の責務とする）
//
// WebSocketは注入可能にし、ユニットテストでは実ブラウザに依存しないフェイク
// 実装に差し替える（モック境界）。

import {
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  type ControlMessage,
  type MediaFrame,
} from "./frameProtocol";
import type { EncodeProfile } from "./types";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  set onopen(handler: (() => void) | null);
  set onclose(handler: ((event: { code: number; reason: string }) => void) | null);
  set onerror(handler: ((event: unknown) => void) | null);
  set onmessage(handler: ((event: { data: unknown }) => void) | null);
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /** この時間(ms)を再接続の試行開始から超えたら打ち切る */
  maxTotalMs?: number;
}

export interface TransportChannelOptions {
  url: string;
  WebSocketCtor: WebSocketCtor;
  onControl: (message: ControlMessage) => void;
  /** ソケットが開いた（初回・再接続いずれも）たびに呼ばれる。 */
  onOpen?: (isReconnect: boolean) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onReconnectFailed?: () => void;
  onError?: (error: unknown) => void;
  backoff?: BackoffOptions;
  nowMs?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface StartInfo {
  sessionKey: string;
  broadcastToken: string;
  profile: EncodeProfile;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 500,
  factor: 2,
  maxMs: 30_000,
  maxTotalMs: 120_000,
};

export class TransportChannel {
  private readonly options: TransportChannelOptions;
  private readonly backoff: Required<BackoffOptions>;
  private readonly nowMs: () => number;
  private readonly setTimeoutFn: NonNullable<TransportChannelOptions["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<TransportChannelOptions["clearTimeoutFn"]>;

  private ws: WebSocketLike | null = null;
  private startInfo: StartInfo | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDisconnectAtMs: number | null = null;
  private manuallyClosed = false;
  private hasConnectedOnce = false;

  constructor(options: TransportChannelOptions) {
    this.options = options;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(sessionKey: string, broadcastToken: string, profile: EncodeProfile): void {
    this.startInfo = { sessionKey, broadcastToken, profile };
    this.manuallyClosed = false;
    this.reconnectAttempt = 0;
    this.firstDisconnectAtMs = null;
    this.openSocket();
  }

  private openSocket(): void {
    const ws = new this.options.WebSocketCtor(this.options.url);
    this.ws = ws;

    ws.onopen = () => this.handleOpen();
    ws.onclose = (event) => this.handleClose(event);
    ws.onerror = (event) => this.options.onError?.(event);
    ws.onmessage = (event) => this.handleMessage(event);
  }

  private handleOpen(): void {
    this.connected = true;
    const isReconnect = this.hasConnectedOnce;
    this.hasConnectedOnce = true;
    this.reconnectAttempt = 0;
    this.firstDisconnectAtMs = null;

    if (this.startInfo) {
      this.sendControl({
        type: "start",
        sessionKey: this.startInfo.sessionKey,
        broadcastToken: this.startInfo.broadcastToken,
        profile: this.startInfo.profile as unknown as Record<string, unknown>,
      });
    }

    this.options.onOpen?.(isReconnect);
  }

  private handleClose(event: { code: number; reason: string }): void {
    this.connected = false;
    this.options.onClose?.(event);

    if (this.manuallyClosed) {
      return;
    }
    this.scheduleReconnect();
  }

  private handleMessage(event: { data: unknown }): void {
    const raw = event.data;
    let bytes: Uint8Array | null = null;
    if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (raw instanceof Uint8Array) {
      bytes = raw;
    }
    if (!bytes) {
      return; // テキストフレーム等、想定外の型は無視する
    }

    try {
      const frame = decodeFrame(bytes);
      if (frame.type !== "control") {
        return;
      }
      const message = decodeControlMessage(frame);
      this.options.onControl(message);
    } catch {
      // 逸脱するフレームは破棄する（requirements.md 21節）
    }
  }

  private scheduleReconnect(): void {
    const now = this.nowMs();
    if (this.firstDisconnectAtMs === null) {
      this.firstDisconnectAtMs = now;
    }

    if (now - this.firstDisconnectAtMs >= this.backoff.maxTotalMs) {
      this.options.onReconnectFailed?.();
      return;
    }

    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * Math.pow(this.backoff.factor, this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** 利用者が明示的に配信の再開を選べる導線用（requirements.md 8節）。即時に再接続を試みる。 */
  reconnectNow(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openSocket();
  }

  sendChunk(frame: MediaFrame): boolean {
    if (!this.connected || !this.ws) {
      return false;
    }
    this.ws.send(encodeFrame(frame));
    return true;
  }

  sendControl(message: ControlMessage): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return false;
    }
    this.ws.send(encodeControlMessage(message, this.nowMs() * 1000));
    return true;
  }

  /** 終了通知を送ってから切断する。以後は自動再接続しない。 */
  close(reason: string): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connected) {
      this.sendControl({ type: "end", reason });
    }
    this.ws?.close();
    this.connected = false;
  }
}
