import { BitrateGovernor } from "./bitrateGovernor";

function makeGovernor(overrides: Partial<ConstructorParameters<typeof BitrateGovernor>[0]> = {}) {
  return new BitrateGovernor({
    initialKbps: 2500,
    minKbps: 800,
    maxKbps: 4000,
    ...overrides,
  });
}

describe("BitrateGovernor", () => {
  it("初期値・下限・上限で目標ビットレートをクランプする", () => {
    const governor = makeGovernor({ initialKbps: 9999 });
    expect(governor.target).toBe(4000);

    const governor2 = makeGovernor({ initialKbps: 10 });
    expect(governor2.target).toBe(800);
  });

  it("滞留時間>1500msが1回だけでは引き下げない", () => {
    const governor = makeGovernor();
    governor.evaluate({ queueDelayMs: 2000, dropsInLast10s: 0, nowMs: 1000 });
    expect(governor.target).toBe(2500);
  });

  it("滞留時間>1500msが2回連続すると30%引き下げる", () => {
    const governor = makeGovernor();
    governor.evaluate({ queueDelayMs: 2000, dropsInLast10s: 0, nowMs: 1000 });
    const target = governor.evaluate({
      queueDelayMs: 2000,
      dropsInLast10s: 0,
      nowMs: 2000,
    });
    expect(target).toBe(Math.round(2500 * 0.7));
  });

  it("滞留時間<300msかつ直近10秒に破棄が皆無であれば10%引き上げる", () => {
    const governor = makeGovernor();
    const target = governor.evaluate({
      queueDelayMs: 100,
      dropsInLast10s: 0,
      nowMs: 1000,
    });
    expect(target).toBe(Math.round(2500 * 1.1));
  });

  it("滞留時間<300msでも直近10秒に破棄があれば引き上げない", () => {
    const governor = makeGovernor();
    const target = governor.evaluate({
      queueDelayMs: 100,
      dropsInLast10s: 3,
      nowMs: 1000,
    });
    expect(target).toBe(2500);
  });

  it("目標ビットレートの変更は1秒に1回を上限とする", () => {
    const governor = makeGovernor();
    governor.evaluate({ queueDelayMs: 100, dropsInLast10s: 0, nowMs: 1000 });
    const afterFirstChange = governor.target;
    expect(afterFirstChange).toBe(Math.round(2500 * 1.1));

    // 500ms後（1秒未満）に再度引き上げ条件を満たしても変化しない
    const target = governor.evaluate({
      queueDelayMs: 100,
      dropsInLast10s: 0,
      nowMs: 1500,
    });
    expect(target).toBe(afterFirstChange);
  });

  it("引き下げ幅は引き上げ幅より大きい（回復はより緩やか）", () => {
    const governor = makeGovernor();
    const down = governor.evaluate({ queueDelayMs: 2000, dropsInLast10s: 0, nowMs: 1000 });
    const downTarget = governor.evaluate({
      queueDelayMs: 2000,
      dropsInLast10s: 0,
      nowMs: 2000,
    });
    const dropRatio = downTarget / 2500;

    const governor2 = makeGovernor();
    const upTarget = governor2.evaluate({
      queueDelayMs: 100,
      dropsInLast10s: 0,
      nowMs: 1000,
    });
    const upRatio = upTarget / 2500;

    expect(1 - dropRatio).toBeGreaterThan(upRatio - 1);
    // 参照: downは未使用変数警告を避けるためのダミー参照
    expect(down).toBeDefined();
  });

  it("下限を下回らない・上限を上回らない", () => {
    const governor = makeGovernor({ initialKbps: 850 });
    // 何度も引き下げ条件を満たしても下限800を下回らない
    for (let i = 0; i < 10; i += 1) {
      governor.evaluate({
        queueDelayMs: 2000,
        dropsInLast10s: 0,
        nowMs: 1000 + i * 2000,
      });
      governor.evaluate({
        queueDelayMs: 2000,
        dropsInLast10s: 0,
        nowMs: 1000 + i * 2000 + 1000,
      });
    }
    expect(governor.target).toBeGreaterThanOrEqual(800);

    const governor2 = makeGovernor({ initialKbps: 3990 });
    for (let i = 0; i < 10; i += 1) {
      governor2.evaluate({
        queueDelayMs: 100,
        dropsInLast10s: 0,
        nowMs: 1000 + i * 2000,
      });
    }
    expect(governor2.target).toBeLessThanOrEqual(4000);
  });

  it("中継からの抑制指示（applyThrottle）は次回のevaluateでローカル判定より優先される", () => {
    const governor = makeGovernor();
    governor.applyThrottle(1000);

    // ローカル判定は引き上げ条件を満たすが、抑制指示が優先される
    const target = governor.evaluate({
      queueDelayMs: 100,
      dropsInLast10s: 0,
      nowMs: 1000,
    });

    expect(target).toBe(1000);
  });

  it("抑制指示適用後は連続超過カウントがリセットされる", () => {
    const governor = makeGovernor();
    governor.evaluate({ queueDelayMs: 2000, dropsInLast10s: 0, nowMs: 1000 }); // streak=1
    governor.applyThrottle(2000);
    governor.evaluate({ queueDelayMs: 2000, dropsInLast10s: 0, nowMs: 2000 }); // throttle適用、streakリセット

    // 次のevaluateは1回目の超過扱いになるため、まだ引き下げは発生しない
    const target = governor.evaluate({
      queueDelayMs: 2000,
      dropsInLast10s: 0,
      nowMs: 3000,
    });
    expect(target).toBe(2000);
  });

  it("音声フレーム・キーフレームの非破棄判断はSendQueueの責務であり、Governorは対象外（統合はBroadcastControllerで担保）", () => {
    // Governor自体はビットレート数値のみを扱う。破棄方針はSendQueue.dropNonKeyVideoが担う。
    const governor = makeGovernor();
    expect(typeof governor.evaluate).toBe("function");
  });
});
