// 適応制御（requirements.md 7節）。
//
// | 条件                                             | 動作                       |
// |--------------------------------------------------|----------------------------|
// | 滞留時間>1500msが2回連続                          | 目標ビットレートを30%引き下げ |
// | 滞留時間<300ms かつ 直近10秒の破棄が皆無           | 目標ビットレートを10%引き上げ |
// | (滞留>4000ms・>8000msの扱いはSendQueue/上位が担当) |                            |
//
// - 音声フレーム・キーフレームの非破棄はSendQueue側の責務
// - 目標ビットレートの変更は1秒に1回を上限とする
// - 中継からの抑制指示（applyThrottle）は送信側の判定より優先する
// - 引き下げ幅（既定30%）は引き上げ幅（既定10%）より大きい＝回復はより緩やか

export interface BitrateGovernorOptions {
  initialKbps: number;
  minKbps: number;
  maxKbps: number;
  /** 引き下げ係数。既定0.7（30%引き下げ） */
  downFactor?: number;
  /** 引き上げ係数。既定1.10（10%引き上げ） */
  upFactor?: number;
  /** この滞留時間(ms)を超える状態が2回連続で引き下げ対象。既定1500 */
  overThresholdMs?: number;
  /** この滞留時間(ms)未満なら引き上げ候補。既定300 */
  underThresholdMs?: number;
  /** 目標ビットレート変更の最小間隔(ms)。既定1000（1秒に1回） */
  minChangeIntervalMs?: number;
}

export interface EvaluateInput {
  /** 現在の滞留時間(ms) */
  queueDelayMs: number;
  /** 直近10秒間の破棄件数（0であれば引き上げ候補） */
  dropsInLast10s: number;
  /** 評価時刻(ms)。テスト容易性のため呼び出し側から注入する。 */
  nowMs: number;
}

const DEFAULTS = {
  downFactor: 0.7,
  upFactor: 1.1,
  overThresholdMs: 1500,
  underThresholdMs: 300,
  minChangeIntervalMs: 1000,
};

export class BitrateGovernor {
  private readonly minKbps: number;
  private readonly maxKbps: number;
  private readonly downFactor: number;
  private readonly upFactor: number;
  private readonly overThresholdMs: number;
  private readonly underThresholdMs: number;
  private readonly minChangeIntervalMs: number;

  private _target: number;
  private overStreak = 0;
  private lastChangeAtMs: number | null = null;
  private pendingExternalThrottleKbps: number | null = null;

  constructor(options: BitrateGovernorOptions) {
    this.minKbps = options.minKbps;
    this.maxKbps = options.maxKbps;
    this.downFactor = options.downFactor ?? DEFAULTS.downFactor;
    this.upFactor = options.upFactor ?? DEFAULTS.upFactor;
    this.overThresholdMs = options.overThresholdMs ?? DEFAULTS.overThresholdMs;
    this.underThresholdMs = options.underThresholdMs ?? DEFAULTS.underThresholdMs;
    this.minChangeIntervalMs =
      options.minChangeIntervalMs ?? DEFAULTS.minChangeIntervalMs;

    this._target = this.clamp(options.initialKbps);
  }

  get target(): number {
    return this._target;
  }

  /**
   * 滞留時間・破棄状況から目標ビットレートを再評価する。
   * 呼び出し側は概ね毎秒1回呼ぶことを想定する。
   */
  evaluate(input: EvaluateInput): number {
    // 中継からの抑制指示が保留されていれば、ローカル判定より優先して適用する。
    if (this.pendingExternalThrottleKbps !== null) {
      this._target = this.clamp(this.pendingExternalThrottleKbps);
      this.pendingExternalThrottleKbps = null;
      this.overStreak = 0;
      this.lastChangeAtMs = input.nowMs;
      return this._target;
    }

    if (input.queueDelayMs > this.overThresholdMs) {
      this.overStreak += 1;
    } else {
      this.overStreak = 0;
    }

    const canChange =
      this.lastChangeAtMs === null ||
      input.nowMs - this.lastChangeAtMs >= this.minChangeIntervalMs;

    if (this.overStreak >= 2) {
      if (canChange) {
        this._target = this.clamp(Math.round(this._target * this.downFactor));
        this.lastChangeAtMs = input.nowMs;
      }
      this.overStreak = 0;
      return this._target;
    }

    if (
      input.queueDelayMs < this.underThresholdMs &&
      input.dropsInLast10s === 0 &&
      canChange
    ) {
      this._target = this.clamp(Math.round(this._target * this.upFactor));
      this.lastChangeAtMs = input.nowMs;
      return this._target;
    }

    return this._target;
  }

  /**
   * 中継からの抑制指示を適用予約する。次回のevaluate()でローカル判定に
   * 優先して反映される（requirements.md 7節：抑制指示は送信側の判定より優先）。
   */
  applyThrottle(kbps: number): void {
    this.pendingExternalThrottleKbps = kbps;
  }

  private clamp(kbps: number): number {
    return Math.min(this.maxKbps, Math.max(this.minKbps, kbps));
  }
}
