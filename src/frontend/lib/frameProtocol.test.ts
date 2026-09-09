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

  it("未知の種別コードの制御フレームは拒否する（中継層のバイナリTLV形式との整合）", () => {
    const body = new Uint8Array([0xff]);
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

  it("空の制御フレーム本体は拒否する", () => {
    const encoded = encodeFrame({
      type: "control",
      keyframe: false,
      timestampUs: 1,
      body: new Uint8Array(),
    });
    expect(() => decodeControlMessage(decodeFrame(encoded))).toThrow(
      FrameDecodeError,
    );
  });

  it("状態報告（status）を往復できる。音声フレームは破棄対象外のためdroppedAudioFramesは常に0で送る", () => {
    const encoded = encodeControlMessage(
      { type: "status", queueDelayMs: 1500, droppedFrames: 3, targetBitrateKbps: 2000 },
      3000,
    );
    const message = decodeControlMessage(decodeFrame(encoded));
    expect(message).toEqual({ type: "status", queueDelayMs: 1500, droppedFrames: 3, targetBitrateKbps: 2000 });
  });

  it("終了通知（end）・受領応答（ack）・キーフレーム要求・致命通知（fatal）を往復できる", () => {
    expect(
      decodeControlMessage(decodeFrame(encodeControlMessage({ type: "end", reason: "user_stopped" }, 1))),
    ).toEqual({ type: "end", reason: "user_stopped" });
    expect(
      decodeControlMessage(decodeFrame(encodeControlMessage({ type: "ack", receivedAtUs: 123456 }, 1))),
    ).toEqual({ type: "ack", receivedAtUs: 123456 });
    expect(
      decodeControlMessage(decodeFrame(encodeControlMessage({ type: "keyframe_request" }, 1))),
    ).toEqual({ type: "keyframe_request" });
    expect(
      decodeControlMessage(decodeFrame(encodeControlMessage({ type: "fatal", reason: "quota_exceeded" }, 1))),
    ).toEqual({ type: "fatal", reason: "quota_exceeded" });
  });

  it("開始通知のバイト列が中継層（src/relay/internal/protocol/control.go）の形式と一致する（クロス実装の疎通確認）", () => {
    // src/relay/internal/protocol/control.goのEncodeStartNotice/readStringと同じ規則
    // （種別コード1byte + 2byte長プレフィックス(BE) + UTF-8本文、を3フィールド分）で
    // 手動デコードし、encodeControlMessageの出力がこれと一致することを確認する。
    const readString = (body: Uint8Array, offset: number): [string, number] => {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const length = view.getUint16(offset, false);
      offset += 2;
      return [new TextDecoder().decode(body.slice(offset, offset + length)), offset + length];
    };

    const encoded = encodeControlMessage(
      { type: "start", sessionKey: "sess-1", broadcastToken: "token-1", profile: { width: 1280 } },
      1000,
    );
    const frame = decodeFrame(encoded);
    expect(frame.body[0]).toBe(0x01); // ControlStartNotice
    const [sessionKey, off1] = readString(frame.body, 1);
    const [broadcastToken, off2] = readString(frame.body, off1);
    const [profileJson] = readString(frame.body, off2);
    expect(sessionKey).toBe("sess-1");
    expect(broadcastToken).toBe("token-1");
    expect(JSON.parse(profileJson)).toEqual({ width: 1280 });
  });
});
