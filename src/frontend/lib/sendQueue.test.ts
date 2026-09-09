import { SendQueue, type SendQueueItem } from "./sendQueue";

function makeItem(
  overrides: Partial<SendQueueItem> & { enqueuedAtMs: number },
): SendQueueItem {
  return {
    type: "video",
    keyframe: false,
    timestampUs: 0,
    payload: new Uint8Array(),
    ...overrides,
  };
}

describe("SendQueue", () => {
  it("空のキューの滞留時間は0", () => {
    const queue = new SendQueue();
    expect(queue.queueDelayMs(10_000)).toBe(0);
  });

  it("滞留時間は最古のフレームの経過時間で算出される", () => {
    const queue = new SendQueue();
    queue.enqueue(makeItem({ enqueuedAtMs: 1000 }));
    queue.enqueue(makeItem({ enqueuedAtMs: 1500 }));

    expect(queue.queueDelayMs(2500)).toBe(1500);
  });

  it("dropNonKeyVideoは非キーフレームの映像のみを破棄し、音声とキーフレームは残す", () => {
    const queue = new SendQueue();
    queue.enqueue(makeItem({ type: "video", keyframe: false, enqueuedAtMs: 1 }));
    queue.enqueue(makeItem({ type: "audio", keyframe: false, enqueuedAtMs: 2 }));
    queue.enqueue(makeItem({ type: "video", keyframe: true, enqueuedAtMs: 3 }));
    queue.enqueue(makeItem({ type: "video", keyframe: false, enqueuedAtMs: 4 }));
    queue.enqueue(makeItem({ type: "control", keyframe: false, enqueuedAtMs: 5 }));

    const dropped = queue.dropNonKeyVideo();

    expect(dropped).toBe(2);
    expect(queue.size).toBe(3);
    const remainingTypes = queue.drainAll().map((i) => `${i.type}:${i.keyframe}`);
    expect(remainingTypes).toEqual(["audio:false", "video:true", "control:false"]);
  });

  it("dropNonKeyVideoは破棄件数を累積して報告する", () => {
    const queue = new SendQueue();
    queue.enqueue(makeItem({ type: "video", keyframe: false, enqueuedAtMs: 1 }));
    queue.dropNonKeyVideo();
    queue.enqueue(makeItem({ type: "video", keyframe: false, enqueuedAtMs: 2 }));
    queue.dropNonKeyVideo();

    expect(queue.droppedVideoFrames).toBe(2);
  });

  it("drainは先入れ先出しでアイテムを返す", () => {
    const queue = new SendQueue();
    queue.enqueue(makeItem({ enqueuedAtMs: 1, timestampUs: 100 }));
    queue.enqueue(makeItem({ enqueuedAtMs: 2, timestampUs: 200 }));

    expect(queue.drain()?.timestampUs).toBe(100);
    expect(queue.drain()?.timestampUs).toBe(200);
    expect(queue.drain()).toBeUndefined();
  });

  it("音声フレームだけのキューはdropNonKeyVideoの影響を受けない", () => {
    const queue = new SendQueue();
    queue.enqueue(makeItem({ type: "audio", enqueuedAtMs: 1 }));
    queue.enqueue(makeItem({ type: "audio", enqueuedAtMs: 2 }));

    const dropped = queue.dropNonKeyVideo();

    expect(dropped).toBe(0);
    expect(queue.size).toBe(2);
  });
});
