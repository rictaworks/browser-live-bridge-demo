import { MediaClock } from "./mediaClock";

describe("MediaClock", () => {
  it("採番する映像時刻はフレーム番号から単調増加で算出され、実時計を参照しない", () => {
    const clock = new MediaClock({ fps: 30 });

    expect(clock.nextVideoTime()).toBe(0);
    expect(clock.nextVideoTime()).toBe(33333); // 1/30秒 ≒ 33333us
    expect(clock.nextVideoTime()).toBe(66667);
    expect(clock.videoFrameIndex).toBe(3);
  });

  it("採番する音声時刻は累積サンプル数から算出される", () => {
    const clock = new MediaClock({ sampleRate: 48000 });

    // 1024サンプルのブロックを3回送出
    expect(clock.nextAudioTime(1024)).toBe(0);
    expect(clock.nextAudioTime(1024)).toBe(21333); // 1024/48000秒 ≒ 21333us
    expect(clock.nextAudioTime(1024)).toBe(42667);
    expect(clock.audioSampleCount).toBe(1024 * 3);
  });

  it("実時計を差し替えても映像・音声の採番結果は変化しない（実時計非依存）", () => {
    let fakeNow = 1_000_000;
    const clock = new MediaClock({ wallClockNowMs: () => fakeNow });

    const t1 = clock.nextVideoTime();
    fakeNow += 10_000; // 実時計だけ大きく進める（スリープ相当）
    const t2 = clock.nextVideoTime();

    expect(t1).toBe(0);
    expect(t2).toBe(33333);
  });

  it("detectGapは初回呼び出しでは空白なしを返す", () => {
    const fakeNow = 0;
    const clock = new MediaClock({ fps: 30, wallClockNowMs: () => fakeNow });

    expect(clock.detectGap()).toBeNull();
  });

  it("detectGapは規定フレーム間隔を大きく超えた経過を空白として検知する", () => {
    let fakeNow = 0;
    const clock = new MediaClock({ fps: 30, wallClockNowMs: () => fakeNow });

    clock.detectGap(); // 基準点を記録
    fakeNow += 5000; // 5秒間のスリープを模擬
    const gap = clock.detectGap();

    expect(gap).not.toBeNull();
    expect(gap!.durationMs).toBe(5000);
    expect(gap!.framesToFill).toBeGreaterThan(0);
  });

  it("detectGapは通常のフレーム間隔では空白と判定しない", () => {
    let fakeNow = 0;
    const clock = new MediaClock({ fps: 30, wallClockNowMs: () => fakeNow });

    clock.detectGap();
    fakeNow += 33; // ほぼ1フレーム分
    expect(clock.detectGap()).toBeNull();
  });

  it("fillGapは映像フレーム番号・音声サンプル数を空白分だけ進め、以後の採番を連続させる", () => {
    const clock = new MediaClock({ fps: 30, sampleRate: 48000 });

    clock.nextVideoTime(); // frame 0 -> index 1
    clock.fillGap({ durationMs: 2000, framesToFill: 60 }); // 2秒分(60フレーム)を埋める

    expect(clock.videoFrameIndex).toBe(61);
    const nextTime = clock.nextVideoTime();
    expect(nextTime).toBe(Math.round((61 * 1_000_000) / 30));
    expect(clock.audioSampleCount).toBe(Math.round((60 * 48000) / 30));
  });

  it("resetで映像・音声・空白検知の状態を初期化できる", () => {
    const clock = new MediaClock();
    clock.nextVideoTime();
    clock.nextAudioTime(1024);
    clock.detectGap();

    clock.reset();

    expect(clock.videoFrameIndex).toBe(0);
    expect(clock.audioSampleCount).toBe(0);
    expect(clock.detectGap()).toBeNull(); // 基準点がリセットされ、初回扱いになる
  });
});
