// Package backendclient は、中継層（Gin）からアプリケーション層（Rails）の
// 内部APIを呼び出すHTTPクライアントです。
//
// 呼び出し先エンドポイントは、本タスクを割り振ったオーケストレーターが
// 定義した内部契約（issue本文参照）に基づきます。requirements.md 自体には
// 具体的なエンドポイント定義がないため、この契約はチーム間の取り決めです。
//
// backend（Rails）は並行して別チームが実装中であり、本パッケージの
// 単体テストは httptest でモックしたサーバーに対して行います。
// 実際のbackendとの結合確認は別issueで行います。
package backendclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultTimeout はbackend呼び出し1回あたりのタイムアウトです。
// 中継層は自プロセス内の通信のみを行う設計であり（21節: 外部通信を行わない）、
// backendとの通信も同一システム内の内部通信であるため、短いタイムアウトで
// 十分応答が返る前提とします。
const DefaultTimeout = 3 * time.Second

// VerifyResult は開始通知の照合結果です（6.6節要件）。
type VerifyResult struct {
	Valid       bool   `json:"valid"`
	BroadcastID string `json:"broadcast_id"`
}

// HealthSample は健全性サンプル1件です（7節・16.2節）。
type HealthSample struct {
	QueueMs            int64  `json:"queue_ms"`
	SentBitrateKbps    int    `json:"sent_bitrate_kbps"`
	TargetBitrateKbps  int    `json:"target_bitrate_kbps"`
	DroppedVideoFrames int64  `json:"dropped_video_frames"`
	DroppedAudioFrames int64  `json:"dropped_audio_frames"`
	State              string `json:"state"`
}

// Client はbackend内部APIの呼び出しを抽象化します。
// テスト時にモック実装へ差し替えられるよう、インターフェースとして定義します。
type Client interface {
	// Verify は開始通知のセッションキー・配信トークンの組を照合します（6.6節要件）。
	Verify(ctx context.Context, sessionKey, broadcastToken string) (VerifyResult, error)
	// ReportHealth は健全性サンプルを記録します。
	ReportHealth(ctx context.Context, broadcastID string, sample HealthSample) error
	// ReportEvent は配信中に発生した事象を記録します。
	ReportEvent(ctx context.Context, broadcastID string, eventType string, detail string) error
	// Finish は配信の終了を記録します。
	Finish(ctx context.Context, broadcastID string, reason string) error
}

// HTTPClient は Client の実装です。
type HTTPClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewHTTPClient は baseURL（例: "http://backend:3001"）を対象とするクライアントを生成します。
func NewHTTPClient(baseURL string) *HTTPClient {
	return &HTTPClient{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: DefaultTimeout},
	}
}

func (c *HTTPClient) postJSON(ctx context.Context, path string, reqBody interface{}, respBody interface{}) error {
	var buf bytes.Buffer
	if reqBody != nil {
		if err := json.NewEncoder(&buf).Encode(reqBody); err != nil {
			return fmt.Errorf("backendclient: encode request: %w", err)
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, &buf)
	if err != nil {
		return fmt.Errorf("backendclient: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("backendclient: request to %s failed: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("backendclient: %s returned status %d: %s", path, resp.StatusCode, string(body))
	}

	if respBody != nil {
		if err := json.NewDecoder(resp.Body).Decode(respBody); err != nil {
			return fmt.Errorf("backendclient: decode response from %s: %w", path, err)
		}
	}

	return nil
}

func (c *HTTPClient) Verify(ctx context.Context, sessionKey, broadcastToken string) (VerifyResult, error) {
	reqBody := struct {
		SessionKey     string `json:"session_key"`
		BroadcastToken string `json:"broadcast_token"`
	}{SessionKey: sessionKey, BroadcastToken: broadcastToken}

	var result VerifyResult
	if err := c.postJSON(ctx, "/internal/broadcasts/verify", reqBody, &result); err != nil {
		return VerifyResult{}, err
	}
	return result, nil
}

func (c *HTTPClient) ReportHealth(ctx context.Context, broadcastID string, sample HealthSample) error {
	path := fmt.Sprintf("/internal/broadcasts/%s/health_samples", broadcastID)
	return c.postJSON(ctx, path, sample, nil)
}

func (c *HTTPClient) ReportEvent(ctx context.Context, broadcastID string, eventType string, detail string) error {
	reqBody := struct {
		EventType string `json:"event_type"`
		Detail    string `json:"detail"`
	}{EventType: eventType, Detail: detail}
	path := fmt.Sprintf("/internal/broadcasts/%s/events", broadcastID)
	return c.postJSON(ctx, path, reqBody, nil)
}

func (c *HTTPClient) Finish(ctx context.Context, broadcastID string, reason string) error {
	reqBody := struct {
		Reason string `json:"reason"`
	}{Reason: reason}
	path := fmt.Sprintf("/internal/broadcasts/%s/finish", broadcastID)
	return c.postJSON(ctx, path, reqBody, nil)
}

var _ Client = (*HTTPClient)(nil)
