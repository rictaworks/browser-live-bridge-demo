import { TabLockGuard } from "./tabLockGuard";

// 実際のBroadcastChannel（Node.js組み込み実装。jest.setup.tsでグローバルに補完）を
// 使い、同一チャンネル名の複数インスタンス間での排他をテストする。

const CHANNEL = (name: string) => `test-lock-${name}-${Math.random()}`;

describe("TabLockGuard", () => {
  it("他タブが存在しなければロックを取得できる", async () => {
    const channelName = CHANNEL("solo");
    const guard = new TabLockGuard({ channelName, queryTimeoutMs: 20 });

    const acquired = await guard.acquire();

    expect(acquired).toBe(true);
    expect(guard.isHeldByThisTab).toBe(true);

    guard.release();
    guard.close();
  });

  it("既に他タブがロックを保持している場合は取得に失敗する", async () => {
    const channelName = CHANNEL("exclusive");
    const guardA = new TabLockGuard({ channelName, queryTimeoutMs: 20, tabId: "A" });
    const guardB = new TabLockGuard({ channelName, queryTimeoutMs: 20, tabId: "B" });

    const acquiredA = await guardA.acquire();
    expect(acquiredA).toBe(true);

    const acquiredB = await guardB.acquire();
    expect(acquiredB).toBe(false);

    guardA.release();
    guardA.close();
    guardB.close();
  });

  it("releaseすると他タブが取得できるようになる", async () => {
    const channelName = CHANNEL("release");
    const guardA = new TabLockGuard({ channelName, queryTimeoutMs: 20, tabId: "A" });
    const guardB = new TabLockGuard({ channelName, queryTimeoutMs: 20, tabId: "B" });

    await guardA.acquire();
    guardA.release();

    // releaseの伝搬を待つ
    await new Promise((r) => setTimeout(r, 10));

    const acquiredB = await guardB.acquire();
    expect(acquiredB).toBe(true);

    guardB.release();
    guardA.close();
    guardB.close();
  });

  it("生存通知（heartbeat）が途絶えたホルダーは失効とみなし、新規タブが取得できる", async () => {
    const channelName = CHANNEL("stale");
    let now = 0;
    const guardA = new TabLockGuard({
      channelName,
      queryTimeoutMs: 20,
      tabId: "A",
      staleAfterMs: 1000,
      nowMs: () => now,
    });
    const guardB = new TabLockGuard({
      channelName,
      queryTimeoutMs: 20,
      tabId: "B",
      staleAfterMs: 1000,
      nowMs: () => now,
    });

    await guardA.acquire(); // claimedAtMs = 0 として記録される

    now = 2000; // ハートビートが1000ms以上途絶えた状態を模擬
    const acquiredB = await guardB.acquire();

    expect(acquiredB).toBe(true);

    guardA.close();
    guardB.close();
  });

  it("heartbeatを送り続けている間は他タブがstale扱いで取得することはない", async () => {
    const channelName = CHANNEL("heartbeat");
    let now = 0;
    const guardA = new TabLockGuard({
      channelName,
      queryTimeoutMs: 20,
      tabId: "A",
      staleAfterMs: 1000,
      nowMs: () => now,
    });
    const guardB = new TabLockGuard({
      channelName,
      queryTimeoutMs: 20,
      tabId: "B",
      staleAfterMs: 1000,
      nowMs: () => now,
    });

    await guardA.acquire();
    now = 900;
    guardA.heartbeat();
    now = 1500; // heartbeat基準からはまだ1000ms未満

    const acquiredB = await guardB.acquire();
    expect(acquiredB).toBe(false);

    guardA.release();
    guardA.close();
    guardB.close();
  });
});
