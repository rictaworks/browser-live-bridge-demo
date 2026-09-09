package wsapi

import (
	"bytes"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yutopp/go-flv/tag"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
)

// TestFullPipeline_StudioPublishReachesMonitor は、issue #4の受け入れ条件
// 「配信開始→中継到達→モニター再生」の一連の疎通を、実際に/ws/publishと
// /ws/monitor/:broadcast_tokenを同一ルーター・同一ローカルingestで結んで
// 検証する（16.1節・16.4節のシーケンス通り）。
//
// TestPublishHandlerFullLifecycle（publish→ローカルingestのSinkまで）と
// TestMonitorHandlerStreamsFlvFromLastKeyframe（Sink→モニターWS）は
// それぞれ別のシナリオとして既に検証済みだが、両者を1つのHTTPサーバー・
// 1つのingest.Serverインスタンスで実際につなげて確認するテストはこれまで
// 存在しなかったため、それを埋める。
func TestFullPipeline_StudioPublishReachesMonitor(t *testing.T) {
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
	router.GET("/ws/monitor/:broadcast_token", MonitorHandler(deps))
	srv := httptest.NewServer(router)
	defer srv.Close()

	const token = "tok-full-pipeline"

	// --- 配信スタジオ役：開始通知・設定・キーフレームを送出する ---
	studio := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/publish"))
	defer studio.Close()

	mustSendFrame(t, studio, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{SessionKey: "s1", BroadcastToken: token, EncodeProfile: "h264-baseline-3.1"}),
	})
	ack := mustReadFrame(t, studio)
	if ct, err := protocol.PeekControlType(ack.Body); err != nil || ct != protocol.ControlAck {
		t.Fatalf("first response = %v (err=%v), want ControlAck", ct, err)
	}

	mustSendFrame(t, studio, protocol.Frame{Kind: protocol.KindVideoConfig, Body: []byte{0x01, 0x42, 0xC0, 0x1F}})
	mustSendFrame(t, studio, protocol.Frame{Kind: protocol.KindAudioConfig, Body: []byte{0x11, 0x90}})

	kfReq := mustReadFrame(t, studio)
	if ct, err := protocol.PeekControlType(kfReq.Body); err != nil || ct != protocol.ControlKeyframeRequest {
		t.Fatalf("second response = %v (err=%v), want ControlKeyframeRequest", ct, err)
	}

	const keyframePayload = "full-pipeline-keyframe"
	mustSendFrame(t, studio, protocol.Frame{Kind: protocol.KindVideo, KeyFrame: true, TimestampMicros: 0, Body: []byte(keyframePayload)})
	mustSendFrame(t, studio, protocol.Frame{Kind: protocol.KindAudio, TimestampMicros: 0, Body: []byte("full-pipeline-audio")})

	// ローカルingestへ到達するまで待つ（RTMP publish + 多重化は非同期）。
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := ingestSrv.Sink(token); ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// --- モニター視聴者役：同じ配信トークンで購読し、映像が届くことを確認する ---
	viewer := mustDial(t, toWebSocketURL(t, srv.URL, "/ws/monitor/"+token))
	defer viewer.Close()

	header := readExactBinary(t, viewer)
	if !bytes.Equal(header, ingest.FlvHeader()) {
		t.Fatalf("first monitor message = %v, want FLV header", header)
	}
	readExactBinary(t, viewer) // PreviousTagSize0（4byte）

	foundKeyframe := false
	for i := 0; i < 3 && !foundKeyframe; i++ {
		tagBytes := readExactBinary(t, viewer)
		var ft tag.FlvTag
		if err := tag.DecodeFlvTag(bytes.NewReader(tagBytes), &ft); err != nil {
			t.Fatalf("DecodeFlvTag: %v", err)
		}
		if vd, ok := ft.Data.(*tag.VideoData); ok {
			buf := new(bytes.Buffer)
			buf.ReadFrom(vd.Data)
			vd.Close()
			if buf.String() == keyframePayload {
				foundKeyframe = true
			}
		}
		readExactBinary(t, viewer) // このタグに対応するPreviousTagSize
	}
	if !foundKeyframe {
		t.Fatalf("配信スタジオが送出したキーフレームがモニター側でバイト単位で確認できなかった（配信開始→中継到達→モニター再生の疎通が壊れている）")
	}

	// --- 配信停止：終了通知でbackendへ記録され、モニター側にも終了が伝わることを確認する ---
	mustSendFrame(t, studio, protocol.Frame{
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
}
