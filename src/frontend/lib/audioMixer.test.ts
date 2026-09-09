import { AudioMixer, DEFAULT_GAINS, generateSilence, mixBuffers } from "./audioMixer";

describe("generateSilence", () => {
  it("指定長のゼロ埋めバッファを返す", () => {
    const silence = generateSilence(8);
    expect(silence.length).toBe(8);
    expect(Array.from(silence)).toEqual(new Array(8).fill(0));
  });
});

describe("mixBuffers", () => {
  it("複数バッファをゲイン適用して加算する", () => {
    const a = new Float32Array([0.2, 0.2, 0.2]);
    const b = new Float32Array([0.1, 0.1, 0.1]);
    const mixed = mixBuffers(
      [
        { data: a, gain: 1.0 },
        { data: b, gain: 0.5 },
      ],
      3,
    );
    expect(mixed[0]).toBeCloseTo(0.25);
  });

  it("上限を超える混合結果はピークベースで抑制される", () => {
    const a = new Float32Array([0.9, -0.9, 0.9]);
    const b = new Float32Array([0.9, 0.9, -0.9]);
    const mixed = mixBuffers(
      [
        { data: a, gain: 1.0 },
        { data: b, gain: 1.0 },
      ],
      3,
    );
    for (const v of mixed) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0);
    }
  });

  it("入力が空であればゼロ埋めのバッファを返す", () => {
    const mixed = mixBuffers([], 4);
    expect(Array.from(mixed)).toEqual([0, 0, 0, 0]);
  });
});

describe("AudioMixer", () => {
  it("マイクは既定でタブ音声より高いゲインを持つ（話者の音声が埋もれない）", () => {
    expect(DEFAULT_GAINS.mic).toBeGreaterThan(DEFAULT_GAINS.tab_audio);
  });

  it("音声ソースが1つも無い場合は無音ブロックを生成する", () => {
    const mixer = new AudioMixer({ blockLength: 16 });
    const block = mixer.mix([]);
    expect(block.sourceCount).toBe(0);
    expect(Array.from(block.data)).toEqual(new Array(16).fill(0));
  });

  it("マイクとタブ音声を混合すると、タブ音声はより低い比率で反映される", () => {
    const mixer = new AudioMixer({ blockLength: 4 });
    const mic = new Float32Array([0.1, 0.1, 0.1, 0.1]);
    const tab = new Float32Array([0.1, 0.1, 0.1, 0.1]);

    const micOnly = mixer.mix([{ kind: "mic", data: mic }]);
    const mixed = mixer.mix([
      { kind: "mic", data: mic },
      { kind: "tab_audio", data: tab },
    ]);

    // マイク単独より、タブ音声を足した分だけわずかに増える程度（マイクを埋もれさせない）
    expect(mixed.data[0]).toBeGreaterThan(micOnly.data[0]);
    expect(mixed.data[0]).toBeLessThan(micOnly.data[0] * 2);
  });

  it("setGainでゲインを変更できる", () => {
    const mixer = new AudioMixer({ blockLength: 4 });
    mixer.setGain("tab_audio", 0.1);
    expect(mixer.getGain("tab_audio")).toBe(0.1);
  });

  it("emitSilenceは常に一定長のブロックを返す（途切れない無音生成）", () => {
    const mixer = new AudioMixer({ blockLength: 10 });
    const s1 = mixer.emitSilence();
    const s2 = mixer.emitSilence();
    expect(s1.length).toBe(10);
    expect(s2.length).toBe(10);
  });

  it("混合結果は常に上限（1.0）を超えない", () => {
    const mixer = new AudioMixer({ blockLength: 3 });
    mixer.setGain("mic", 1.0);
    mixer.setGain("tab_audio", 1.0);
    const loud = new Float32Array([1.0, -1.0, 1.0]);

    const block = mixer.mix([
      { kind: "mic", data: loud },
      { kind: "tab_audio", data: loud },
    ]);

    for (const v of block.data) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0);
    }
  });
});
