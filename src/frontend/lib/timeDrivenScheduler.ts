// 時間駆動のスケジューラ（requirements.md 6.3節）。
//
// 合成ループは描画フレームの供給（requestAnimationFrame）に依存しない
// 時間駆動とし、タブが非アクティブ・最小化された状態でも規定のフレーム
// レートで継続すること、という要件を満たすための最小単位。
//
// setInterval/clearIntervalはrequestAnimationFrameと異なり、非表示タブでも
// 呼び出され続ける（ブラウザによりある程度スロットリングされ得るが、
// rAFのように完全停止はしない）。本番的にはこのスケジューラをWeb Worker内で
// 動かすことを推奨する（Workerのタイマーは背景タブのスロットリング対象外の
// ため、より安定した周期を得られる）。実際のWorker配線は
// workers/compositionClockWorker.ts が担う。

export interface TimeDrivenSchedulerOptions {
  intervalMs: number;
  onTick: () => void;
  /** テスト注入用。既定はグローバルのsetInterval/clearInterval。 */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export class TimeDrivenScheduler {
  private readonly intervalMs: number;
  private readonly onTick: () => void;
  private readonly setIntervalFn: TimeDrivenSchedulerOptions["setIntervalFn"];
  private readonly clearIntervalFn: TimeDrivenSchedulerOptions["clearIntervalFn"];
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(options: TimeDrivenSchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.onTick = options.onTick;
    this.setIntervalFn = options.setIntervalFn ?? ((h, t) => setInterval(h, t));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  get isRunning(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) {
      return;
    }
    this.handle = this.setIntervalFn!(this.onTick, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) {
      return;
    }
    this.clearIntervalFn!(this.handle);
    this.handle = null;
  }
}
