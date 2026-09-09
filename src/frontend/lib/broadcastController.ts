// 配信セッションの状態機械（requirements.md 17節BroadcastController・18.1節状態遷移図）。
//
// ソース取得・映像合成・エンコードの実体（Canvas/WebCodecs等）はブラウザ
// 環境に強く依存するため、React側のフック（app/studio）が保持し、この
// クラスへはコールバック（onForceKeyframe/onResendConfig等）として注入する。
// このクラス自体は状態遷移・配信ライフサイクル（作成・接続・適応制御の
// 発火判断・再接続・停止）をブラウザAPIに依存せずに扱えるようにし、
// ユニットテストで状態遷移を検証できるようにしている。

import { BroadcastApiError, type BroadcastApiClient } from "./broadcastApiClient";
import type { ControlMessage } from "./frameProtocol";
import type { BitrateGovernor } from "./bitrateGovernor";
import type { SendQueue } from "./sendQueue";
import type { TabLockGuard } from "./tabLockGuard";
import type { TransportChannel } from "./transportChannel";
import type { BroadcastEvent, BroadcastState, EncodeProfile, EventType } from "./types";

type ApiClientDeps = Pick<BroadcastApiClient, "createBroadcast" | "stopBroadcast" | "lockHeartbeat">;
type TabLockDeps = Pick<TabLockGuard, "acquire" | "heartbeat" | "release">;
type TransportDeps = Pick<TransportChannel, "connect" | "close" | "sendControl" | "reconnectNow">;
type SendQueueDeps = Pick<SendQueue, "queueDelayMs" | "dropNonKeyVideo">;
type GovernorDeps = Pick<BitrateGovernor, "evaluate" | "applyThrottle"> & { target: number };

export interface BroadcastControllerOptions {
  sessionKey: string;
  apiClient: ApiClientDeps;
  tabLockGuard: TabLockDeps;
  transport: TransportDeps;
  sendQueue: SendQueueDeps;
  governor: GovernorDeps;
  onStateChange?: (state: BroadcastState) => void;
  onEvent?: (event: BroadcastEvent) => void;
  /** 直前フレーム保持等の後に即時キーフレームを発行させる（エンコーダ側への指示）。 */
  onForceKeyframe?: () => void;
  /** 映像・音声の設定情報（configChunk）を再送させる。 */
  onResendConfig?: () => void;
  onBitrateChange?: (targetKbps: number) => void;
  nowMs?: () => number;
  /** 滞留時間が8000msを超える状態が何ms継続したら再接続へ移行するか。既定10000ms。 */
  degradedSustainMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface StartInput {
  title?: string;
  layoutPreset: string;
  profile: EncodeProfile;
}

interface DropWindowEntry {
  atMs: number;
  count: number;
}

const DROP_WINDOW_MS = 10_000;
const EVALUATE_INTERVAL_MS = 1000;
const LOCK_HEARTBEAT_INTERVAL_MS = 5000;
const QUEUE_DROP_THRESHOLD_MS = 4000;
const DEGRADED_THRESHOLD_MS = 8000;

export class BroadcastController {
  private readonly options: BroadcastControllerOptions;
  private readonly nowMs: () => number;
  private readonly setIntervalFn: NonNullable<BroadcastControllerOptions["setIntervalFn"]>;
  private readonly clearIntervalFn: NonNullable<BroadcastControllerOptions["clearIntervalFn"]>;

  private _state: BroadcastState = "idle";
  broadcastId: string | null = null;
  broadcastToken: string | null = null;

  private dropWindow: DropWindowEntry[] = [];
  private degradedSinceMs: number | null = null;
  private evaluateTimer: ReturnType<typeof setInterval> | null = null;
  private lockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BroadcastControllerOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  get state(): BroadcastState {
    return this._state;
  }

  private transition(state: BroadcastState): void {
    this._state = state;
    this.options.onStateChange?.(state);
  }

  private emitEvent(type: EventType, detail?: string): void {
    this.options.onEvent?.({ occurredAt: this.nowMs(), type, detail });
  }

  /** 配信を開始する（requirements.md 16.1節シーケンス図に対応）。 */
  async start(input: StartInput): Promise<void> {
    if (this._state !== "idle") {
      return;
    }
    this.transition("preparing");

    const lockAcquired = await this.options.tabLockGuard.acquire();
    if (!lockAcquired) {
      this.emitEvent("duplicate_broadcast_blocked", "他のタブで配信中のため開始できません");
      this.transition("idle");
      return;
    }

    try {
      const broadcast = await this.options.apiClient.createBroadcast({
        title: input.title,
        layoutPreset: input.layoutPreset,
      });
      this.broadcastId = broadcast.id;
      this.broadcastToken = broadcast.broadcastToken;
    } catch (err) {
      this.options.tabLockGuard.release();
      if (err instanceof BroadcastApiError && err.status === 409) {
        this.emitEvent("duplicate_broadcast_blocked", "既存の配信があるため開始できません");
      } else {
        this.emitEvent("broadcast_failed", err instanceof Error ? err.message : String(err));
      }
      this.transition("failed");
      this.transition("ended");
      return;
    }

    this.transition("ready");
    this.emitEvent("broadcast_started", this.broadcastId ?? undefined);

    this.transition("connecting");
    this.options.transport.connect(this.options.sessionKey, this.broadcastToken!, input.profile);

    this.startLockHeartbeatLoop();
    this.startEvaluateLoop();
  }

  /** TransportChannel.onOpen(isReconnect)からのブリッジ。 */
  handleTransportOpen(isReconnect: boolean): void {
    this.options.onResendConfig?.();
    if (isReconnect) {
      this.options.onForceKeyframe?.();
      this.emitEvent("reconnected", "再接続しました");
    }
    if (this._state !== "stopping" && this._state !== "ended") {
      this.transition("live");
      this.degradedSinceMs = null;
    }
  }

  /** TransportChannel.onCloseからのブリッジ。 */
  handleTransportClose(): void {
    if (this._state === "stopping" || this._state === "ended" || this._state === "failed") {
      return;
    }
    this.transition("reconnecting");
    this.emitEvent("reconnecting", "接続が切断されました。再接続を試みます");
  }

  /** TransportChannel.onReconnectFailedからのブリッジ。 */
  handleReconnectFailed(): void {
    this.emitEvent("reconnect_failed", "再接続の試行が規定時間を超えました");
    this.finishAsFailed("reconnect_timeout");
  }

  /** TransportChannel.onControlからのブリッジ。 */
  handleControl(message: ControlMessage): void {
    switch (message.type) {
      case "keyframe_request":
        this.options.onForceKeyframe?.();
        this.emitEvent("keyframe_requested");
        break;
      case "throttle":
        this.options.governor.applyThrottle(message.targetBitrateKbps);
        this.emitEvent("throttled", `中継からの抑制指示: ${message.targetBitrateKbps}kbps`);
        break;
      case "fatal":
        this.emitEvent("broadcast_failed", message.reason);
        void this.stop(message.reason);
        break;
      case "ack":
      case "start":
      case "status":
      case "end":
        break;
    }
  }

  /** ロックの生存通知が失敗した場合（既にロックが失効している等）に呼ぶ。 */
  onLockLost(): void {
    this.emitEvent("lock_lost", "配信ロックが失われました");
    void this.stop("lock_lost");
  }

  private startLockHeartbeatLoop(): void {
    this.lockHeartbeatTimer = this.setIntervalFn(async () => {
      try {
        this.options.tabLockGuard.heartbeat();
        if (this.broadcastId) {
          await this.options.apiClient.lockHeartbeat(this.broadcastId);
        }
      } catch {
        this.onLockLost();
      }
    }, LOCK_HEARTBEAT_INTERVAL_MS);
  }

  private startEvaluateLoop(): void {
    this.evaluateTimer = this.setIntervalFn(() => this.evaluateTick(), EVALUATE_INTERVAL_MS);
  }

  private stopLoops(): void {
    if (this.evaluateTimer !== null) {
      this.clearIntervalFn(this.evaluateTimer);
      this.evaluateTimer = null;
    }
    if (this.lockHeartbeatTimer !== null) {
      this.clearIntervalFn(this.lockHeartbeatTimer);
      this.lockHeartbeatTimer = null;
    }
  }

  private recordDrops(now: number, count: number): void {
    if (count <= 0) {
      return;
    }
    this.dropWindow.push({ atMs: now, count });
    this.dropWindow = this.dropWindow.filter((e) => now - e.atMs <= DROP_WINDOW_MS);
  }

  private dropsInWindow(now: number): number {
    this.dropWindow = this.dropWindow.filter((e) => now - e.atMs <= DROP_WINDOW_MS);
    return this.dropWindow.reduce((sum, e) => sum + e.count, 0);
  }

  /**
   * 毎秒の適応制御評価（requirements.md 7節・8節）。
   * - 滞留>4000ms: 非キーフレーム映像を破棄
   * - 滞留>8000ms: 劣化状態へ。既定10秒継続で再接続へ
   */
  private evaluateTick(): void {
    if (this._state !== "live" && this._state !== "degraded") {
      return;
    }
    const now = this.nowMs();
    const queueDelayMs = this.options.sendQueue.queueDelayMs(now);
    const dropsInLast10s = this.dropsInWindow(now);

    const target = this.options.governor.evaluate({ queueDelayMs, dropsInLast10s, nowMs: now });
    this.options.onBitrateChange?.(target);

    if (queueDelayMs > QUEUE_DROP_THRESHOLD_MS) {
      const dropped = this.options.sendQueue.dropNonKeyVideo();
      if (dropped > 0) {
        this.recordDrops(now, dropped);
      }
    }

    const degradedSustainMs = this.options.degradedSustainMs ?? DEGRADED_THRESHOLD_MS + 2000;

    if (queueDelayMs > DEGRADED_THRESHOLD_MS) {
      if (this._state === "live") {
        this.transition("degraded");
        this.degradedSinceMs = now;
        this.emitEvent("degraded", `滞留時間が${queueDelayMs}msに達しました`);
      } else if (this._state === "degraded" && this.degradedSinceMs !== null) {
        if (now - this.degradedSinceMs >= degradedSustainMs) {
          this.emitEvent("reconnecting", "劣化状態が規定時間継続したため再接続します");
          this.transition("reconnecting");
          this.options.transport.reconnectNow();
        }
      }
    } else if (this._state === "degraded") {
      this.transition("live");
      this.degradedSinceMs = null;
      this.emitEvent("recovered", "滞留時間が回復しました");
    }

    this.options.transport.sendControl({
      type: "status",
      queueDelayMs,
      droppedFrames: dropsInLast10s,
      targetBitrateKbps: target,
    });
  }

  /** 配信を停止する（利用者操作・日次リセット・致命エラーいずれも経由する）。 */
  async stop(reason = "user_stopped"): Promise<void> {
    if (this._state === "ended" || this._state === "stopping") {
      return;
    }
    this.transition("stopping");
    this.stopLoops();
    this.options.transport.close(reason);

    if (this.broadcastId) {
      try {
        await this.options.apiClient.stopBroadcast(this.broadcastId, reason);
      } catch {
        // 停止APIが失敗しても配信は終了扱いにする（デモ版のため復旧は行わない）
      }
    }
    this.options.tabLockGuard.release();
    this.emitEvent("broadcast_stopped", reason);
    this.transition("ended");
  }

  private finishAsFailed(reason: string): void {
    this.stopLoops();
    this.options.transport.close(reason);
    this.options.tabLockGuard.release();
    this.transition("failed");
    this.emitEvent("broadcast_failed", reason);
    this.transition("ended");
  }
}
