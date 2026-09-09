// タブ間排他制御（requirements.md 9節）。
//
// 「同一ブラウザの複数タブから同時に配信が開始されないよう、タブ間で排他を
// 取る」ための、BroadcastChannelを用いたブラウザタブレベルのガード。
//
// これはあくまでUXレベルの排他であり、真の一意性はbackendの配信ロック
// （POST /api/broadcasts が返す409等）で担保する。本ガードは、ロック取得の
// APIを叩く前に「他タブが既に配信中らしい」ことを検知して、無駄な開始操作を
// 未然に防ぐためのものである。

export interface LockClaim {
  tabId: string;
  claimedAtMs: number;
}

type LockMessage =
  | { kind: "query"; tabId: string }
  | { kind: "claim"; tabId: string; claimedAtMs: number }
  | { kind: "release"; tabId: string }
  | { kind: "heartbeat"; tabId: string; atMs: number };

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  set onmessage(handler: ((event: { data: unknown }) => void) | null);
  close(): void;
}

export type BroadcastChannelCtor = new (name: string) => BroadcastChannelLike;

export interface TabLockGuardOptions {
  channelName?: string;
  tabId?: string;
  /** 他タブからの応答を待つ時間(ms)。既定200ms。 */
  queryTimeoutMs?: number;
  /** この時間(ms)ハートビートが途絶えたホルダーは失効とみなす。既定8000ms。 */
  staleAfterMs?: number;
  BroadcastChannelCtor?: BroadcastChannelCtor;
  nowMs?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

function randomTabId(): string {
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export class TabLockGuard {
  readonly tabId: string;
  private readonly channel: BroadcastChannelLike;
  private readonly queryTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly nowMs: () => number;
  private readonly setTimeoutFn: NonNullable<TabLockGuardOptions["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<TabLockGuardOptions["clearTimeoutFn"]>;

  private holder: LockClaim | null = null;
  private heldByThisTab = false;

  constructor(options: TabLockGuardOptions = {}) {
    this.tabId = options.tabId ?? randomTabId();
    this.queryTimeoutMs = options.queryTimeoutMs ?? 200;
    this.staleAfterMs = options.staleAfterMs ?? 8000;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));

    const Ctor = options.BroadcastChannelCtor ?? (globalThis as { BroadcastChannel?: BroadcastChannelCtor }).BroadcastChannel;
    if (!Ctor) {
      throw new Error("BroadcastChannel未対応の環境です");
    }
    this.channel = new Ctor(options.channelName ?? "browser-live-bridge-broadcast-lock");
    this.channel.onmessage = (event) => this.handleMessage(event.data as LockMessage);
  }

  private handleMessage(message: LockMessage): void {
    switch (message.kind) {
      case "query":
        if (this.heldByThisTab) {
          this.channel.postMessage({
            kind: "claim",
            tabId: this.tabId,
            claimedAtMs: this.holder?.claimedAtMs ?? this.nowMs(),
          } satisfies LockMessage);
        }
        break;
      case "claim":
        if (message.tabId !== this.tabId) {
          this.holder = { tabId: message.tabId, claimedAtMs: message.claimedAtMs };
        }
        break;
      case "heartbeat":
        if (message.tabId !== this.tabId) {
          this.holder = { tabId: message.tabId, claimedAtMs: message.atMs };
        }
        break;
      case "release":
        if (this.holder?.tabId === message.tabId) {
          this.holder = null;
        }
        break;
    }
  }

  /**
   * ロックの取得を試みる。他タブに現在生存中のホルダーがいれば失敗する。
   * 他タブの応答を待つため、非同期（queryTimeoutMs待機）。
   */
  async acquire(): Promise<boolean> {
    if (this.heldByThisTab) {
      return true;
    }

    this.holder = null;
    this.channel.postMessage({ kind: "query", tabId: this.tabId } satisfies LockMessage);

    await new Promise<void>((resolve) => {
      this.setTimeoutFn(resolve, this.queryTimeoutMs);
    });

    // this.holderはawait前に一度nullへ代入しているが、await中に
    // handleMessage経由で再代入されうるため、TypeScriptの型絞り込みに
    // 頼らず明示的にLockClaim | nullとして読み直す。
    const observedHolder = this.holder as LockClaim | null;
    if (observedHolder !== null && this.nowMs() - observedHolder.claimedAtMs < this.staleAfterMs) {
      return false; // 既に他タブが生存保持中
    }

    this.holder = { tabId: this.tabId, claimedAtMs: this.nowMs() };
    this.heldByThisTab = true;
    this.channel.postMessage({
      kind: "claim",
      tabId: this.tabId,
      claimedAtMs: this.holder.claimedAtMs,
    } satisfies LockMessage);
    return true;
  }

  /** 生存通知。定期的に呼び出すこと（requirements.md 9節）。 */
  heartbeat(): void {
    if (!this.heldByThisTab) {
      return;
    }
    const atMs = this.nowMs();
    this.holder = { tabId: this.tabId, claimedAtMs: atMs };
    this.channel.postMessage({ kind: "heartbeat", tabId: this.tabId, atMs } satisfies LockMessage);
  }

  release(): void {
    if (!this.heldByThisTab) {
      return;
    }
    this.channel.postMessage({ kind: "release", tabId: this.tabId } satisfies LockMessage);
    this.heldByThisTab = false;
    this.holder = null;
  }

  get isHeldByThisTab(): boolean {
    return this.heldByThisTab;
  }

  close(): void {
    this.channel.close();
  }
}
