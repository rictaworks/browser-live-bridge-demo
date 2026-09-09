// モニター購読（requirements.md 10節・12.2節・16.4節）。
//
// ws(s)://<relay-host>/ws/monitor/:broadcast_token に接続すると、
// FLVタグ列のバイト列がそのまま流れてくる契約になっている
// （このモジュールでは中身を解釈せず、そのままonDataへ渡す。
// MSEへの投入・flv.js DataSourceとしての利用は呼び出し側＝モニター画面が担う）。
//
// 状態表示（12.2節）:
//   connecting  … 接続試行中
//   live        … 購読中（映像を受信できている）
//   ended       … 配信の終了に追随して終了した
//   unreachable … 無効なトークン・接続上限超過・接続失敗などで到達不能
//
// 遅延表示（12.2節）は「送出からの経過時間の目安」を示す要件だが、送信側・
// 受信側で共有できる実時計上の基準点を持たない設計（6.5節：メディアクロックは
// 実時計非依存）であるため、真の送出〜到達遅延を厳密には測定できない。
// ここでは簡易な目安として「直近データ受信からの経過時間」をlastReceivedAtMsで
// 公開し、呼び出し側（モニター画面）がこれを基に表示する（判断根拠として
// 報告に明記する簡略化）。

export type MonitorState = "connecting" | "live" | "ended" | "unreachable";

export interface MonitorWebSocketLike {
  readonly readyState: number;
  close(): void;
  set onopen(handler: (() => void) | null);
  set onclose(handler: ((event: { code: number; reason: string }) => void) | null);
  set onerror(handler: ((event: unknown) => void) | null);
  set onmessage(handler: ((event: { data: unknown }) => void) | null);
}

export type MonitorWebSocketCtor = new (url: string) => MonitorWebSocketLike;

export interface MonitorClientOptions {
  url: string;
  WebSocketCtor: MonitorWebSocketCtor;
  onData: (bytes: Uint8Array) => void;
  onStateChange?: (state: MonitorState) => void;
  onError?: (error: unknown) => void;
  nowMs?: () => number;
}

export class MonitorClient {
  private readonly options: MonitorClientOptions;
  private readonly nowMs: () => number;
  private ws: MonitorWebSocketLike | null = null;
  private state: MonitorState = "connecting";
  private everLive = false;
  private _lastReceivedAtMs: number | null = null;

  constructor(options: MonitorClientOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get currentState(): MonitorState {
    return this.state;
  }

  get lastReceivedAtMs(): number | null {
    return this._lastReceivedAtMs;
  }

  connect(): void {
    this.setState("connecting");
    const ws = new this.options.WebSocketCtor(this.options.url);
    this.ws = ws;
    ws.onopen = () => this.setState("live");
    ws.onclose = () => {
      this.setState(this.everLive ? "ended" : "unreachable");
    };
    ws.onerror = (event) => this.options.onError?.(event);
    ws.onmessage = (event) => this.handleMessage(event);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
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
      return;
    }
    this._lastReceivedAtMs = this.nowMs();
    this.options.onData(bytes);
  }

  private setState(state: MonitorState): void {
    if (state === "live") {
      this.everLive = true;
    }
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
