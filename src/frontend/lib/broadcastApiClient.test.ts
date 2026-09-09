import { BroadcastApiClient, BroadcastApiError } from "./broadcastApiClient";

function mockFetch(response: { status: number; json?: unknown }) {
  return jest.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.json,
  } as unknown as Response);
}

describe("BroadcastApiClient", () => {
  it("createBroadcastはCookieセッションスコープでPOSTし、レスポンスをそのまま返す", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: {
        id: "b1",
        broadcastToken: "tok1",
        state: "preparing",
        title: "テスト配信",
        layoutPreset: "standard",
        startedAt: null,
      },
    });
    const client = new BroadcastApiClient({ baseUrl: "http://relay.example", fetchFn });

    const result = await client.createBroadcast({ title: "テスト配信", layoutPreset: "standard" });

    expect(fetchFn).toHaveBeenCalledWith(
      "http://relay.example/api/broadcasts",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ title: "テスト配信", layoutPreset: "standard" }),
      }),
    );
    expect(result.id).toBe("b1");
  });

  it("配信ロック取得失敗（409）はBroadcastApiErrorとして送出される", async () => {
    const fetchFn = mockFetch({ status: 409, json: { error: "既存配信あり" } });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await expect(
      client.createBroadcast({ layoutPreset: "standard" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.createBroadcast({ layoutPreset: "standard" }),
    ).rejects.toBeInstanceOf(BroadcastApiError);
  });

  it("addSourceは正しいパスとbodyでPOSTする", async () => {
    const fetchFn = mockFetch({ status: 204 });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await client.addSource("b1", { kind: "camera", role: "wipe", enabled: true });

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/broadcasts/b1/sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "camera", role: "wipe", enabled: true }),
      }),
    );
  });

  it("lockHeartbeatは配信IDに対してハートビートを送信する", async () => {
    const fetchFn = mockFetch({ status: 204 });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await client.lockHeartbeat("b1");

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/broadcasts/b1/lock/heartbeat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stopBroadcastはreasonを省略できる", async () => {
    const fetchFn = mockFetch({ status: 204 });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await client.stopBroadcast("b1");

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/broadcasts/b1/stop",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it("getAudienceは擬似視聴者数・擬似チャットを取得する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: { viewerCount: 42, messages: [] },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    const audience = await client.getAudience("b1");

    expect(audience.viewerCount).toBe(42);
  });

  it("postChatは配信者本人の投稿として送信する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: { id: "m1", authorLabel: "配信者", origin: "broadcaster", body: "こんにちは", postedAt: "" },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    const message = await client.postChat("b1", "こんにちは");

    expect(message.origin).toBe("broadcaster");
  });

  it("エラーレスポンスのJSON解析に失敗しても汎用メッセージでBroadcastApiErrorを送出する", async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response);
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await expect(client.getEvents("b1")).rejects.toMatchObject({ status: 500 });
  });
});
