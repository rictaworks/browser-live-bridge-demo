package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
)

// noopBackend は main_test.go 専用の最小限の backendclient.Client 実装です。
// ここでは /health のルーティング配線のみを確認するため、呼び出されません。
type noopBackend struct{}

func (noopBackend) Verify(context.Context, string, string) (backendclient.VerifyResult, error) {
	return backendclient.VerifyResult{}, nil
}
func (noopBackend) ReportHealth(context.Context, string, backendclient.HealthSample) error {
	return nil
}
func (noopBackend) ReportEvent(context.Context, string, string, string) error { return nil }
func (noopBackend) Finish(context.Context, string, string) error              { return nil }

var _ backendclient.Client = noopBackend{}

func newTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	ingestSrv, err := ingest.NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("ingest.NewServer() error = %v", err)
	}
	t.Cleanup(func() { ingestSrv.Close() })

	return newRouter(ingestSrv.Addr().String(), ingestSrv, noopBackend{})
}

func TestHealthReturnsOK(t *testing.T) {
	router := newTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}

	expected := `{"status":"ok"}`
	if rec.Body.String() != expected {
		t.Fatalf("expected body %q, got %q", expected, rec.Body.String())
	}
}

func TestRoutesRegisterWebSocketEndpoints(t *testing.T) {
	router := newTestRouter(t)

	routes := router.Routes()
	want := map[string]bool{
		"/health":                      false,
		"/ws/publish":                  false,
		"/ws/monitor/:broadcast_token": false,
	}
	for _, r := range routes {
		if _, ok := want[r.Path]; ok {
			want[r.Path] = true
		}
	}
	for path, found := range want {
		if !found {
			t.Errorf("expected route %q to be registered", path)
		}
	}
}
