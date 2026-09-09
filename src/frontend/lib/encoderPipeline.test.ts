import {
  AudioEncoderPipeline,
  VideoEncoderPipeline,
  type RawEncodedChunk,
  type RawEncoderMetadata,
} from "./encoderPipeline";
import { DEFAULT_ENCODE_PROFILE } from "./types";

function makeFakeChunk(
  overrides: Partial<RawEncodedChunk> & { bytes: number[] },
): RawEncodedChunk {
  const bytes = new Uint8Array(overrides.bytes);
  return {
    type: overrides.type ?? "delta",
    timestamp: overrides.timestamp ?? 0,
    byteLength: bytes.byteLength,
    copyTo: (dest) => dest.set(bytes),
  };
}

describe("VideoEncoderPipeline", () => {
  it("コンストラクタでプロファイル通りにconfigureする", () => {
    const configureSpy = jest.fn();
    class FakeVideoEncoder {
      constructor(_init: unknown) {}
      configure(config: unknown) {
        configureSpy(config);
      }
      encode() {}
    }

    new VideoEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk: () => {},
      VideoEncoderCtor: FakeVideoEncoder as never,
    });

    expect(configureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codec: DEFAULT_ENCODE_PROFILE.videoCodec,
        width: 1280,
        height: 720,
        bitrate: DEFAULT_ENCODE_PROFILE.videoBitrateInitialKbps * 1000,
        framerate: 30,
      }),
    );
  });

  it("出力チャンクをonChunkへ転送し、時刻はMediaClock由来の値をそのまま使う（実時計を経由しない）", () => {
    let capturedOutput: (chunk: RawEncodedChunk, metadata?: RawEncoderMetadata) => void = () => {};
    class FakeVideoEncoder {
      constructor(init: { output: typeof capturedOutput }) {
        capturedOutput = init.output;
      }
      configure() {}
      encode() {
        capturedOutput(makeFakeChunk({ type: "key", timestamp: 66667, bytes: [1, 2, 3] }));
      }
    }

    const onChunk = jest.fn();
    const pipeline = new VideoEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk,
      VideoEncoderCtor: FakeVideoEncoder as never,
    });

    pipeline.encode({}, { keyFrame: false });

    expect(onChunk).toHaveBeenCalledWith({
      type: "key",
      timestampUs: 66667,
      data: new Uint8Array([1, 2, 3]),
    });
  });

  it("forceKeyframeを呼ぶと次のencode()呼び出しでkeyFrame:trueが渡される", () => {
    const encodeSpy = jest.fn();
    class FakeVideoEncoder {
      constructor(_init: unknown) {}
      configure() {}
      encode(frame: unknown, options?: { keyFrame?: boolean }) {
        encodeSpy(options);
      }
    }

    const pipeline = new VideoEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk: () => {},
      VideoEncoderCtor: FakeVideoEncoder as never,
    });

    pipeline.forceKeyframe();
    pipeline.encode({});
    pipeline.encode({}); // 2回目はフラグが消費済みなのでfalseに戻る

    expect(encodeSpy).toHaveBeenNthCalledWith(1, { keyFrame: true });
    expect(encodeSpy).toHaveBeenNthCalledWith(2, { keyFrame: false });
  });

  it("setBitrateはエンコーダを新しいビットレートで再設定する", () => {
    const configureSpy = jest.fn();
    class FakeVideoEncoder {
      constructor(_init: unknown) {}
      configure(config: unknown) {
        configureSpy(config);
      }
      encode() {}
    }

    const pipeline = new VideoEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk: () => {},
      VideoEncoderCtor: FakeVideoEncoder as never,
    });

    pipeline.setBitrate(1200);

    expect(configureSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ bitrate: 1_200_000 }),
    );
  });

  it("configChunkはdecoderConfig付きの出力があった時点から取得できる（再接続時の再送用）", () => {
    let capturedOutput: (chunk: RawEncodedChunk, metadata?: RawEncoderMetadata) => void = () => {};
    class FakeVideoEncoder {
      constructor(init: { output: typeof capturedOutput }) {
        capturedOutput = init.output;
      }
      configure() {}
      encode() {
        capturedOutput(
          makeFakeChunk({ type: "key", timestamp: 0, bytes: [9, 9] }),
          { decoderConfig: { codec: "avc1", description: new Uint8Array([7, 7, 7]).buffer } },
        );
      }
    }

    const pipeline = new VideoEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk: () => {},
      VideoEncoderCtor: FakeVideoEncoder as never,
    });

    expect(pipeline.configChunk()).toBeNull();
    pipeline.encode({}, { keyFrame: true });
    expect(pipeline.configChunk()?.data).toEqual(new Uint8Array([7, 7, 7]));
  });
});

describe("AudioEncoderPipeline", () => {
  it("コンストラクタでプロファイル通りにconfigureする", () => {
    const configureSpy = jest.fn();
    class FakeAudioEncoder {
      constructor(_init: unknown) {}
      configure(config: unknown) {
        configureSpy(config);
      }
      encode() {}
    }

    new AudioEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk: () => {},
      AudioEncoderCtor: FakeAudioEncoder as never,
    });

    expect(configureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codec: DEFAULT_ENCODE_PROFILE.audioCodec,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      }),
    );
  });

  it("出力チャンクをonChunkへ転送する", () => {
    let capturedOutput: (chunk: RawEncodedChunk, metadata?: RawEncoderMetadata) => void = () => {};
    class FakeAudioEncoder {
      constructor(init: { output: typeof capturedOutput }) {
        capturedOutput = init.output;
      }
      configure() {}
      encode() {
        capturedOutput(makeFakeChunk({ type: "key", timestamp: 21333, bytes: [4, 5] }));
      }
    }

    const onChunk = jest.fn();
    const pipeline = new AudioEncoderPipeline({
      profile: DEFAULT_ENCODE_PROFILE,
      onChunk,
      AudioEncoderCtor: FakeAudioEncoder as never,
    });

    pipeline.encode({});

    expect(onChunk).toHaveBeenCalledWith({
      type: "key",
      timestampUs: 21333,
      data: new Uint8Array([4, 5]),
    });
  });
});
