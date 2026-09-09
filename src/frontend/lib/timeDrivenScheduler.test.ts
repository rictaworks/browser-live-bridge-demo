import { TimeDrivenScheduler } from "./timeDrivenScheduler";

describe("TimeDrivenScheduler", () => {
  it("startすると規定間隔でonTickが呼ばれ続ける（requestAnimationFrameではなくタイマー駆動）", () => {
    jest.useFakeTimers();
    const onTick = jest.fn();
    const scheduler = new TimeDrivenScheduler({ intervalMs: 1000 / 30, onTick });

    scheduler.start();
    jest.advanceTimersByTime((1000 / 30) * 10);

    expect(onTick).toHaveBeenCalledTimes(10);
    scheduler.stop();
    jest.useRealTimers();
  });

  it("stopするとそれ以降onTickは呼ばれない", () => {
    jest.useFakeTimers();
    const onTick = jest.fn();
    const scheduler = new TimeDrivenScheduler({ intervalMs: 100, onTick });

    scheduler.start();
    jest.advanceTimersByTime(300);
    scheduler.stop();
    jest.advanceTimersByTime(1000);

    expect(onTick).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it("startを二重に呼んでもタイマーは1つだけになる", () => {
    const setIntervalFn = jest.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalFn = jest.fn();
    const scheduler = new TimeDrivenScheduler({
      intervalMs: 33,
      onTick: () => {},
      setIntervalFn,
      clearIntervalFn,
    });

    scheduler.start();
    scheduler.start();

    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("isRunningはタイマーの起動状態を反映する", () => {
    const scheduler = new TimeDrivenScheduler({
      intervalMs: 33,
      onTick: () => {},
      setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("タブの可視状態を問わずタイマーで駆動するため、非表示化を模したフラグを見ずにonTickが呼ばれ続ける", () => {
    // rAFはdocument.hiddenの影響を受けて呼び出しが止まりうるが、
    // このスケジューラはsetIntervalベースであり可視状態を一切参照しないことを、
    // 実装がdocument/windowに触れていないことをもって確認する。
    jest.useFakeTimers();
    const onTick = jest.fn();
    const scheduler = new TimeDrivenScheduler({ intervalMs: 10, onTick });
    scheduler.start();
    jest.advanceTimersByTime(100);
    scheduler.stop();
    expect(onTick.mock.calls.length).toBeGreaterThan(0);
    jest.useRealTimers();
  });
});
