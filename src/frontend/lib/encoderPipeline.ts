// エンコード（requirements.md 6.5節）。WebCodecs API（VideoEncoder/AudioEncoder）
// をラップする。
//
// - エンコーダの初期化情報（decoderConfig由来のconfigChunk）は最初のメディア
//   フレームより前に送信すること。再接続時は再送すること
//   → configChunk()で直近の設定情報を取得できるようにし、呼び出し側
//     （BroadcastController/TransportChannel）が再接続時に再送する
// - 時刻はMediaClockで採番したものをそのままVideoFrame/AudioDataへ渡し、
//   エンコーダはその値をそのまま出力チャンクのtimestampとして返す
//   （実時計は一切経由しない）
//
// WebCodecsはjsdom/Node環境に存在しないため、コンストラクタでVideoEncoder/
// AudioEncoderの実体を注入できるようにし、ユニットテストではフェイク実装に
// 差し替える（モック境界）。

import type { EncodeProfile } from "./types";

export interface EncodedChunkLike {
  type: "key" | "delta";
  timestampUs: number;
  data: Uint8Array;
}

/** 実際のEncodedVideoChunk/EncodedAudioChunkが持つ、この層で必要な最小限のAPI。 */
export interface RawEncodedChunk {
  type: "key" | "delta";
  timestamp: number;
  byteLength: number;
  copyTo(destination: Uint8Array): void;
}

export interface RawEncoderMetadata {
  decoderConfig?: {
    codec?: string;
    description?: ArrayBuffer | ArrayBufferView;
  };
}

function chunkToBytes(chunk: RawEncodedChunk): Uint8Array {
  const dest = new Uint8Array(chunk.byteLength);
  chunk.copyTo(dest);
  return dest;
}

function descriptionToBytes(
  description: ArrayBuffer | ArrayBufferView | undefined,
): Uint8Array {
  if (!description) {
    return new Uint8Array();
  }
  if (description instanceof Uint8Array) {
    return description;
  }
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  }
  return new Uint8Array(description);
}

export interface VideoEncoderLike {
  configure(config: {
    codec: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
  }): void;
  encode(frame: unknown, options?: { keyFrame?: boolean }): void;
  close?(): void;
}

export type VideoEncoderCtor = new (init: {
  output: (chunk: RawEncodedChunk, metadata?: RawEncoderMetadata) => void;
  error: (error: Error) => void;
}) => VideoEncoderLike;

export interface VideoEncoderPipelineOptions {
  profile: EncodeProfile;
  onChunk: (chunk: EncodedChunkLike) => void;
  onError?: (error: Error) => void;
  VideoEncoderCtor: VideoEncoderCtor;
}

export class VideoEncoderPipeline {
  private readonly encoder: VideoEncoderLike;
  private readonly onChunk: (chunk: EncodedChunkLike) => void;
  private readonly profile: EncodeProfile;
  private bitrateKbps: number;
  private pendingForceKeyframe = false;
  private lastConfigChunk: EncodedChunkLike | null = null;

  constructor(options: VideoEncoderPipelineOptions) {
    this.profile = options.profile;
    this.onChunk = options.onChunk;
    this.bitrateKbps = options.profile.videoBitrateInitialKbps;

    this.encoder = new options.VideoEncoderCtor({
      output: (chunk, metadata) => this.handleOutput(chunk, metadata),
      error: (error) => options.onError?.(error),
    });

    this.configure();
  }

  private configure(): void {
    this.encoder.configure({
      codec: this.profile.videoCodec,
      width: this.profile.width,
      height: this.profile.height,
      bitrate: this.bitrateKbps * 1000,
      framerate: this.profile.fps,
    });
  }

  /** frameはVideoFrame相当。timestampはMediaClock.nextVideoTime()の値をあらかじめ設定しておくこと。 */
  encode(frame: unknown, options: { keyFrame?: boolean } = {}): void {
    const keyFrame = options.keyFrame === true || this.pendingForceKeyframe;
    this.pendingForceKeyframe = false;
    this.encoder.encode(frame, { keyFrame });
  }

  /** 次のencode()呼び出しでキーフレームを強制する（スリープ復帰・再接続時等）。 */
  forceKeyframe(): void {
    this.pendingForceKeyframe = true;
  }

  /** 目標ビットレートに応じてエンコーダを再設定する（requirements.md 7節の適応制御と連携）。 */
  setBitrate(kbps: number): void {
    this.bitrateKbps = kbps;
    this.configure();
  }

  /** 直近の設定情報（decoderConfig由来）。再接続時の再送に使う。 */
  configChunk(): EncodedChunkLike | null {
    return this.lastConfigChunk;
  }

  private handleOutput(chunk: RawEncodedChunk, metadata?: RawEncoderMetadata): void {
    if (metadata?.decoderConfig) {
      this.lastConfigChunk = {
        type: "key",
        timestampUs: chunk.timestamp,
        data: descriptionToBytes(metadata.decoderConfig.description),
      };
    }
    this.onChunk({
      type: chunk.type,
      timestampUs: chunk.timestamp,
      data: chunkToBytes(chunk),
    });
  }
}

export interface AudioEncoderLike {
  configure(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    bitrate: number;
  }): void;
  encode(data: unknown): void;
  close?(): void;
}

export type AudioEncoderCtor = new (init: {
  output: (chunk: RawEncodedChunk, metadata?: RawEncoderMetadata) => void;
  error: (error: Error) => void;
}) => AudioEncoderLike;

export interface AudioEncoderPipelineOptions {
  profile: EncodeProfile;
  onChunk: (chunk: EncodedChunkLike) => void;
  onError?: (error: Error) => void;
  AudioEncoderCtor: AudioEncoderCtor;
}

export class AudioEncoderPipeline {
  private readonly encoder: AudioEncoderLike;
  private readonly onChunk: (chunk: EncodedChunkLike) => void;
  private lastConfigChunk: EncodedChunkLike | null = null;

  constructor(options: AudioEncoderPipelineOptions) {
    this.onChunk = options.onChunk;

    this.encoder = new options.AudioEncoderCtor({
      output: (chunk, metadata) => this.handleOutput(chunk, metadata),
      error: (error) => options.onError?.(error),
    });

    this.encoder.configure({
      codec: options.profile.audioCodec,
      sampleRate: options.profile.sampleRate,
      numberOfChannels: options.profile.channels,
      bitrate: options.profile.audioBitrateKbps * 1000,
    });
  }

  /** dataはAudioData相当。timestampはMediaClock.nextAudioTime()の値をあらかじめ設定しておくこと。 */
  encode(data: unknown): void {
    this.encoder.encode(data);
  }

  configChunk(): EncodedChunkLike | null {
    return this.lastConfigChunk;
  }

  private handleOutput(chunk: RawEncodedChunk, metadata?: RawEncoderMetadata): void {
    if (metadata?.decoderConfig) {
      this.lastConfigChunk = {
        type: "key",
        timestampUs: chunk.timestamp,
        data: descriptionToBytes(metadata.decoderConfig.description),
      };
    }
    this.onChunk({
      type: chunk.type,
      timestampUs: chunk.timestamp,
      data: chunkToBytes(chunk),
    });
  }
}
