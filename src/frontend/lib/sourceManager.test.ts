import { SourceManager, type SourceProviders, type TrackLike } from "./sourceManager";
import type { SourceKind, SourceState } from "./types";

class FakeTrack implements TrackLike {
  private listeners: Array<() => void> = [];
  stopped = false;

  addEventListener(_type: "ended", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "ended", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  stop(): void {
    this.stopped = true;
  }

  fireEnded(): void {
    this.listeners.forEach((l) => l());
  }
}

function makeProviders(overrides: Partial<SourceProviders> = {}): SourceProviders {
  return {
    acquireScreen: async () => ({ video: new FakeTrack(), audio: new FakeTrack() }),
    acquireCamera: async () => new FakeTrack(),
    acquireMic: async () => new FakeTrack(),
    ...overrides,
  };
}

describe("SourceManager", () => {
  it("画面共有を取得すると主映像として解決される", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("screen");

    const primary = manager.resolvePrimary();
    expect(primary.kind).toBe("screen");
    expect(primary.role).toBe("primary");
  });

  it("画面共有取得と同時にタブ音声も登録される", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("screen");

    expect(manager.get("tab_audio")?.state).toBe("active");
  });

  it("画面共有が無い場合、カメラが主映像へ昇格する", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("camera");

    const primary = manager.resolvePrimary();
    expect(primary.kind).toBe("camera");
    expect(primary.role).toBe("primary");
  });

  it("画面共有もカメラも無い場合、テストカードが主映像となる", () => {
    const manager = new SourceManager(makeProviders());
    const primary = manager.resolvePrimary();
    expect(primary.kind).toBe("test");
  });

  it("画面共有ありでカメラを取得している場合はワイプとして解決される", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("screen");
    await manager.attach("camera");

    const wipe = manager.resolveWipe();
    expect(wipe?.kind).toBe("camera");
    expect(wipe?.role).toBe("wipe");
  });

  it("カメラが主映像に昇格している間はワイプとして扱わない", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("camera"); // 画面共有なし → カメラが主映像

    expect(manager.resolveWipe()).toBeNull();
  });

  it("画面共有の映像トラック終了を検知するとlost→substitutedへ遷移し、カメラへフォールバックする", async () => {
    const events: SourceState[] = [];
    const manager = new SourceManager(
      makeProviders(),
      (e) => e.kind === "screen" && events.push(e.state),
    );
    await manager.attach("screen");
    await manager.attach("camera");

    const screenTrack = manager.get("screen")!.track as FakeTrack;
    screenTrack.fireEnded();

    expect(events).toContain("lost");
    expect(events).toContain("substituted");
    expect(manager.resolvePrimary().kind).toBe("camera");
  });

  it("カメラトラック終了を検知するとワイプが非表示（resolveWipeがnull）になる", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("screen");
    await manager.attach("camera");

    const cameraTrack = manager.get("camera")!.track as FakeTrack;
    cameraTrack.fireEnded();

    expect(manager.resolveWipe()).toBeNull();
    // 主映像は画面共有のまま継続する
    expect(manager.resolvePrimary().kind).toBe("screen");
  });

  it("マイク・タブ音声の両方が生きていればresolveAudioSourcesは両方を返す", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("screen"); // tab_audioも同時登録
    await manager.attach("mic");

    const sources = manager.resolveAudioSources().map((s) => s.kind).sort();
    expect(sources).toEqual(["mic", "tab_audio"]);
  });

  it("マイクトラック終了後はresolveAudioSourcesから除外される", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("mic");
    const micTrack = manager.get("mic")!.track as FakeTrack;
    micTrack.fireEnded();

    expect(manager.resolveAudioSources()).toEqual([]);
  });

  it("画面共有・カメラ・マイクすべて拒否されてもテストカードで主映像が解決できる", async () => {
    const manager = new SourceManager(
      makeProviders({
        acquireScreen: async () => {
          throw new Error("permission denied");
        },
        acquireCamera: async () => {
          throw new Error("permission denied");
        },
      }),
    );

    await expect(manager.attach("screen")).rejects.toThrow();
    await expect(manager.attach("camera")).rejects.toThrow();

    expect(manager.get("screen")?.state).toBe("denied");
    expect(manager.resolvePrimary().kind).toBe("test");
  });

  it("detachはトラックを停止し、ハンドルを除去する", async () => {
    const manager = new SourceManager(makeProviders());
    await manager.attach("camera");
    const track = manager.get("camera")!.track as FakeTrack;

    manager.detach("camera");

    expect(track.stopped).toBe(true);
    expect(manager.get("camera")).toBeUndefined();
  });

  it("画面共有にタブ音声トラックが含まれない場合はtab_audioを登録しない", async () => {
    const manager = new SourceManager(
      makeProviders({
        acquireScreen: async () => ({ video: new FakeTrack(), audio: null }),
      }),
    );
    await manager.attach("screen");

    expect(manager.get("tab_audio")).toBeUndefined();
    expect(manager.resolveAudioSources()).toEqual([]);
  });

  it("配信中でもソースの追加・除去ができる（複数回のattach/detachが独立して動作する）", async () => {
    const kinds: SourceKind[] = ["camera", "mic"];
    const manager = new SourceManager(makeProviders());
    for (const kind of kinds) {
      await manager.attach(kind);
    }
    manager.detach("camera");
    await manager.attach("camera");

    expect(manager.get("camera")?.state).toBe("active");
    expect(manager.get("mic")?.state).toBe("active");
  });
});
