import { decodeControlMessage, decodeFrame, encodeControlMessage } from "./frameProtocol";
import { TransportChannel, WS_OPEN, type WebSocketLike } from "./transportChannel";
import { DEFAULT_ENCODE_PROFILE } from "./types";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  simulateOpen(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  simulateServerClose(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  simulateMessage(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer });
  }
}

function resetInstances() {
  FakeWebSocket.instances = [];
}

describe("TransportChannel", () => {
  beforeEach(() => {
    resetInstances();
  });

  it("connect()するとWebSocketを開き、open時に開始通知（start）を送信する", () => {
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
    });

    channel.connect("session-1", "token-1", DEFAULT_ENCODE_PROFILE);
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    expect(ws.sent.length).toBe(1);
    const frame = decodeFrame(ws.sent[0]);
    const message = decodeControlMessage(frame);
    expect(message).toEqual({
      type: "start",
      sessionKey: "session-1",
      broadcastToken: "token-1",
      profile: DEFAULT_ENCODE_PROFILE,
    });
    expect(channel.isConnected).toBe(true);
  });

  it("受信した制御フレームはonControlへデコードして渡す（キーフレーム要求・抑制指示・致命通知）", () => {
    const onControl = jest.fn();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl,
    });
    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    ws.simulateMessage(encodeControlMessage({ type: "keyframe_request" }, 0));
    ws.simulateMessage(encodeControlMessage({ type: "throttle", targetBitrateKbps: 900 }, 0));
    ws.simulateMessage(encodeControlMessage({ type: "fatal", reason: "quota exceeded" }, 0));

    expect(onControl).toHaveBeenNthCalledWith(1, { type: "keyframe_request" });
    expect(onControl).toHaveBeenNthCalledWith(2, {
      type: "throttle",
      targetBitrateKbps: 900,
    });
    expect(onControl).toHaveBeenNthCalledWith(3, {
      type: "fatal",
      reason: "quota exceeded",
    });
  });

  it("接続断が起きると指数的な間隔で再接続を試み、成功するとonOpen(isReconnect=true)が呼ばれる", () => {
    jest.useFakeTimers();
    const onOpen = jest.fn();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
      onOpen,
      backoff: { baseMs: 100, factor: 2, maxMs: 1000, maxTotalMs: 60_000 },
    });

    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    FakeWebSocket.instances[0].simulateOpen();
    expect(onOpen).toHaveBeenNthCalledWith(1, false);

    FakeWebSocket.instances[0].simulateServerClose();
    expect(FakeWebSocket.instances.length).toBe(1); // まだ再接続していない

    jest.advanceTimersByTime(100); // 1回目のbackoff
    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.instances[1].simulateOpen();

    expect(onOpen).toHaveBeenNthCalledWith(2, true);
    jest.useRealTimers();
  });

  it("再接続間隔は指数的に増加し、上限（maxMs）を超えない", () => {
    jest.useFakeTimers();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
      backoff: { baseMs: 100, factor: 2, maxMs: 300, maxTotalMs: 60_000 },
    });

    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    FakeWebSocket.instances[0].simulateOpen();

    FakeWebSocket.instances[0].simulateServerClose(); // -> 待機100ms
    jest.advanceTimersByTime(99);
    expect(FakeWebSocket.instances.length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);

    FakeWebSocket.instances[1].simulateServerClose(); // -> 待機200ms
    jest.advanceTimersByTime(199);
    expect(FakeWebSocket.instances.length).toBe(2);
    jest.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);

    FakeWebSocket.instances[2].simulateServerClose(); // -> 待機400ms→上限300msにクランプ
    jest.advanceTimersByTime(299);
    expect(FakeWebSocket.instances.length).toBe(3);
    jest.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(4);

    jest.useRealTimers();
  });

  it("再接続の試行は規定時間（maxTotalMs）で打ち切り、onReconnectFailedを呼ぶ", () => {
    jest.useFakeTimers();
    const onReconnectFailed = jest.fn();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
      onReconnectFailed,
      backoff: { baseMs: 1000, factor: 1, maxMs: 1000, maxTotalMs: 1500 },
    });

    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    FakeWebSocket.instances[0].simulateOpen();
    FakeWebSocket.instances[0].simulateServerClose();

    jest.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].simulateServerClose();
    jest.advanceTimersByTime(1000);
    // ここまでで打ち切り時間(2500ms)を超過しているはず
    FakeWebSocket.instances[2]?.simulateServerClose();

    expect(onReconnectFailed).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("close()は終了通知を送信してから切断し、以後は自動再接続しない", () => {
    jest.useFakeTimers();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
    });
    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    channel.close("user_stopped");

    const lastSent = ws.sent[ws.sent.length - 1];
    const message = decodeControlMessage(decodeFrame(lastSent));
    expect(message).toEqual({ type: "end", reason: "user_stopped" });

    jest.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1); // 再接続していない
    jest.useRealTimers();
  });

  it("未接続時のsendChunkはfalseを返す（送信保留はSendQueue側の責務）", () => {
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
    });
    const ok = channel.sendChunk({
      type: "video",
      keyframe: true,
      timestampUs: 0,
      body: new Uint8Array(),
    });
    expect(ok).toBe(false);
  });

  it("reconnectNow()は待機を待たず即座に再接続を試みる", () => {
    jest.useFakeTimers();
    const channel = new TransportChannel({
      url: "ws://relay.example/ws/publish",
      WebSocketCtor: FakeWebSocket as never,
      onControl: () => {},
      backoff: { baseMs: 10_000 },
    });
    channel.connect("s", "t", DEFAULT_ENCODE_PROFILE);
    FakeWebSocket.instances[0].simulateOpen();
    FakeWebSocket.instances[0].simulateServerClose();

    channel.reconnectNow();

    expect(FakeWebSocket.instances.length).toBe(2);
    jest.useRealTimers();
  });
});
