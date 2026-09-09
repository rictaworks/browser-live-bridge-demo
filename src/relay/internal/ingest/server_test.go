package ingest

import (
	"bytes"
	"testing"
	"time"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/muxer"
	"github.com/yutopp/go-flv/tag"
)

// TestServerPublishRoundTrip は、実際のRTMPハンドシェイク・publishを通じて
// Publisher（クライアント）からServer（ローカルingest）へ映像・音声が到達し、
// Sinkに保持されることを検証する結合テストです。
//
// requirements.md 1.3節「送出先の扱い」は、ブラウザから中継サーバーまでの
// パイプラインが本番と同一の構造を持つことを求めています。本テストは
// 中継層が実際にRTMPプロトコル（handshake + publish）を話していることの
// 裏付けです（自作のハンドシェイク実装は行わず、go-rtmpを使用）。
func TestServerPublishRoundTrip(t *testing.T) {
	srv, err := NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	defer srv.Close()

	go func() {
		_ = srv.Serve()
	}()

	streamKey := "test-broadcast-token"

	videoConfig, err := muxer.EncodeVideoConfig([]byte{0x01, 0x42, 0xC0, 0x1F})
	if err != nil {
		t.Fatalf("EncodeVideoConfig: %v", err)
	}
	audioConfig, err := muxer.EncodeAudioConfig([]byte{0x11, 0x90})
	if err != nil {
		t.Fatalf("EncodeAudioConfig: %v", err)
	}
	keyFrame, err := muxer.EncodeVideo(true, []byte("integration-keyframe-payload"))
	if err != nil {
		t.Fatalf("EncodeVideo: %v", err)
	}
	audioFrame, err := muxer.EncodeAudio([]byte("integration-audio-payload"))
	if err != nil {
		t.Fatalf("EncodeAudio: %v", err)
	}

	pub, err := Dial(srv.Addr().String(), streamKey)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}

	if err := pub.WriteVideo(0, videoConfig); err != nil {
		t.Fatalf("WriteVideo(config): %v", err)
	}
	if err := pub.WriteAudio(0, audioConfig); err != nil {
		t.Fatalf("WriteAudio(config): %v", err)
	}
	if err := pub.WriteVideo(33, keyFrame); err != nil {
		t.Fatalf("WriteVideo(key): %v", err)
	}
	if err := pub.WriteAudio(10, audioFrame); err != nil {
		t.Fatalf("WriteAudio: %v", err)
	}

	var sink *Sink
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := srv.Sink(streamKey); ok {
			sink = s
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sink == nil {
		t.Fatalf("sink was not registered for stream key %q within timeout", streamKey)
	}

	// キーフレームが到達し、購読可能になるまで待つ。
	var catchUp [][]byte
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		sub, cu, err := sink.Subscribe()
		if err != nil {
			t.Fatalf("Subscribe() error = %v", err)
		}
		if len(cu) >= 3 { // 映像設定 + 音声設定 + キーフレーム
			catchUp = cu
			sink.Unsubscribe(sub)
			break
		}
		sink.Unsubscribe(sub)
		time.Sleep(10 * time.Millisecond)
	}
	if catchUp == nil {
		t.Fatalf("did not observe expected catch-up tags in time")
	}

	foundKeyframe := false
	for _, tb := range catchUp {
		var ft tag.FlvTag
		if err := tag.DecodeFlvTag(bytes.NewReader(tb), &ft); err != nil {
			t.Fatalf("DecodeFlvTag: %v", err)
		}
		if vd, ok := ft.Data.(*tag.VideoData); ok {
			defer vd.Close()
			payload := new(bytes.Buffer)
			payload.ReadFrom(vd.Data)
			if payload.String() == "integration-keyframe-payload" {
				foundKeyframe = true
			}
		}
	}
	if !foundKeyframe {
		t.Fatalf("expected to find the keyframe payload, byte-for-byte, among catch-up tags")
	}

	if err := pub.Close(); err != nil {
		t.Fatalf("Publisher.Close() error = %v", err)
	}

	// 配信終了(OnClose)により、Sinkが登録解除されることを確認する
	// （requirements.md 10節: 配信終了後は購読を受け付けない）。
	deadline = time.Now().Add(3 * time.Second)
	removed := false
	for time.Now().Before(deadline) {
		if _, ok := srv.Sink(streamKey); !ok {
			removed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !removed {
		t.Fatalf("expected sink to be removed from registry after publisher closed")
	}
}

func TestServerRejectsEmptyPublishingName(t *testing.T) {
	srv, err := NewServer("127.0.0.1:0", 5*time.Second, 5)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	defer srv.Close()

	go func() {
		_ = srv.Serve()
	}()

	// OnPublishでのエラーはサーバー側で接続断として扱われるため、Dial自体は
	// 成功する場合がある。以後の書き込みが失敗する（=接続が拒否・切断される）
	// ことをもって、空のストリームキーを拒否したとみなす。
	pub, err := Dial(srv.Addr().String(), "")
	if err != nil {
		return // 同期的に拒否された場合もOK
	}
	defer pub.Close()

	deadline := time.Now().Add(2 * time.Second)
	rejected := false
	for time.Now().Before(deadline) {
		if werr := pub.WriteVideo(0, []byte{0x17, 0x00}); werr != nil {
			rejected = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !rejected {
		t.Fatalf("expected empty stream key to eventually be rejected by the server")
	}
}
