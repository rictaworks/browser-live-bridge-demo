// ソース管理（requirements.md 6.2節・17節クラス図SourceManager/SourceHandle・
// 18.2節状態遷移図）。
//
// 欠落時の扱い（6.2節フォールバック表）:
//   画面共有欠落 → カメラを主映像に昇格。カメラも無ければテストカード
//   カメラ欠落   → ワイプを非表示にして継続
//   マイク欠落   → 無音生成器に切替えて継続（AudioMixer側の責務）
//   タブ音声欠落 → 混合対象から除外して継続（AudioMixer側の責務）
//   テストカード → 常時利用可能な代替主映像
//
// ブラウザAPI（getDisplayMedia/getUserMedia）は直接呼び出さず、
// SourceProvidersとして注入する。これによりユニットテストで実ブラウザAPIを
// モック境界として切り離せる。

import type { SourceKind, SourceRole, SourceState } from "./types";

/**
 * 実際のMediaStreamTrackが持つ、この層で必要な最小限のインターフェース。
 * テストでは軽量なフェイク実装に差し替える。
 */
export interface TrackLike {
  addEventListener(type: "ended", listener: () => void): void;
  removeEventListener(type: "ended", listener: () => void): void;
  stop(): void;
}

export interface SourceHandle {
  kind: SourceKind;
  role: SourceRole;
  state: SourceState;
  track: TrackLike | null;
}

export interface SourceProviders {
  acquireScreen: () => Promise<{ video: TrackLike | null; audio: TrackLike | null }>;
  acquireCamera: () => Promise<TrackLike>;
  acquireMic: () => Promise<TrackLike>;
}

export type SourceLifecycleEvent = {
  kind: SourceKind;
  state: SourceState;
};

function roleFor(kind: SourceKind): SourceRole {
  switch (kind) {
    case "screen":
    case "test":
      return "primary";
    case "camera":
      return "wipe";
    case "mic":
    case "tab_audio":
      return "audio";
  }
}

const TEST_CARD_HANDLE: SourceHandle = {
  kind: "test",
  role: "primary",
  state: "active",
  track: null,
};

export class SourceManager {
  private handles = new Map<SourceKind, SourceHandle>();
  private readonly providers: SourceProviders;
  private readonly listeners = new Map<SourceKind, () => void>();
  private readonly onEvent?: (event: SourceLifecycleEvent) => void;

  constructor(providers: SourceProviders, onEvent?: (event: SourceLifecycleEvent) => void) {
    this.providers = providers;
    this.onEvent = onEvent;
  }

  /**
   * ソースを要求・取得する。画面共有は映像トラックに加え、取得できれば
   * タブ音声トラックも合わせて登録する。
   */
  async attach(kind: SourceKind): Promise<SourceHandle> {
    if (kind === "test") {
      this.handles.set("test", { ...TEST_CARD_HANDLE });
      this.emit("test", "active");
      return this.handles.get("test")!;
    }

    this.emit(kind, "requesting");
    try {
      if (kind === "screen") {
        const { video, audio } = await this.providers.acquireScreen();
        if (video) {
          this.registerTrack("screen", video);
        }
        if (audio) {
          this.registerTrack("tab_audio", audio);
        } else {
          // タブ音声が取得できなかった場合は「混合対象から除外」して継続
          this.handles.delete("tab_audio");
        }
        const handle = this.handles.get("screen");
        if (!handle) {
          throw new Error("画面共有の映像トラックを取得できませんでした");
        }
        return handle;
      }

      const track =
        kind === "camera" ? await this.providers.acquireCamera() : await this.providers.acquireMic();
      return this.registerTrack(kind, track);
    } catch (err) {
      this.emit(kind, "denied");
      throw err;
    }
  }

  private registerTrack(kind: SourceKind, track: TrackLike): SourceHandle {
    const handle: SourceHandle = { kind, role: roleFor(kind), state: "active", track };
    this.handles.set(kind, handle);

    const listener = () => this.handleTrackEnded(kind);
    this.listeners.set(kind, listener);
    track.addEventListener("ended", listener);

    this.emit(kind, "active");
    return handle;
  }

  private handleTrackEnded(kind: SourceKind): void {
    const handle = this.handles.get(kind);
    if (!handle) {
      return;
    }
    handle.state = "lost";
    this.emit(kind, "lost");

    // 欠落時の扱いへ遷移（6.2節フォールバック表）。トラック自体は破棄する。
    handle.track = null;
    handle.state = "substituted";
    this.emit(kind, "substituted");
  }

  /** ソースを解除する。取得済みトラックは停止する。 */
  detach(kind: SourceKind): void {
    const handle = this.handles.get(kind);
    if (handle?.track) {
      const listener = this.listeners.get(kind);
      if (listener) {
        handle.track.removeEventListener("ended", listener);
        this.listeners.delete(kind);
      }
      handle.track.stop();
    }
    this.handles.delete(kind);
    // detach後はハンドル自体を保持しない（get()はundefinedを返す）ため、
    // 状態変更を伴うemit()ではなく通知のみを行う。
    this.onEvent?.({ kind, state: "detached" });
  }

  get(kind: SourceKind): SourceHandle | undefined {
    return this.handles.get(kind);
  }

  /**
   * 主映像として使うソースを決定する（フォールバック表準拠）。
   * 画面共有が生きていれば画面共有、無ければカメラを昇格、
   * どちらも無ければテストカード（常時利用可能）。
   */
  resolvePrimary(): SourceHandle {
    const screen = this.handles.get("screen");
    if (screen?.state === "active" && screen.track) {
      return screen;
    }

    const camera = this.handles.get("camera");
    if (camera?.state === "active" && camera.track) {
      return { ...camera, role: "primary" };
    }

    return { ...TEST_CARD_HANDLE };
  }

  /**
   * ワイプとして使うソースを決定する。カメラが主映像へ昇格している間は
   * ワイプとして使わず、非表示のままとする。
   */
  resolveWipe(): SourceHandle | null {
    const camera = this.handles.get("camera");
    if (!camera || camera.state !== "active" || !camera.track) {
      return null;
    }
    const screen = this.handles.get("screen");
    const cameraPromotedToPrimary = !(screen?.state === "active" && screen.track);
    if (cameraPromotedToPrimary) {
      return null;
    }
    return camera;
  }

  /** 混合対象となる音声ソース一覧（マイク・タブ音声のうち生存しているもの）。 */
  resolveAudioSources(): SourceHandle[] {
    const result: SourceHandle[] = [];
    const mic = this.handles.get("mic");
    if (mic?.state === "active" && mic.track) {
      result.push(mic);
    }
    const tabAudio = this.handles.get("tab_audio");
    if (tabAudio?.state === "active" && tabAudio.track) {
      result.push(tabAudio);
    }
    return result;
  }

  private emit(kind: SourceKind, state: SourceState): void {
    const handle = this.handles.get(kind);
    if (handle) {
      handle.state = state;
    } else {
      // requesting/deniedの通過時点ではまだトラックを保持していないため、
      // 状態のみを持つプレースホルダーのハンドルを登録しておく。
      this.handles.set(kind, { kind, role: roleFor(kind), state, track: null });
    }
    this.onEvent?.({ kind, state });
  }
}
