import { BroadcastApiClient, BroadcastApiError } from "./broadcastApiClient";

function mockFetch(response: { status: number; json?: unknown }) {
  return jest.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.json,
  } as unknown as Response);
}

describe("BroadcastApiClient", () => {
  it("createBroadcastはCookieセッションスコープでPOSTし、リクエストbodyをsnake_caseに変換して送信する（backendはRails慣習に従うため）", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: {
        id: "b1",
        broadcast_token: "tok1",
        state: "preparing",
        title: "テスト配信",
        layout_preset: "standard",
        started_at: null,
        session_key: "sess-abc",
      },
    });
    const client = new BroadcastApiClient({ baseUrl: "http://relay.example", fetchFn });

    const result = await client.createBroadcast({ title: "テスト配信", layoutPreset: "standard" });

    expect(fetchFn).toHaveBeenCalledWith(
      "http://relay.example/api/broadcasts",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ title: "テスト配信", layout_preset: "standard" }),
      }),
    );
    expect(result).toMatchObject({
      id: "b1",
      broadcastToken: "tok1",
      layoutPreset: "standard",
      sessionKey: "sess-abc",
    });
  });

  it("createBroadcastはhpField（ハニーポット欄）をhp_fieldとして送信する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: { id: "b1", broadcast_token: "tok1", state: "preparing", title: null, layout_preset: "standard", started_at: null, session_key: "sess-1" },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    await client.createBroadcast({ layoutPreset: "standard", hpField: "" });

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/broadcasts",
      expect.objectContaining({
        body: JSON.stringify({ layout_preset: "standard", hp_field: "" }),
      }),
    );
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

  it("getAudienceは擬似視聴者数・擬似チャットをsnake_caseレスポンスから変換して取得する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: {
        viewer_count: 42,
        elapsed_seconds: 10,
        simulated: true,
        messages: [{ author_label: "視聴者A", origin: "simulated", body: "こんにちは", posted_at: "2026-01-01T00:00:00Z" }],
      },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    const audience = await client.getAudience("b1");

    expect(audience.viewerCount).toBe(42);
    expect(audience.messages[0]).toMatchObject({ authorLabel: "視聴者A", postedAt: "2026-01-01T00:00:00Z" });
  });

  it("postChatは配信者本人の投稿として送信する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: { id: "m1", author_label: "配信者", origin: "broadcaster", body: "こんにちは", posted_at: "" },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    const message = await client.postChat("b1", "こんにちは");

    expect(message.origin).toBe("broadcaster");
    expect(message.authorLabel).toBe("配信者");
  });

  it("getEventsはbackendが返す{ events: [...] }を配列に展開し、キーをcamelCaseへ変換する", async () => {
    const fetchFn = mockFetch({
      status: 200,
      json: { events: [{ event_type: "reconnecting", detail: null, occurred_at: "2026-01-01T00:00:00Z" }] },
    });
    const client = new BroadcastApiClient({ baseUrl: "", fetchFn });

    const events = await client.getEvents("b1");

    expect(events).toEqual([{ eventType: "reconnecting", detail: null, occurredAt: "2026-01-01T00:00:00Z" }]);
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
