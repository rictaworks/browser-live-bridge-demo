// 音声混合（requirements.md 6.4節）。
//
// - マイクを基準音量、タブ音声はマイクより低い比率で混合する
// - 混合後の信号は上限を超えないよう抑制する
// - 音声フレームは常時途切れなく生成する。音声ソースが1つも無い場合も
//   無音のフレームを生成し続ける（受け口側で接続断と解釈されるため）

import type { SourceKind } from "./types";

export const DEFAULT_GAINS: Record<"mic" | "tab_audio", number> = {
  mic: 1.0,
  tab_audio: 0.35,
};

const LIMITER_CEILING = 0.98;

/** 指定長の無音（全サンプル0）バッファを生成する。 */
export function generateSilence(length: number): Float32Array {
  return new Float32Array(length);
}

export interface GainedBuffer {
  data: Float32Array;
  gain: number;
}

/**
 * 複数バッファをゲイン適用しつつ加算し、上限（LIMITER_CEILING）を超えないよう
 * ピークベースで抑制する。入力が空であれば無音を返す。
 */
export function mixBuffers(buffers: GainedBuffer[], length: number): Float32Array {
  const mixed = new Float32Array(length);

  for (const { data, gain } of buffers) {
    const n = Math.min(length, data.length);
    for (let i = 0; i < n; i += 1) {
      mixed[i] += data[i] * gain;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const abs = Math.abs(mixed[i]);
    if (abs > peak) {
      peak = abs;
    }
  }

  if (peak > LIMITER_CEILING) {
    const scale = LIMITER_CEILING / peak;
    for (let i = 0; i < length; i += 1) {
      mixed[i] *= scale;
    }
  }

  return mixed;
}

export interface AudioInput {
  kind: Extract<SourceKind, "mic" | "tab_audio">;
  data: Float32Array;
}

export interface AudioBlock {
  data: Float32Array;
  /** 実際に混合に使われた音声ソースの数（0であれば無音ブロック） */
  sourceCount: number;
}

export class AudioMixer {
  private readonly blockLength: number;
  private gains: Record<"mic" | "tab_audio", number> = { ...DEFAULT_GAINS };

  constructor(options: { blockLength: number }) {
    this.blockLength = options.blockLength;
  }

  setGain(kind: "mic" | "tab_audio", value: number): void {
    this.gains[kind] = value;
  }

  getGain(kind: "mic" | "tab_audio"): number {
    return this.gains[kind];
  }

  /**
   * 与えられた音声入力を混合する。入力が空であれば無音ブロックを返し、
   * 常に一定長のブロックを生成し続ける。
   */
  mix(inputs: AudioInput[]): AudioBlock {
    if (inputs.length === 0) {
      return { data: this.emitSilence(), sourceCount: 0 };
    }

    const buffers: GainedBuffer[] = inputs.map((input) => ({
      data: input.data,
      gain: this.gains[input.kind],
    }));

    return {
      data: mixBuffers(buffers, this.blockLength),
      sourceCount: inputs.length,
    };
  }

  /** 無音ブロックを生成する（音声ソースが1つも無い場合に常時呼ばれる）。 */
  emitSilence(): Float32Array {
    return generateSilence(this.blockLength);
  }
}
