import { createFlvWebSocketLoaderClass, FLV_LOADER_STATUS } from "./flvWebSocketLoader";
import type { MonitorState, MonitorWebSocketLike } from "./monitorClient";

class FakeWebSocket implements MonitorWebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
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

describe("createFlvWebSocketLoaderClass", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("open()でMonitorClient経由の接続を開始し、connecting状態になる", () => {
    const states: MonitorState[] = [];
    const LoaderClass = createFlvWebSocketLoaderClass({
      WebSocketCtor: FakeWebSocket,
      onMonitorStateChange: (s) => states.push(s),
    });
    const loader = new LoaderClass();

    loader.open({ url: "ws://relay.example/ws/monitor/token1" });

    expect(states).toEqual(["connecting"]);
    expect(loader.status).toBe(FLV_LOADER_STATUS.CONNECTING);
    expect(FakeWebSocket.instances[0].url).toBe("ws://relay.example/ws/monitor/token1");
  });

  it("受信データをonDataArrivalへbyteStart/receivedLengthを積算しながら転送する", () => {
    const LoaderClass = createFlvWebSocketLoaderClass({ WebSocketCtor: FakeWebSocket });
    const loader = new LoaderClass();
    const arrivals: Array<{ byteStart: number; receivedLength?: number; length: number }> = [];
    loader.onDataArrival = (chunk, byteStart, receivedLength) => {
      arrivals.push({ byteStart, receivedLength, length: chunk.byteLength });
    };

    loader.open({ url: "ws://relay.example/ws/monitor/token1" });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(new Uint8Array([1, 2, 3]));
    ws.simulateMessage(new Uint8Array([4, 5]));

    expect(arrivals).toEqual([
      { byteStart: 0, receivedLength: 3, length: 3 },
      { byteStart: 3, receivedLength: 5, length: 2 },
    ]);
    expect(loader.status).toBe(FLV_LOADER_STATUS.BUFFERING);
  });

  it("データ受信のたびにonDataReceivedが呼ばれる（遅延表示の算出用）", () => {
    const onDataReceived = jest.fn();
    const LoaderClass = createFlvWebSocketLoaderClass({
      WebSocketCtor: FakeWebSocket,
      onDataReceived,
    });
    const loader = new LoaderClass();
    loader.onDataArrival = () => {};

    loader.open({ url: "ws://relay.example/ws/monitor/token1" });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(new Uint8Array([1]));
    ws.simulateMessage(new Uint8Array([2]));

    expect(onDataReceived).toHaveBeenCalledTimes(2);
  });

  it("配信終了（ended）でCOMPLETE状態になりonCompleteが呼ばれる", () => {
    const LoaderClass = createFlvWebSocketLoaderClass({ WebSocketCtor: FakeWebSocket });
    const loader = new LoaderClass();
    const onComplete = jest.fn();
    loader.onComplete = onComplete;

    loader.open({ url: "ws://relay.example/ws/monitor/token1" });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose(1000);

    expect(loader.status).toBe(FLV_LOADER_STATUS.COMPLETE);
    expect(onComplete).toHaveBeenCalledWith(0, 0);
  });

  it("到達不能（unreachable）でERROR状態になりonErrorが呼ばれる", () => {
    const LoaderClass = createFlvWebSocketLoaderClass({ WebSocketCtor: FakeWebSocket });
    const loader = new LoaderClass();
    const onError = jest.fn();
    loader.onError = onError;

    loader.open({ url: "ws://relay.example/ws/monitor/invalid-token" });
    FakeWebSocket.instances[0].simulateClose(1008);

    expect(loader.status).toBe(FLV_LOADER_STATUS.ERROR);
    expect(onError).toHaveBeenCalledWith("Exception", expect.objectContaining({ code: 0 }));
  });

  it("abort()はMonitorClientの接続を切断する", () => {
    const LoaderClass = createFlvWebSocketLoaderClass({ WebSocketCtor: FakeWebSocket });
    const loader = new LoaderClass();

    loader.open({ url: "ws://relay.example/ws/monitor/token1" });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    const closeSpy = jest.spyOn(ws, "close");

    loader.abort();

    expect(closeSpy).toHaveBeenCalled();
  });

  it("isWorkingはCONNECTING/BUFFERING中のみtrueを返す", () => {
    const LoaderClass = createFlvWebSocketLoaderClass({ WebSocketCtor: FakeWebSocket });
    const loader = new LoaderClass();

    expect(loader.isWorking()).toBe(false);
    loader.open({ url: "ws://relay.example/ws/monitor/token1" });
    expect(loader.isWorking()).toBe(true);

    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose(1000);
    expect(loader.isWorking()).toBe(false);
  });
});
