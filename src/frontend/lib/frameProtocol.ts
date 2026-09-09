// 転送プロトコル（requirements.md 6.6節）。
//
// WebSocket上のバイナリ転送。1メッセージ1フレーム。
//
// フレーム構造:
//   識別子(2B) 版(1B) 種別(1B) 属性(1B) 時刻(8B, us) 本文長(4B) 本文(可変)
//
// 種別: 映像設定・映像・音声設定・音声・制御
// 属性: bit0 = キーフレームか否か
//
// 制御メッセージの本体はUTF-8のJSONとしてシリアライズする（開始通知・
// 状態報告・終了通知・受領応答・キーフレーム要求・抑制指示・致命通知）。
// バイナリ本体をさらにアドホックな独自バイナリで定義するよりも堅牢で
// 拡張しやすいと判断した（デモ版のためJSON化による多少のサイズ増は許容する）。

import type { ControlMessageType, FrameType } from "./types";

/** プロトコル識別子 "BL"（Browser Live bridge）。 */
export const PROTOCOL_MAGIC = 0x424c;
export const PROTOCOL_VERSION = 1;

const FRAME_TYPE_CODES: Record<FrameType, number> = {
  video_config: 0x01,
  video: 0x02,
  audio_config: 0x03,
  audio: 0x04,
  control: 0x05,
};

const FRAME_TYPE_BY_CODE: Record<number, FrameType> = Object.fromEntries(
  Object.entries(FRAME_TYPE_CODES).map(([k, v]) => [v, k as FrameType]),
) as Record<number, FrameType>;

const KEYFRAME_FLAG = 0b0000_0001;

export const HEADER_LENGTH = 2 + 1 + 1 + 1 + 8 + 4; // = 17 bytes

export interface MediaFrame {
  type: FrameType;
  keyframe: boolean;
  timestampUs: number;
  body: Uint8Array;
}

export class FrameDecodeError extends Error {}

/**
 * MediaFrameをバイナリのメッセージへエンコードする。
 */
export function encodeFrame(frame: MediaFrame): Uint8Array {
  const buf = new ArrayBuffer(HEADER_LENGTH + frame.body.byteLength);
  const view = new DataView(buf);
  let offset = 0;

  view.setUint16(offset, PROTOCOL_MAGIC, false);
  offset += 2;

  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;

  const typeCode = FRAME_TYPE_CODES[frame.type];
  if (typeCode === undefined) {
    throw new FrameDecodeError(`unknown frame type: ${frame.type}`);
  }
  view.setUint8(offset, typeCode);
  offset += 1;

  view.setUint8(offset, frame.keyframe ? KEYFRAME_FLAG : 0);
  offset += 1;

  // 8バイトの時刻（マイクロ秒）。JSは53bit精度までの整数を安全に扱える前提。
  view.setBigUint64(offset, BigInt(Math.max(0, Math.round(frame.timestampUs))), false);
  offset += 8;

  view.setUint32(offset, frame.body.byteLength, false);
  offset += 4;

  new Uint8Array(buf, offset).set(frame.body);

  return new Uint8Array(buf);
}

/**
 * バイナリメッセージをMediaFrameへデコードする。
 * 長さ・種別・時刻の整合を検証し、逸脱するフレームは例外で拒否する
 * （requirements.md 21節：受信フレームの検証要件）。
 */
export function decodeFrame(input: ArrayBuffer | Uint8Array): MediaFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.byteLength < HEADER_LENGTH) {
    throw new FrameDecodeError("frame shorter than header length");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const magic = view.getUint16(offset, false);
  offset += 2;
  if (magic !== PROTOCOL_MAGIC) {
    throw new FrameDecodeError("invalid protocol magic");
  }

  const version = view.getUint8(offset);
  offset += 1;
  if (version !== PROTOCOL_VERSION) {
    throw new FrameDecodeError(`unsupported protocol version: ${version}`);
  }

  const typeCode = view.getUint8(offset);
  offset += 1;
  const type = FRAME_TYPE_BY_CODE[typeCode];
  if (type === undefined) {
    throw new FrameDecodeError(`unknown frame type code: ${typeCode}`);
  }

  const flags = view.getUint8(offset);
  offset += 1;
  const keyframe = (flags & KEYFRAME_FLAG) !== 0;

  const timestampUs = Number(view.getBigUint64(offset, false));
  offset += 8;
  if (!Number.isFinite(timestampUs) || timestampUs < 0) {
    throw new FrameDecodeError("invalid timestamp");
  }

  const bodyLength = view.getUint32(offset, false);
  offset += 4;

  if (offset + bodyLength !== bytes.byteLength) {
    throw new FrameDecodeError("body length does not match message size");
  }

  const body = bytes.slice(offset, offset + bodyLength);

  return { type, keyframe, timestampUs, body };
}

// --- 制御メッセージ（requirements.md 6.6節） ---

export interface StartControlMessage {
  type: "start";
  sessionKey: string;
  broadcastToken: string;
  profile: Record<string, unknown>;
}

export interface StatusControlMessage {
  type: "status";
  queueDelayMs: number;
  droppedFrames: number;
  targetBitrateKbps: number;
}

export interface EndControlMessage {
  type: "end";
  reason: string;
}

export interface AckControlMessage {
  type: "ack";
  receivedAtUs: number;
}

export interface KeyframeRequestControlMessage {
  type: "keyframe_request";
}

export interface ThrottleControlMessage {
  type: "throttle";
  targetBitrateKbps: number;
}

export interface FatalControlMessage {
  type: "fatal";
  reason: string;
}

export type ControlMessage =
  | StartControlMessage
  | StatusControlMessage
  | EndControlMessage
  | AckControlMessage
  | KeyframeRequestControlMessage
  | ThrottleControlMessage
  | FatalControlMessage;

const CONTROL_TYPES: ControlMessageType[] = [
  "start",
  "status",
  "end",
  "ack",
  "keyframe_request",
  "throttle",
  "fatal",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 制御メッセージをフレーム化してバイナリへエンコードする。
 */
export function encodeControlMessage(
  message: ControlMessage,
  timestampUs: number,
): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  return encodeFrame({
    type: "control",
    keyframe: false,
    timestampUs,
    body,
  });
}

/**
 * 制御フレームの本体をControlMessageへデコードする。
 */
export function decodeControlMessage(frame: MediaFrame): ControlMessage {
  if (frame.type !== "control") {
    throw new FrameDecodeError("not a control frame");
  }
  const json = textDecoder.decode(frame.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new FrameDecodeError("control frame body is not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !CONTROL_TYPES.includes((parsed as { type: string }).type as ControlMessageType)
  ) {
    throw new FrameDecodeError("unknown control message type");
  }

  return parsed as ControlMessage;
}
