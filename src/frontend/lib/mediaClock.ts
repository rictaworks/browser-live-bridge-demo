// メディアクロック（requirements.md 6.5節・17節）。
//
// 送出フレームの時刻は実時計から独立させ、映像はフレーム番号、音声は
// 累積サンプル数から単調増加の時刻（マイクロ秒）を導出する。
// スリープ復帰やタブの非アクティブ化で実時計が飛んでも、この採番方式は
// 影響を受けない。
//
// 一方で「スリープ等でどれだけ空白が生じたか」を検知するには、実時計を
// 補助的な入力として参照する必要がある（fillGapを呼ぶ判断のため）。
// ただし採番そのもの（nextVideoTime/nextAudioTime）は実時計を一切参照
// しない。この区別を厳守すること。

export interface MediaClockOptions {
  /** フレームレート（既定30fps） */
  fps?: number;
  /** 音声サンプリング周波数（既定48kHz） */
  sampleRate?: number;
  /** テスト注入用の実時計（既定 Date.now） */
  wallClockNowMs?: () => number;
  /**
   * この経過（ms）を超えて次のtickが呼ばれた場合を「空白」とみなす閾値。
   * 既定は1フレーム分の3倍。
   */
  gapThresholdMs?: number;
}

export interface MediaGap {
  /** 空白の長さ（ミリ秒、実時計基準の推定値） */
  durationMs: number;
  /** 空白を埋めるために追加すべき映像フレーム数 */
  framesToFill: number;
}

export class MediaClock {
  readonly fps: number;
  readonly sampleRate: number;

  private _videoFrameIndex = 0;
  private _audioSampleCount = 0;
  private readonly wallClockNowMs: () => number;
  private readonly gapThresholdMs: number;
  private lastTickAtMs: number | null = null;

  constructor(options: MediaClockOptions = {}) {
    this.fps = options.fps ?? 30;
    this.sampleRate = options.sampleRate ?? 48000;
    this.wallClockNowMs = options.wallClockNowMs ?? (() => Date.now());
    const frameIntervalMs = 1000 / this.fps;
    this.gapThresholdMs = options.gapThresholdMs ?? frameIntervalMs * 3;
  }

  get videoFrameIndex(): number {
    return this._videoFrameIndex;
  }

  get audioSampleCount(): number {
    return this._audioSampleCount;
  }

  /**
   * 次に送出する映像フレームの時刻（マイクロ秒）を返し、フレーム番号を1進める。
   * 実時計は一切参照しない。
   */
  nextVideoTime(): number {
    const timeUs = Math.round(
      (this._videoFrameIndex * 1_000_000) / this.fps,
    );
    this._videoFrameIndex += 1;
    return timeUs;
  }

  /**
   * 次に送出する音声ブロックの先頭時刻（マイクロ秒）を返し、
   * 累積サンプル数をsampleCount分進める。実時計は一切参照しない。
   */
  nextAudioTime(sampleCount: number): number {
    const timeUs = Math.round(
      (this._audioSampleCount * 1_000_000) / this.sampleRate,
    );
    this._audioSampleCount += sampleCount;
    return timeUs;
  }

  /**
   * 呼び出し間隔を実時計で観測し、規定を超える空白があれば検知する。
   * 合成ループの各tickで呼び出す想定。空白がなければnullを返す。
   */
  detectGap(): MediaGap | null {
    const now = this.wallClockNowMs();
    const previous = this.lastTickAtMs;
    this.lastTickAtMs = now;

    if (previous === null) {
      return null;
    }

    const elapsedMs = now - previous;
    if (elapsedMs <= this.gapThresholdMs) {
      return null;
    }

    const frameIntervalMs = 1000 / this.fps;
    const framesToFill = Math.max(0, Math.round(elapsedMs / frameIntervalMs) - 1);
    if (framesToFill <= 0) {
      return null;
    }

    return { durationMs: elapsedMs, framesToFill };
  }

  /**
   * 検知した空白を埋める。映像フレーム番号・音声サンプル数を
   * 直前フレーム保持＋無音に相当する分だけ進め、以後の採番を連続させる。
   * 呼び出し側は、この直後にキーフレームを発行すること（6.5節）。
   */
  fillGap(gap: MediaGap): void {
    this._videoFrameIndex += gap.framesToFill;
    const silenceSamples = Math.round(
      (gap.framesToFill * this.sampleRate) / this.fps,
    );
    this._audioSampleCount += silenceSamples;
  }

  reset(): void {
    this._videoFrameIndex = 0;
    this._audioSampleCount = 0;
    this.lastTickAtMs = null;
  }
}
