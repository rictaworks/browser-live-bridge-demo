package wsapi

import (
	"bytes"
	"encoding/binary"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/yutopp/go-flv/tag"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/muxer"
)

// readExactBinary はWebSocketバイナリメッセージを1件読み取ります。
func readExactBinary(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage() error = %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type = %d, want BinaryMessage", mt)
	}
	return data
}

// TestMonitorHandlerStreamsFlvFromLastKeyframe は、実際のRTMP publish経由で
// ローカルingestへ到達した映像を、モニターWebSocketが正しいFLVバイト列
// （ヘッダ + PreviousTagSize + タグ列）として配信することを検証します
// （requirements.md 6.7節・10節）。
func TestMonitorHandlerStreamsFlvFromLastKeyframe(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ingestSrv, err := ingest.NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("ingest.NewServer() error = %v", err)
	}
	defer ingestSrv.Close()
	go func() { _ = ingestSrv.Serve() }()

	const token = "tok-monitor"
	videoConfig, err := muxer.EncodeVideoConfig([]byte{0x01, 0x42, 0xC0, 0x1F})
	if err != nil {
		t.Fatalf("EncodeVideoConfig: %v", err)
	}
	audioConfig, err := muxer.EncodeAudioConfig([]byte{0x11, 0x90})
	if err != nil {
		t.Fatalf("EncodeAudioConfig: %v", err)
	}
	keyFrame, err := muxer.EncodeVideo(true, []byte("monitor-keyframe"))
	if err != nil {
		t.Fatalf("EncodeVideo: %v", err)
	}

	pub, err := ingest.Dial(ingestSrv.Addr().String(), token)
	if err != nil {
		t.Fatalf("ingest.Dial() error = %v", err)
	}
	defer pub.Close()
	if err := pub.WriteVideo(0, videoConfig); err != nil {
		t.Fatalf("WriteVideo(config): %v", err)
	}
	if err := pub.WriteAudio(0, audioConfig); err != nil {
		t.Fatalf("WriteAudio(config): %v", err)
	}
	if err := pub.WriteVideo(33, keyFrame); err != nil {
		t.Fatalf("WriteVideo(key): %v", err)
	}

	// キーフレームがSinkへ到達するまで待つ。
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if sink, ok := ingestSrv.Sink(token); ok {
			sub, cu, err := sink.Subscribe()
			if err == nil {
				sink.Unsubscribe(sub)
				if len(cu) >= 3 {
					break
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}

	deps := Deps{IngestSrv: ingestSrv}
	router := gin.New()
	router.GET("/ws/monitor/:broadcast_token", MonitorHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	conn := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/monitor/"+token))
	defer conn.Close()

	header := readExactBinary(t, conn)
	if !bytes.Equal(header, ingest.FlvHeader()) {
		t.Fatalf("first message = %v, want FLV header %v", header, ingest.FlvHeader())
	}

	prevSize0 := readExactBinary(t, conn)
	if len(prevSize0) != 4 || binary.BigEndian.Uint32(prevSize0) != 0 {
		t.Fatalf("second message = %v, want 4-byte PreviousTagSize0", prevSize0)
	}

	foundKeyframe := false
	// 映像設定・音声設定・キーフレームのうち少なくとも3組(タグ+サイズ)を読み、
	// キーフレームのペイロードがバイト単位で一致することを確認する。
	for i := 0; i < 3; i++ {
		tagBytes := readExactBinary(t, conn)

		var ft tag.FlvTag
		if err := tag.DecodeFlvTag(bytes.NewReader(tagBytes), &ft); err != nil {
			t.Fatalf("DecodeFlvTag: %v", err)
		}
		if vd, ok := ft.Data.(*tag.VideoData); ok {
			buf := new(bytes.Buffer)
			buf.ReadFrom(vd.Data)
			vd.Close()
			if buf.String() == "monitor-keyframe" {
				foundKeyframe = true
			}
		}

		sizeBytes := readExactBinary(t, conn)
		if len(sizeBytes) != 4 {
			t.Fatalf("PreviousTagSize message length = %d, want 4", len(sizeBytes))
		}
		if got := binary.BigEndian.Uint32(sizeBytes); got != uint32(len(tagBytes)) {
			t.Fatalf("PreviousTagSize = %d, want %d (length of preceding tag)", got, len(tagBytes))
		}
	}
	if !foundKeyframe {
		t.Fatalf("expected to find the keyframe payload byte-for-byte among the streamed tags")
	}
}

// TestMonitorHandlerRejectsUnknownToken は、存在しない配信トークンでの
// 購読要求が404で拒否されることを検証します（requirements.md 10節）。
func TestMonitorHandlerRejectsUnknownToken(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ingestSrv, err := ingest.NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("ingest.NewServer() error = %v", err)
	}
	defer ingestSrv.Close()
	go func() { _ = ingestSrv.Serve() }()

	deps := Deps{IngestSrv: ingestSrv}
	router := gin.New()
	router.GET("/ws/monitor/:broadcast_token", MonitorHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	_, resp, err := websocket.DefaultDialer.Dial(toWebSocketURL(t, srv.URL, "/ws/monitor/no-such-token"), nil)
	if err == nil {
		t.Fatalf("expected handshake to fail for an unknown token")
	}
	if resp == nil || resp.StatusCode != 404 {
		status := -1
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("status = %d, want 404", status)
	}
}

// TestMonitorHandlerRejectsWhenSubscriberLimitReached は、同時接続数上限に
// 達した場合に新規購読が拒否されることを検証します（requirements.md 10節）。
func TestMonitorHandlerRejectsWhenSubscriberLimitReached(t *testing.T) {
	gin.SetMode(gin.TestMode)

	ingestSrv, err := ingest.NewServer("127.0.0.1:0", 5*time.Second, 1) // 上限1
	if err != nil {
		t.Fatalf("ingest.NewServer() error = %v", err)
	}
	defer ingestSrv.Close()
	go func() { _ = ingestSrv.Serve() }()

	const token = "tok-limit"
	pub, err := ingest.Dial(ingestSrv.Addr().String(), token)
	if err != nil {
		t.Fatalf("ingest.Dial() error = %v", err)
	}
	defer pub.Close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := ingestSrv.Sink(token); ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	deps := Deps{IngestSrv: ingestSrv}
	router := gin.New()
	router.GET("/ws/monitor/:broadcast_token", MonitorHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	first := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/monitor/"+token))
	defer first.Close()
	// 最初の接続がSubscribeを完了するまで少し待つ。
	time.Sleep(100 * time.Millisecond)

	_, resp, err := websocket.DefaultDialer.Dial(toWebSocketURL(t, srv.URL, "/ws/monitor/"+token), nil)
	if err == nil {
		t.Fatalf("expected second subscriber to be rejected once the limit is reached")
	}
	if resp == nil || resp.StatusCode != 503 {
		status := -1
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("status = %d, want 503", status)
	}
}
