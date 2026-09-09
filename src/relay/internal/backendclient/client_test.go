package backendclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVerifySendsExpectedRequestAndParsesResponse(t *testing.T) {
	var gotPath string
	var gotBody map[string]string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(VerifyResult{Valid: true, BroadcastID: "b-123"})
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL)
	result, err := c.Verify(context.Background(), "sess-1", "tok-1")
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}

	if gotPath != "/internal/broadcasts/verify" {
		t.Errorf("path = %q, want /internal/broadcasts/verify", gotPath)
	}
	if gotBody["session_key"] != "sess-1" || gotBody["broadcast_token"] != "tok-1" {
		t.Errorf("request body = %+v", gotBody)
	}
	if !result.Valid || result.BroadcastID != "b-123" {
		t.Errorf("result = %+v", result)
	}
}

func TestVerifyReturnsErrorOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL)
	if _, err := c.Verify(context.Background(), "s", "t"); err == nil {
		t.Fatal("expected error on non-2xx response")
	}
}

func TestVerifyReturnsErrorWhenBackendUnreachable(t *testing.T) {
	c := NewHTTPClient("http://127.0.0.1:1") // 到達不能なポート
	if _, err := c.Verify(context.Background(), "s", "t"); err == nil {
		t.Fatal("expected error when backend is unreachable")
	}
}

func TestReportHealthSendsToCorrectPath(t *testing.T) {
	var gotPath string
	var gotBody HealthSample

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL)
	sample := HealthSample{
		QueueMs:            1200,
		SentBitrateKbps:    2000,
		TargetBitrateKbps:  2500,
		DroppedVideoFrames: 3,
		DroppedAudioFrames: 0,
		State:              "live",
	}
	if err := c.ReportHealth(context.Background(), "b-42", sample); err != nil {
		t.Fatalf("ReportHealth() error = %v", err)
	}

	if gotPath != "/internal/broadcasts/b-42/health_samples" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody != sample {
		t.Errorf("body = %+v, want %+v", gotBody, sample)
	}
}

func TestReportEventSendsToCorrectPath(t *testing.T) {
	var gotPath string
	var gotBody map[string]string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL)
	if err := c.ReportEvent(context.Background(), "b-42", "degraded", "queue delay exceeded"); err != nil {
		t.Fatalf("ReportEvent() error = %v", err)
	}

	if gotPath != "/internal/broadcasts/b-42/events" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["event_type"] != "degraded" || gotBody["detail"] != "queue delay exceeded" {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestFinishSendsToCorrectPath(t *testing.T) {
	var gotPath string
	var gotBody map[string]string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL)
	if err := c.Finish(context.Background(), "b-42", "user_stopped"); err != nil {
		t.Fatalf("Finish() error = %v", err)
	}

	if gotPath != "/internal/broadcasts/b-42/finish" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["reason"] != "user_stopped" {
		t.Errorf("body = %+v", gotBody)
	}
}
