import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "node:util";

// jsdom環境にはTextEncoder/TextDecoderが存在しないため、Node.jsの実装を補う。
// frameProtocol（制御メッセージのJSONシリアライズ）等が利用する。
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
  // NodeのTextDecoder#decodeはSharedArrayBufferも受け付ける型になっており、
  // lib.dom.d.tsのTextDecoder#decode（ArrayBuffer限定）とは互換性がないため
  // 抑制する。実行時の互換性には影響しない。
  // @ts-expect-error: NodeのTextDecoderとlib.dom.d.tsの型差異
  globalThis.TextDecoder = TextDecoder;
}

// jsdom環境にはBroadcastChannelが存在しないため、Node.js組み込みの実装を補う。
// tabLockGuard（タブ間排他、requirements.md 9節）が利用する。
if (typeof globalThis.BroadcastChannel === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BroadcastChannel } = require("node:worker_threads");
  globalThis.BroadcastChannel = BroadcastChannel;
}
