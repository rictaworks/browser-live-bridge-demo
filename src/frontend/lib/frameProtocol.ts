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
// 制御メッセージの本体は、中継層（src/relay/internal/protocol/control.go）と
// バイト単位で一致する独自バイナリ形式でシリアライズする（先頭1バイトの種別
// コード + 型ごとの固定/可変長フィールド）。中継層側の実装がチーム間契約と
// なっており、双方をJSON等の別形式にすると相互に本文を認識できず、開始通知
// そのものが破棄されてしまうため（21節の逸脱フレーム破棄規定により無応答で
// 落ちる）、この形式に統一している。

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

// 制御メッセージ種別コード（src/relay/internal/protocol/control.goのControlTypeと一致させる）。
const CONTROL_TYPE_CODES: Record<ControlMessageType, number> = {
  start: 0x01,
  status: 0x02,
  end: 0x03,
  ack: 0x81,
  keyframe_request: 0x82,
  throttle: 0x83,
  fatal: 0x84,
};

const CONTROL_TYPE_BY_CODE: Record<number, ControlMessageType> = Object.fromEntries(
  Object.entries(CONTROL_TYPE_CODES).map(([k, v]) => [v, k as ControlMessageType]),
) as Record<number, ControlMessageType>;

function writeControlString(chunks: Uint8Array[], value: string): void {
  const encoded = textEncoder.encode(value);
  const lengthPrefix = new Uint8Array(2);
  new DataView(lengthPrefix.buffer).setUint16(0, encoded.byteLength, false);
  chunks.push(lengthPrefix, encoded);
}

function writeControlUint32(chunks: Uint8Array[], value: number): void {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  chunks.push(buf);
}

function concatChunks(typeCode: number, chunks: Uint8Array[]): Uint8Array {
  const total = 1 + chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  out[0] = typeCode;
  let offset = 1;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function readControlString(body: Uint8Array, offset: number): [string, number] {
  if (offset + 2 > body.byteLength) {
    throw new FrameDecodeError("control body truncated (string length)");
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const length = view.getUint16(offset, false);
  offset += 2;
  if (offset + length > body.byteLength) {
    throw new FrameDecodeError("control body truncated (string content)");
  }
  return [textDecoder.decode(body.slice(offset, offset + length)), offset + length];
}

/**
 * 制御メッセージをフレーム化してバイナリへエンコードする
 * （中継層のバイナリTLV形式と一致させる。上記コメント参照）。
 */
export function encodeControlMessage(
  message: ControlMessage,
  timestampUs: number,
): Uint8Array {
  const typeCode = CONTROL_TYPE_CODES[message.type];
  const chunks: Uint8Array[] = [];
  let body: Uint8Array;

  switch (message.type) {
    case "start":
      writeControlString(chunks, message.sessionKey);
      writeControlString(chunks, message.broadcastToken);
      writeControlString(chunks, JSON.stringify(message.profile));
      body = concatChunks(typeCode, chunks);
      break;
    case "status":
      writeControlUint32(chunks, message.queueDelayMs);
      writeControlUint32(chunks, message.droppedFrames); // 破棄されるのは映像のみ（7節）
      writeControlUint32(chunks, 0); // 音声フレームは破棄対象外のため常に0
      writeControlUint32(chunks, message.targetBitrateKbps);
      body = concatChunks(typeCode, chunks);
      break;
    case "end":
      writeControlString(chunks, message.reason);
      body = concatChunks(typeCode, chunks);
      break;
    case "ack": {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(message.receivedAtUs))), false);
      body = concatChunks(typeCode, [buf]);
      break;
    }
    case "keyframe_request":
      body = concatChunks(typeCode, []);
      break;
    case "throttle":
      writeControlUint32(chunks, message.targetBitrateKbps);
      body = concatChunks(typeCode, chunks);
      break;
    case "fatal":
      writeControlString(chunks, message.reason);
      body = concatChunks(typeCode, chunks);
      break;
  }

  return encodeFrame({ type: "control", keyframe: false, timestampUs, body });
}

/**
 * 制御フレームの本体をControlMessageへデコードする
 * （中継層のバイナリTLV形式と一致させる。上記コメント参照）。
 */
export function decodeControlMessage(frame: MediaFrame): ControlMessage {
  if (frame.type !== "control") {
    throw new FrameDecodeError("not a control frame");
  }
  const body = frame.body;
  if (body.byteLength < 1) {
    throw new FrameDecodeError("empty control body");
  }
  const typeCode = body[0];
  const type = CONTROL_TYPE_BY_CODE[typeCode];
  if (type === undefined || !CONTROL_TYPES.includes(type)) {
    throw new FrameDecodeError(`unknown control message type code: ${typeCode}`);
  }

  try {
    switch (type) {
      case "start": {
        const [sessionKey, off1] = readControlString(body, 1);
        const [broadcastToken, off2] = readControlString(body, off1);
        const [profileJson] = readControlString(body, off2);
        return { type: "start", sessionKey, broadcastToken, profile: JSON.parse(profileJson) as Record<string, unknown> };
      }
      case "status": {
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        if (body.byteLength < 17) {
          throw new FrameDecodeError("control body truncated (status)");
        }
        return {
          type: "status",
          queueDelayMs: view.getUint32(1, false),
          droppedFrames: view.getUint32(5, false),
          targetBitrateKbps: view.getUint32(13, false),
        };
      }
      case "end": {
        const [reason] = readControlString(body, 1);
        return { type: "end", reason };
      }
      case "ack": {
        if (body.byteLength < 9) {
          throw new FrameDecodeError("control body truncated (ack)");
        }
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        return { type: "ack", receivedAtUs: Number(view.getBigUint64(1, false)) };
      }
      case "keyframe_request":
        return { type: "keyframe_request" };
      case "throttle": {
        if (body.byteLength < 5) {
          throw new FrameDecodeError("control body truncated (throttle)");
        }
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        return { type: "throttle", targetBitrateKbps: view.getUint32(1, false) };
      }
      case "fatal": {
        const [reason] = readControlString(body, 1);
        return { type: "fatal", reason };
      }
    }
  } catch (err) {
    if (err instanceof FrameDecodeError) {
      throw err;
    }
    throw new FrameDecodeError(`failed to decode control message: ${String(err)}`);
  }
}
