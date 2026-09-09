package wsapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
)

// fakeBackend は backendclient.Client のテスト用実装です。
// broadcast パッケージ内部のフェイクとは別に、wsapi の結合テスト用として
// 最小限の機能を持たせています。
type fakeBackend struct {
	mu          sync.Mutex
	verifyValid bool
	broadcastID string
	finishCh    chan struct{ broadcastID, broadcastToken, reason string }
}

func newFakeBackend(valid bool, broadcastID string) *fakeBackend {
	return &fakeBackend{
		verifyValid: valid,
		broadcastID: broadcastID,
		finishCh:    make(chan struct{ broadcastID, broadcastToken, reason string }, 8),
	}
}

func (f *fakeBackend) Verify(_ context.Context, _, _ string) (backendclient.VerifyResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return backendclient.VerifyResult{Valid: f.verifyValid, BroadcastID: f.broadcastID}, nil
}

func (f *fakeBackend) ReportHealth(context.Context, string, string, backendclient.HealthSample) error {
	return nil
}

func (f *fakeBackend) ReportEvent(context.Context, string, string, string, string) error {
	return nil
}

func (f *fakeBackend) Finish(_ context.Context, broadcastID, broadcastToken, reason string) error {
	f.finishCh <- struct{ broadcastID, broadcastToken, reason string }{broadcastID, broadcastToken, reason}
	return nil
}

var _ backendclient.Client = (*fakeBackend)(nil)

func toWebSocketURL(t *testing.T, httpURL, path string) string {
	t.Helper()
	return "ws" + strings.TrimPrefix(httpURL, "http") + path
}

func mustDial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("Dial(%s) error = %v", url, err)
	}
	return conn
}

func mustReadFrame(t *testing.T, conn *websocket.Conn) protocol.Frame {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage() error = %v", err)
	}
	frame, err := protocol.Decode(data)
	if err != nil {
		t.Fatalf("protocol.Decode() error = %v", err)
	}
	return frame
}

func mustSendFrame(t *testing.T, conn *websocket.Conn, f protocol.Frame) {
	t.Helper()
	encoded, err := protocol.Encode(f)
	if err != nil {
		t.Fatalf("protocol.Encode() error = %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, encoded); err != nil {
		t.Fatalf("WriteMessage() error = %v", err)
	}
}

// TestPublishHandlerFullLifecycle は /ws/publish に対して、開始通知 -> 受領応答
// -> 映像設定・音声設定 -> キーフレーム要求 -> メディアフレーム -> 終了通知、
// という一連の流れ（requirements.md 16.1節・16.2節）を、実際のWebSocket接続と
// 実際のローカルingest（RTMP）を通じて検証します。
func TestPublishHandlerFullLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ingestSrv, err := ingest.NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("ingest.NewServer() error = %v", err)
	}
	defer ingestSrv.Close()
	go func() { _ = ingestSrv.Serve() }()

	backend := newFakeBackend(true, "b-1")
	deps := Deps{
		Backend:    backend,
		IngestAddr: ingestSrv.Addr().String(),
		IngestSrv:  ingestSrv,
	}

	router := gin.New()
	router.GET("/ws/publish", PublishHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	conn := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/publish"))
	defer conn.Close()

	const token = "tok-lifecycle"
	mustSendFrame(t, conn, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{SessionKey: "s1", BroadcastToken: token, EncodeProfile: "h264-baseline-3.1"}),
	})

	ack := mustReadFrame(t, conn)
	ct, err := protocol.PeekControlType(ack.Body)
	if err != nil || ct != protocol.ControlAck {
		t.Fatalf("first response frame = %v (err=%v), want ControlAck", ct, err)
	}

	mustSendFrame(t, conn, protocol.Frame{Kind: protocol.KindVideoConfig, Body: []byte{0x01, 0x42, 0xC0, 0x1F}})
	mustSendFrame(t, conn, protocol.Frame{Kind: protocol.KindAudioConfig, Body: []byte{0x11, 0x90}})

	kfReq := mustReadFrame(t, conn)
	ct, err = protocol.PeekControlType(kfReq.Body)
	if err != nil || ct != protocol.ControlKeyframeRequest {
		t.Fatalf("second response frame = %v (err=%v), want ControlKeyframeRequest", ct, err)
	}

	mustSendFrame(t, conn, protocol.Frame{Kind: protocol.KindVideo, KeyFrame: true, TimestampMicros: 0, Body: []byte("keyframe-payload")})
	mustSendFrame(t, conn, protocol.Frame{Kind: protocol.KindAudio, TimestampMicros: 0, Body: []byte("audio-payload")})

	// ローカルingestへ実際にRTMP publishされ、Sinkへ到達することを確認する。
	var sink *ingest.Sink
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := ingestSrv.Sink(token); ok {
			sink = s
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sink == nil {
		t.Fatalf("sink for token %q was not registered in time", token)
	}

	deadline = time.Now().Add(3 * time.Second)
	var catchUp [][]byte
	for time.Now().Before(deadline) {
		sub, cu, err := sink.Subscribe()
		if err != nil {
			t.Fatalf("Subscribe() error = %v", err)
		}
		sink.Unsubscribe(sub)
		if len(cu) >= 3 { // 映像設定 + 音声設定 + キーフレーム
			catchUp = cu
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if catchUp == nil {
		t.Fatalf("expected media to reach the local ingest sink within timeout")
	}

	// 終了通知で正常終了し、backendへ終了記録が行われること。
	mustSendFrame(t, conn, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeEndNotice(protocol.EndNotice{Reason: "user_stopped"}),
	})

	select {
	case call := <-backend.finishCh:
		if call.broadcastID != "b-1" || call.reason != "user_stopped" {
			t.Fatalf("Finish call = %+v, want {b-1, user_stopped}", call)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for Finish() to be reported")
	}

	// サーバー側が接続を閉じるため、以後のReadMessageはエラーになる。
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatalf("expected connection to be closed after end notice")
	}
}

// TestPublishHandlerRejectsInvalidStartNotice は、照合に失敗した場合に
// 致命通知を受けて接続が閉じられることを検証します（requirements.md 6.6節）。
func TestPublishHandlerRejectsInvalidStartNotice(t *testing.T) {
	gin.SetMode(gin.TestMode)

	backend := newFakeBackend(false, "")
	deps := Deps{Backend: backend, IngestAddr: "127.0.0.1:1"}

	router := gin.New()
	router.GET("/ws/publish", PublishHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	conn := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/publish"))
	defer conn.Close()

	mustSendFrame(t, conn, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{SessionKey: "s1", BroadcastToken: "bad-token", EncodeProfile: "p"}),
	})

	fatal := mustReadFrame(t, conn)
	ct, err := protocol.PeekControlType(fatal.Body)
	if err != nil || ct != protocol.ControlFatal {
		t.Fatalf("response frame = %v (err=%v), want ControlFatal", ct, err)
	}
	reason, err := protocol.DecodeFatal(fatal.Body)
	if err != nil || reason.Reason != "verification_failed" {
		t.Fatalf("fatal reason = %+v (err=%v), want verification_failed", reason, err)
	}
}
