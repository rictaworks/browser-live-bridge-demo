import {
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FrameDecodeError,
  HEADER_LENGTH,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
} from "./frameProtocol";

describe("frameProtocol: encodeFrame/decodeFrame", () => {
  it("映像フレームをエンコードしてデコードすると元の内容に一致する", () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeFrame({
      type: "video",
      keyframe: true,
      timestampUs: 123456789,
      body,
    });

    const decoded = decodeFrame(encoded);

    expect(decoded.type).toBe("video");
    expect(decoded.keyframe).toBe(true);
    expect(decoded.timestampUs).toBe(123456789);
    expect(Array.from(decoded.body)).toEqual(Array.from(body));
  });

  it("非キーフレームの属性ビットが立たない", () => {
    const encoded = encodeFrame({
      type: "audio",
      keyframe: false,
      timestampUs: 0,
      body: new Uint8Array(),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.keyframe).toBe(false);
  });

  it("ヘッダのレイアウトが仕様通り（識別子2B・版1B・種別1B・属性1B・時刻8B・本文長4B）", () => {
    const body = new Uint8Array([9, 9]);
    const encoded = encodeFrame({
      type: "video_config",
      keyframe: false,
      timestampUs: 42,
      body,
    });

    expect(encoded.byteLength).toBe(HEADER_LENGTH + body.byteLength);

    const view = new DataView(encoded.buffer);
    expect(view.getUint16(0, false)).toBe(PROTOCOL_MAGIC);
    expect(view.getUint8(2)).toBe(PROTOCOL_VERSION);
    expect(view.getUint32(13, false)).toBe(body.byteLength); // 本文長フィールドの位置
  });

  it("空の本文（音声設定など）も正しく往復できる", () => {
    const encoded = encodeFrame({
      type: "audio_config",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.body.byteLength).toBe(0);
  });

  it("識別子が不正なフレームは拒否する", () => {
    const encoded = encodeFrame({
      type: "video",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    const corrupted = new Uint8Array(encoded);
    corrupted[0] = 0x00; // 識別子を破壊
    expect(() => decodeFrame(corrupted)).toThrow(FrameDecodeError);
  });

  it("版が不正なフレームは拒否する", () => {
    const encoded = encodeFrame({
      type: "video",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    const corrupted = new Uint8Array(encoded);
    corrupted[2] = 0xff; // 版を破壊
    expect(() => decodeFrame(corrupted)).toThrow(FrameDecodeError);
  });

  it("本文長がメッセージ全体長と整合しない場合は拒否する", () => {
    const encoded = encodeFrame({
      type: "video",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array([1, 2, 3]),
    });
    const truncated = encoded.slice(0, encoded.byteLength - 1); // 1バイト欠落
    expect(() => decodeFrame(truncated)).toThrow(FrameDecodeError);
  });

  it("ヘッダ長に満たない短いメッセージは拒否する", () => {
    expect(() => decodeFrame(new Uint8Array([1, 2, 3]))).toThrow(FrameDecodeError);
  });

  it("未知の種別コードは拒否する", () => {
    const encoded = encodeFrame({
      type: "video",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    const corrupted = new Uint8Array(encoded);
    corrupted[3] = 0xee; // 種別を未知の値へ書き換え
    expect(() => decodeFrame(corrupted)).toThrow(FrameDecodeError);
  });
});

describe("frameProtocol: 制御メッセージ", () => {
  it("開始通知（start）を往復できる", () => {
    const encoded = encodeControlMessage(
      {
        type: "start",
        sessionKey: "sess-1",
        broadcastToken: "token-1",
        profile: { width: 1280, height: 720 },
      },
      1000,
    );
    const frame = decodeFrame(encoded);
    expect(frame.type).toBe("control");
    const message = decodeControlMessage(frame);
    expect(message).toEqual({
      type: "start",
      sessionKey: "sess-1",
      broadcastToken: "token-1",
      profile: { width: 1280, height: 720 },
    });
  });

  it("抑制指示（throttle）を往復できる", () => {
    const encoded = encodeControlMessage(
      { type: "throttle", targetBitrateKbps: 1200 },
      2000,
    );
    const message = decodeControlMessage(decodeFrame(encoded));
    expect(message).toEqual({ type: "throttle", targetBitrateKbps: 1200 });
  });

  it("制御フレーム以外をdecodeControlMessageに渡すと拒否する", () => {
    const encoded = encodeFrame({
      type: "video",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    expect(() => decodeControlMessage(decodeFrame(encoded))).toThrow(
      FrameDecodeError,
    );
  });

  it("不正なJSON本文の制御フレームは拒否する", () => {
    const body = new TextEncoder().encode("not json");
    const encoded = encodeFrame({
      type: "control",
      keyframe: false,
      timestampUs: 1,
      body,
    });
    expect(() => decodeControlMessage(decodeFrame(encoded))).toThrow(
      FrameDecodeError,
    );
  });
});
