// 送信待ちキュー（requirements.md 7節）。
//
// - 滞留時間＝キュー内最古のフレームが積まれてからの経過時間
// - 音声フレーム・キーフレームは破棄対象としない
// - 滞留時間が4000msを超えたら、非キーフレームの映像を古い順に破棄する

export interface SendQueueItem {
  type: "video" | "audio" | "control";
  keyframe: boolean;
  timestampUs: number;
  enqueuedAtMs: number;
  payload: Uint8Array;
}

export class SendQueue {
  private items: SendQueueItem[] = [];
  private droppedVideoFrameCount = 0;

  enqueue(item: SendQueueItem): void {
    this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  get droppedVideoFrames(): number {
    return this.droppedVideoFrameCount;
  }

  /**
   * 現在の滞留時間（ms）。キューが空であれば0を返す。
   * 「送信待ちキューに積まれた最古のフレームが待機している時間」（requirements.md 3節）。
   */
  queueDelayMs(nowMs: number): number {
    if (this.items.length === 0) {
      return 0;
    }
    const oldest = this.items[0];
    return Math.max(0, nowMs - oldest.enqueuedAtMs);
  }

  /**
   * キュー内の非キーフレーム映像を古い順にすべて破棄する。
   * 音声フレーム・キーフレームは対象外（requirements.md 7節）。
   * 破棄した件数を返す。
   */
  dropNonKeyVideo(): number {
    const before = this.items.length;
    this.items = this.items.filter(
      (item) => !(item.type === "video" && !item.keyframe),
    );
    const dropped = before - this.items.length;
    this.droppedVideoFrameCount += dropped;
    return dropped;
  }

  /**
   * 先頭のフレームを取り出す（送信のため）。空であればundefined。
   */
  drain(): SendQueueItem | undefined {
    return this.items.shift();
  }

  /** キュー内の全アイテムを送信順に取り出しつつ、キューを空にする。 */
  drainAll(): SendQueueItem[] {
    const all = this.items;
    this.items = [];
    return all;
  }

  clear(): void {
    this.items = [];
  }
}
