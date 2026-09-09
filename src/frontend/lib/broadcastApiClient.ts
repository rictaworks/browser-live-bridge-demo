// 配信者向けAPI（/api/broadcasts/**）のfetchラッパー（オーケストレーターが
// 定義したAPI契約に準拠）。Cookieセッションスコープで動作するため、
// すべてのリクエストにcredentials: "include"を付与する。
//
// backend（Rails）は並行して別チームが実装中のため、実際の疎通確認は
// issue #4で行う。ここでは契約通りのリクエスト/レスポンス整形と、
// エラーハンドリング（特に409＝ロック取得失敗）をユニットテストで担保する。

import type { SourceKind, SourceRole } from "./types";

// backend（Rails）はJSONのキーをsnake_caseで送受信する。フロントエンドの
// 型定義はTypeScriptの慣習に合わせcamelCaseで統一しているため、通信の
// 境界であるこの層でのみ相互変換する（バックエンド・フロントエンドいずれの
// コードにも大文字小文字変換の責務を持ち込まない）。
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function convertKeysDeep(value: unknown, convertKey: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeysDeep(item, convertKey));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        convertKey(key),
        convertKeysDeep(v, convertKey),
      ]),
    );
  }
  return value;
}

export class BroadcastApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BroadcastApiError";
    this.status = status;
  }
}

export interface Broadcast {
  id: string;
  broadcastToken: string;
  state: string;
  title: string | null;
  layoutPreset: string;
  startedAt: string | null;
  /** 中継サーバーへのWebSocket開始通知に使う、配信者本人のセッションキー（backendが応答に含める）。 */
  sessionKey: string;
}

export interface CreateBroadcastInput {
  title?: string;
  layoutPreset: string;
  /** ハニーポット欄（requirements.md 21節）。人間の利用者は空のまま送信する。 */
  hpField?: string;
}

export interface AddSourceInput {
  kind: SourceKind;
  role: SourceRole;
  enabled: boolean;
}

export interface ChatMessage {
  id: string;
  authorLabel: string;
  origin: "simulated" | "broadcaster";
  body: string;
  postedAt: string;
}

export interface AudienceInfo {
  viewerCount: number;
  messages: ChatMessage[];
}

export interface BroadcastEventRecord {
  occurredAt: string;
  eventType: string;
  detail?: string;
}

export interface BroadcastApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class BroadcastApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BroadcastApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(convertKeysDeep(init.body, camelToSnakeKey)) : undefined,
    });

    if (!response.ok) {
      const message = await this.safeErrorMessage(response);
      throw new BroadcastApiError(response.status, message);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const body = await response.json();
    return convertKeysDeep(body, snakeToCamelKey) as T;
  }

  private async safeErrorMessage(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as { error?: string };
      return data.error ?? `request failed with status ${response.status}`;
    } catch {
      return `request failed with status ${response.status}`;
    }
  }

  /** 配信作成＋配信ロック取得。ロック取得失敗時はstatus=409のBroadcastApiErrorを送出する。 */
  createBroadcast(input: CreateBroadcastInput): Promise<Broadcast> {
    return this.request<Broadcast>("/api/broadcasts", { method: "POST", body: input });
  }

  addSource(broadcastId: string, input: AddSourceInput): Promise<void> {
    return this.request<void>(`/api/broadcasts/${broadcastId}/sources`, {
      method: "POST",
      body: input,
    });
  }

  lockHeartbeat(broadcastId: string): Promise<void> {
    return this.request<void>(`/api/broadcasts/${broadcastId}/lock/heartbeat`, {
      method: "POST",
    });
  }

  stopBroadcast(broadcastId: string, reason?: string): Promise<void> {
    return this.request<void>(`/api/broadcasts/${broadcastId}/stop`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
    });
  }

  getBroadcast(broadcastId: string): Promise<Broadcast> {
    return this.request<Broadcast>(`/api/broadcasts/${broadcastId}`);
  }

  getAudience(broadcastId: string): Promise<AudienceInfo> {
    return this.request<AudienceInfo>(`/api/broadcasts/${broadcastId}/audience`);
  }

  postChat(broadcastId: string, body: string): Promise<ChatMessage> {
    return this.request<ChatMessage>(`/api/broadcasts/${broadcastId}/chat`, {
      method: "POST",
      body: { body },
    });
  }

  async getEvents(broadcastId: string): Promise<BroadcastEventRecord[]> {
    const { events } = await this.request<{ events: BroadcastEventRecord[] }>(
      `/api/broadcasts/${broadcastId}/events`,
    );
    return events;
  }
}
