import { BroadcastApiError } from "./broadcastApiClient";
import { BroadcastController } from "./broadcastController";
import { DEFAULT_ENCODE_PROFILE, type BroadcastState } from "./types";

interface IntervalEntry {
  handler: () => void;
  ms: number;
  id: number;
}

function makeTimerSpies() {
  const entries: IntervalEntry[] = [];
  let nextId = 1;
  const cleared: number[] = [];
  const setIntervalFn = jest.fn((handler: () => void, ms: number) => {
    const id = nextId++;
    entries.push({ handler, ms, id });
    return id as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalFn = jest.fn((handle: unknown) => {
    cleared.push(handle as number);
  });
  return { entries, setIntervalFn, clearIntervalFn, cleared };
}

function makeDeps(overrides: Partial<{ acquireResult: boolean }> = {}) {
  const apiClient = {
    createBroadcast: jest.fn().mockResolvedValue({
      id: "b1",
      broadcastToken: "token-1",
      state: "preparing",
      title: null,
      layoutPreset: "standard",
      startedAt: null,
      // backendが発行する実セッションキー。コンストラクタ引数のsessionKey（初期値）とは
      // 別物であることをテストで明確にするため、意図的に異なる値にしている。
      sessionKey: "backend-issued-session-key",
    }),
    stopBroadcast: jest.fn().mockResolvedValue(undefined),
    lockHeartbeat: jest.fn().mockResolvedValue(undefined),
  };
  const tabLockGuard = {
    acquire: jest.fn().mockResolvedValue(overrides.acquireResult ?? true),
    heartbeat: jest.fn(),
    release: jest.fn(),
  };
  const transport = {
    connect: jest.fn(),
    close: jest.fn(),
    sendControl: jest.fn(),
    reconnectNow: jest.fn(),
  };
  const sendQueue = {
    queueDelayMs: jest.fn().mockReturnValue(0),
    dropNonKeyVideo: jest.fn().mockReturnValue(0),
  };
  const governor = {
    evaluate: jest.fn().mockReturnValue(2500),
    applyThrottle: jest.fn(),
    target: 2500,
  };
  return { apiClient, tabLockGuard, transport, sendQueue, governor };
}

function makeController(
  deps: ReturnType<typeof makeDeps>,
  timers: ReturnType<typeof makeTimerSpies>,
  extra: Partial<ConstructorParameters<typeof BroadcastController>[0]> = {},
) {
  const states: BroadcastState[] = [];
  const events: string[] = [];
  const controller = new BroadcastController({
    sessionKey: "session-1",
    apiClient: deps.apiClient,
    tabLockGuard: deps.tabLockGuard,
    transport: deps.transport,
    sendQueue: deps.sendQueue,
    governor: deps.governor,
    onStateChange: (s) => states.push(s),
    onEvent: (e) => events.push(e.type),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    ...extra,
  });
  return { controller, states, events };
}

describe("BroadcastController", () => {
  it("正常系: start()はロック取得→配信作成→接続の順に進み、connecting状態まで遷移する", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, states, events } = makeController(deps, timers);

    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    expect(deps.tabLockGuard.acquire).toHaveBeenCalled();
    expect(deps.apiClient.createBroadcast).toHaveBeenCalledWith({
      title: undefined,
      layoutPreset: "standard",
    });
    // 接続にはoptions.sessionKey（初期値）ではなく、配信作成レスポンスの
    // sessionKey（backend発行の実セッションキー）を使う。
    expect(deps.transport.connect).toHaveBeenCalledWith(
      "backend-issued-session-key",
      "token-1",
      DEFAULT_ENCODE_PROFILE,
    );
    expect(states).toEqual(["preparing", "ready", "connecting"]);
    expect(events).toEqual(["broadcast_started"]);
    expect(controller.state).toBe("connecting");
  });

  it("タブロック取得に失敗した場合、配信作成を行わずidleへ戻る", async () => {
    const deps = makeDeps({ acquireResult: false });
    const timers = makeTimerSpies();
    const { controller, states, events } = makeController(deps, timers);

    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    expect(deps.apiClient.createBroadcast).not.toHaveBeenCalled();
    expect(events).toEqual(["duplicate_broadcast_blocked"]);
    expect(states).toEqual(["preparing", "idle"]);
    expect(controller.state).toBe("idle");
  });

  it("配信ロック取得失敗（409）の場合、タブロックを解放しfailed→endedへ遷移する", async () => {
    const deps = makeDeps();
    deps.apiClient.createBroadcast.mockRejectedValue(new BroadcastApiError(409, "既存配信あり"));
    const timers = makeTimerSpies();
    const { controller, states, events } = makeController(deps, timers);

    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    expect(deps.tabLockGuard.release).toHaveBeenCalled();
    expect(events).toEqual(["duplicate_broadcast_blocked"]);
    expect(states).toEqual(["preparing", "failed", "ended"]);
    expect(controller.state).toBe("ended");
  });

  it("handleTransportOpen(false): 初回接続完了でlive状態になる。onResendConfigは再接続専用のため呼ばれない（初回の設定送信はonConfig側の責務）", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const onResendConfig = jest.fn();
    const onForceKeyframe = jest.fn();
    const { controller, states } = makeController(deps, timers, { onResendConfig, onForceKeyframe });
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    controller.handleTransportOpen(false);

    expect(onResendConfig).not.toHaveBeenCalled();
    expect(onForceKeyframe).not.toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("live");
  });

  it("handleTransportOpen(true): 再接続完了で設定再送とキーフレーム強制発行を行う", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const onResendConfig = jest.fn();
    const onForceKeyframe = jest.fn();
    const { controller, events } = makeController(deps, timers, { onResendConfig, onForceKeyframe });
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    controller.handleTransportClose();
    controller.handleTransportOpen(true);

    expect(onResendConfig).toHaveBeenCalledTimes(1);
    expect(onForceKeyframe).toHaveBeenCalledTimes(1);
    expect(events).toContain("reconnected");
    expect(controller.state).toBe("live");
  });

  it("handleTransportClose(): live状態から接続断でreconnecting状態になる", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    controller.handleTransportClose();

    expect(controller.state).toBe("reconnecting");
    expect(events).toContain("reconnecting");
  });

  it("handleReconnectFailed(): 再接続の打ち切りで停止・ロック解放を行いfailedとして終了する", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);
    controller.handleTransportClose();

    controller.handleReconnectFailed();

    expect(deps.transport.close).toHaveBeenCalled();
    expect(deps.tabLockGuard.release).toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining(["reconnecting", "reconnect_failed", "broadcast_failed"]),
    );
    expect(controller.state).toBe("ended");
  });

  it("handleControl: keyframe_requestはonForceKeyframeを呼ぶ", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const onForceKeyframe = jest.fn();
    const { controller, events } = makeController(deps, timers, { onForceKeyframe });
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    controller.handleControl({ type: "keyframe_request" });

    expect(onForceKeyframe).toHaveBeenCalled();
    expect(events).toContain("keyframe_requested");
  });

  it("handleControl: throttleは中継側の指示を送信側の判定より優先してGovernorへ適用する", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });

    controller.handleControl({ type: "throttle", targetBitrateKbps: 900 });

    expect(deps.governor.applyThrottle).toHaveBeenCalledWith(900);
    expect(events).toContain("throttled");
  });

  it("handleControl: fatalは配信を停止する", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    controller.handleControl({ type: "fatal", reason: "quota exceeded" });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.transport.close).toHaveBeenCalled();
    expect(events).toContain("broadcast_failed");
  });

  it("evaluateTick: 滞留時間が4000msを超えると非キーフレーム映像を破棄する", async () => {
    const deps = makeDeps();
    deps.sendQueue.queueDelayMs.mockReturnValue(4500);
    const timers = makeTimerSpies();
    const { controller } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    const evaluateEntry = timers.entries.find((e) => e.ms === 1000)!;
    evaluateEntry.handler();

    expect(deps.sendQueue.dropNonKeyVideo).toHaveBeenCalled();
  });

  it("evaluateTick: reconnecting状態でも滞留時間の破棄方針は継続する（8節：送信のみ保留）", async () => {
    const deps = makeDeps();
    deps.sendQueue.queueDelayMs.mockReturnValue(4500);
    const timers = makeTimerSpies();
    const { controller } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);
    controller.handleTransportClose();
    expect(controller.state).toBe("reconnecting");

    const evaluateEntry = timers.entries.find((e) => e.ms === 1000)!;
    evaluateEntry.handler();

    expect(deps.sendQueue.dropNonKeyVideo).toHaveBeenCalled();
    // 再接続完了前は送信が保留中のため、ビットレート評価・状態報告は行わない。
    expect(deps.governor.evaluate).not.toHaveBeenCalled();
    expect(deps.transport.sendControl).not.toHaveBeenCalled();
  });

  it("evaluateTick: 滞留時間が8000msを超えるとdegradedへ、規定時間継続するとreconnectingへ移行する", async () => {
    const deps = makeDeps();
    deps.sendQueue.queueDelayMs.mockReturnValue(9000);
    const timers = makeTimerSpies();
    let now = 0;
    const { controller, events } = makeController(deps, timers, {
      nowMs: () => now,
      degradedSustainMs: 10_000,
    });
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);
    const evaluateEntry = timers.entries.find((e) => e.ms === 1000)!;

    now = 1000;
    evaluateEntry.handler(); // 劣化開始
    expect(controller.state).toBe("degraded");
    expect(events).toContain("degraded");

    now = 5000; // まだ規定時間(10s)未満
    evaluateEntry.handler();
    expect(controller.state).toBe("degraded");

    now = 12_000; // 劣化開始から10s以上経過
    evaluateEntry.handler();

    expect(controller.state).toBe("reconnecting");
    expect(deps.transport.reconnectNow).toHaveBeenCalled();
  });

  it("evaluateTick: 滞留時間が回復するとlive状態へ戻る", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    let now = 0;
    const { controller, events } = makeController(deps, timers, { nowMs: () => now });
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);
    const evaluateEntry = timers.entries.find((e) => e.ms === 1000)!;

    deps.sendQueue.queueDelayMs.mockReturnValue(9000);
    now = 1000;
    evaluateEntry.handler();
    expect(controller.state).toBe("degraded");

    deps.sendQueue.queueDelayMs.mockReturnValue(100);
    now = 2000;
    evaluateEntry.handler();

    expect(controller.state).toBe("live");
    expect(events).toContain("recovered");
  });

  it("ロック生存通知に失敗すると配信を停止する（onLockLost）", async () => {
    const deps = makeDeps();
    deps.apiClient.lockHeartbeat.mockRejectedValue(new Error("lock expired"));
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    const heartbeatEntry = timers.entries.find((e) => e.ms === 5000)!;
    await heartbeatEntry.handler();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain("lock_lost");
    expect(deps.transport.close).toHaveBeenCalled();
  });

  it("stop(): 停止操作で中継への終了通知・停止API呼び出し・ロック解放を行い、endedで終了する", async () => {
    const deps = makeDeps();
    const timers = makeTimerSpies();
    const { controller, events } = makeController(deps, timers);
    await controller.start({ layoutPreset: "standard", profile: DEFAULT_ENCODE_PROFILE });
    controller.handleTransportOpen(false);

    await controller.stop("user_stopped");

    expect(deps.transport.close).toHaveBeenCalledWith("user_stopped");
    expect(deps.apiClient.stopBroadcast).toHaveBeenCalledWith("b1", "user_stopped");
    expect(deps.tabLockGuard.release).toHaveBeenCalled();
    expect(events).toContain("broadcast_stopped");
    expect(controller.state).toBe("ended");
    expect(timers.clearIntervalFn).toHaveBeenCalled();
  });
});
