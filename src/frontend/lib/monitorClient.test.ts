import { MonitorClient, type MonitorState, type MonitorWebSocketLike } from "./monitorClient";

class FakeWebSocket implements MonitorWebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer });
  }

  simulateClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "abnormal" });
  }
}

describe("MonitorClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("接続直後はconnecting状態で、open後はlive状態になる", () => {
    const states: MonitorState[] = [];
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/token1",
      WebSocketCtor: FakeWebSocket,
      onData: () => {},
      onStateChange: (s) => states.push(s),
    });

    client.connect();
    expect(states).toEqual(["connecting"]);

    FakeWebSocket.instances[0].simulateOpen();
    expect(states).toEqual(["connecting", "live"]);
  });

  it("受信したバイト列をそのままonDataへ転送する（FLVタグ列はそのままflv.js側へ）", () => {
    const onData = jest.fn();
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/token1",
      WebSocketCtor: FakeWebSocket,
      onData,
    });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    const bytes = new Uint8Array([0x46, 0x4c, 0x56]); // "FLV"の先頭バイトを模擬
    ws.simulateMessage(bytes);

    expect(onData).toHaveBeenCalledWith(bytes);
  });

  it("live状態に到達後の切断はended状態になる（配信終了への追随）", () => {
    const states: MonitorState[] = [];
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/token1",
      WebSocketCtor: FakeWebSocket,
      onData: () => {},
      onStateChange: (s) => states.push(s),
    });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose(1000);

    expect(states).toEqual(["connecting", "live", "ended"]);
  });

  it("一度もlive状態にならずに切断された場合はunreachable状態になる（無効なトークン・上限超過等）", () => {
    const states: MonitorState[] = [];
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/invalid-token",
      WebSocketCtor: FakeWebSocket,
      onData: () => {},
      onStateChange: (s) => states.push(s),
    });
    client.connect();
    FakeWebSocket.instances[0].simulateClose(1008); // ポリシー違反等を模擬

    expect(states).toEqual(["connecting", "unreachable"]);
  });

  it("lastReceivedAtMsはデータ受信のたびに更新される", () => {
    let now = 1000;
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/token1",
      WebSocketCtor: FakeWebSocket,
      onData: () => {},
      nowMs: () => now,
    });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    expect(client.lastReceivedAtMs).toBeNull();
    ws.simulateMessage(new Uint8Array([1]));
    expect(client.lastReceivedAtMs).toBe(1000);

    now = 2500;
    ws.simulateMessage(new Uint8Array([2]));
    expect(client.lastReceivedAtMs).toBe(2500);
  });

  it("disconnectはソケットを閉じる", () => {
    const client = new MonitorClient({
      url: "ws://relay.example/ws/monitor/token1",
      WebSocketCtor: FakeWebSocket,
      onData: () => {},
    });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    const closeSpy = jest.spyOn(ws, "close");

    client.disconnect();

    expect(closeSpy).toHaveBeenCalled();
  });
});
