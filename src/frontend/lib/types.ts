// 配信パイプライン全体で共有する型定義。
// 仕様の正はrequirements.md（特に3節・6節・9節・13節・18節）。

/** ソース種別（requirements.md 6.2節） */
export type SourceKind = "screen" | "camera" | "mic" | "tab_audio" | "test";

/** ソースの役割（requirements.md 6.2節） */
export type SourceRole = "primary" | "wipe" | "audio";

/** ソースの状態遷移（requirements.md 18.2節） */
export type SourceState =
  | "detached"
  | "requesting"
  | "active"
  | "denied"
  | "lost"
  | "substituted";

/** 配信セッションの状態遷移（requirements.md 18.1節） */
export type BroadcastState =
  | "idle"
  | "preparing"
  | "ready"
  | "connecting"
  | "live"
  | "degraded"
  | "reconnecting"
  | "stopping"
  | "failed"
  | "ended";

/** 転送フレームの種別（requirements.md 6.6節） */
export type FrameType =
  | "video_config"
  | "video"
  | "audio_config"
  | "audio"
  | "control";

/** 制御メッセージの種別（requirements.md 6.6節） */
export type ControlMessageType =
  | "start"
  | "status"
  | "end"
  | "ack"
  | "keyframe_request"
  | "throttle"
  | "fatal";

export interface EncodeProfile {
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  keyframeIntervalSec: number;
  audioCodec: string;
  sampleRate: number;
  channels: number;
  audioBitrateKbps: number;
  videoBitrateInitialKbps: number;
  videoBitrateMinKbps: number;
  videoBitrateMaxKbps: number;
}

/** requirements.md 6.5節の既定値 */
export const DEFAULT_ENCODE_PROFILE: EncodeProfile = {
  width: 1280,
  height: 720,
  fps: 30,
  videoCodec: "avc1.42001f", // H.264 Baseline, Level 3.1
  keyframeIntervalSec: 2,
  audioCodec: "mp4a.40.2", // AAC-LC
  sampleRate: 48000,
  channels: 2,
  audioBitrateKbps: 128,
  videoBitrateInitialKbps: 2500,
  videoBitrateMinKbps: 800,
  videoBitrateMaxKbps: 4000,
};

export interface QueueItem {
  type: "video" | "audio";
  keyframe: boolean;
  timestampUs: number;
  enqueuedAtMs: number;
  payload: Uint8Array;
}

/** イベントログの種別（requirements.md 13.2節：18種を想定した代表例） */
export type EventType =
  | "source_attached"
  | "source_lost"
  | "source_substituted"
  | "source_detached"
  | "broadcast_started"
  | "broadcast_stopped"
  | "broadcast_failed"
  | "degraded"
  | "recovered"
  | "reconnecting"
  | "reconnected"
  | "reconnect_failed"
  | "throttled"
  | "keyframe_requested"
  | "gap_filled"
  | "lock_lost"
  | "duplicate_broadcast_blocked"
  | "chat_posted";

export interface BroadcastEvent {
  occurredAt: number;
  type: EventType;
  detail?: string;
}
