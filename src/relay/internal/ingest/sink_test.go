package ingest

import (
	"bytes"
	"testing"
	"time"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/muxer"
	"github.com/yutopp/go-flv/tag"
)

func mustVideoConfig(t *testing.T) []byte {
	t.Helper()
	b, err := muxer.EncodeVideoConfig([]byte{0x01, 0x42, 0xC0, 0x1F})
	if err != nil {
		t.Fatalf("EncodeVideoConfig: %v", err)
	}
	return b
}

func mustVideoFrame(t *testing.T, key bool, payload string) []byte {
	t.Helper()
	b, err := muxer.EncodeVideo(key, []byte(payload))
	if err != nil {
		t.Fatalf("EncodeVideo: %v", err)
	}
	return b
}

func mustAudioConfig(t *testing.T) []byte {
	t.Helper()
	b, err := muxer.EncodeAudioConfig([]byte{0x11, 0x90})
	if err != nil {
		t.Fatalf("EncodeAudioConfig: %v", err)
	}
	return b
}

func mustAudioFrame(t *testing.T, payload string) []byte {
	t.Helper()
	b, err := muxer.EncodeAudio([]byte(payload))
	if err != nil {
		t.Fatalf("EncodeAudio: %v", err)
	}
	return b
}

func TestSinkSubscribeBeforeAnyKeyframeGetsNoCatchupTags(t *testing.T) {
	s := NewSink(10*time.Second, 5)

	sub, catchUp, err := s.Subscribe()
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer s.Unsubscribe(sub)

	if len(catchUp) != 0 {
		t.Fatalf("expected no catch-up tags before any keyframe, got %d", len(catchUp))
	}
}

func TestSinkSubscribeReturnsConfigThenTagsFromLastKeyframe(t *testing.T) {
	s := NewSink(10*time.Second, 5)

	if err := s.AppendVideo(0, bytes.NewReader(mustVideoConfig(t))); err != nil {
		t.Fatalf("AppendVideo(config): %v", err)
	}
	if err := s.AppendAudio(0, bytes.NewReader(mustAudioConfig(t))); err != nil {
		t.Fatalf("AppendAudio(config): %v", err)
	}
	if err := s.AppendVideo(0, bytes.NewReader(mustVideoFrame(t, true, "key1"))); err != nil {
		t.Fatalf("AppendVideo(key1): %v", err)
	}
	if err := s.AppendVideo(33, bytes.NewReader(mustVideoFrame(t, false, "delta1"))); err != nil {
		t.Fatalf("AppendVideo(delta1): %v", err)
	}
	if err := s.AppendVideo(66, bytes.NewReader(mustVideoFrame(t, true, "key2"))); err != nil {
		t.Fatalf("AppendVideo(key2): %v", err)
	}
	if err := s.AppendVideo(100, bytes.NewReader(mustVideoFrame(t, false, "delta2"))); err != nil {
		t.Fatalf("AppendVideo(delta2): %v", err)
	}

	sub, catchUp, err := s.Subscribe()
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer s.Unsubscribe(sub)

	// 期待: [映像設定][音声設定][key2 (直近キーフレーム)][delta2]
	// key1・delta1は直近キーフレーム(key2)より前なので含まれない。
	if len(catchUp) != 4 {
		t.Fatalf("catchUp length = %d, want 4: %v", len(catchUp), describeTags(t, catchUp))
	}

	assertContainsVideoPayload(t, catchUp[2], "key2")
	assertContainsVideoPayload(t, catchUp[3], "delta2")
}

func describeTags(t *testing.T, tags [][]byte) []string {
	t.Helper()
	out := make([]string, len(tags))
	for i, b := range tags {
		out[i] = string(b)
	}
	return out
}

func assertContainsVideoPayload(t *testing.T, tagBytes []byte, want string) {
	t.Helper()
	var ft tag.FlvTag
	if err := tag.DecodeFlvTag(bytes.NewReader(tagBytes), &ft); err != nil {
		t.Fatalf("DecodeFlvTag: %v", err)
	}
	vd, ok := ft.Data.(*tag.VideoData)
	if !ok {
		t.Fatalf("expected VideoData, got %T", ft.Data)
	}
	defer vd.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(vd.Data)
	if buf.String() != want {
		t.Fatalf("payload = %q, want %q", buf.String(), want)
	}
}

func TestSinkRetentionPrunesOldTags(t *testing.T) {
	s := NewSink(20*time.Millisecond, 5)

	if err := s.AppendVideo(0, bytes.NewReader(mustVideoFrame(t, true, "old-key"))); err != nil {
		t.Fatalf("AppendVideo: %v", err)
	}

	time.Sleep(40 * time.Millisecond)

	if err := s.AppendVideo(1, bytes.NewReader(mustVideoFrame(t, false, "new-delta"))); err != nil {
		t.Fatalf("AppendVideo: %v", err)
	}

	s.mu.Lock()
	n := len(s.tags)
	s.mu.Unlock()

	if n != 1 {
		t.Fatalf("expected pruning to leave 1 tag, got %d", n)
	}
}

func TestSinkTooManySubscribers(t *testing.T) {
	s := NewSink(10*time.Second, 1)

	sub1, _, err := s.Subscribe()
	if err != nil {
		t.Fatalf("first Subscribe() error = %v", err)
	}
	defer s.Unsubscribe(sub1)

	if _, _, err := s.Subscribe(); err != ErrTooManySubscribers {
		t.Fatalf("second Subscribe() error = %v, want ErrTooManySubscribers", err)
	}
}

func TestSinkFinishClosesSubscribersAndRejectsFurtherSubscribe(t *testing.T) {
	s := NewSink(10*time.Second, 5)

	sub, _, err := s.Subscribe()
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	s.Finish()

	_, closed := sub.Recv()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("expected subscriber closed channel to be closed after Finish()")
	}

	if _, _, err := s.Subscribe(); err != ErrSinkFinished {
		t.Fatalf("Subscribe() after Finish() error = %v, want ErrSinkFinished", err)
	}
}

func TestSinkFanoutDeliversLiveTagsToSubscriber(t *testing.T) {
	s := NewSink(10*time.Second, 5)

	// キーフレームを1つ入れてから購読する。
	if err := s.AppendVideo(0, bytes.NewReader(mustVideoFrame(t, true, "key"))); err != nil {
		t.Fatalf("AppendVideo: %v", err)
	}

	sub, _, err := s.Subscribe()
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer s.Unsubscribe(sub)

	if err := s.AppendAudio(10, bytes.NewReader(mustAudioFrame(t, "audio-live"))); err != nil {
		t.Fatalf("AppendAudio: %v", err)
	}

	ch, _ := sub.Recv()
	select {
	case got := <-ch:
		var ft tag.FlvTag
		if err := tag.DecodeFlvTag(bytes.NewReader(got), &ft); err != nil {
			t.Fatalf("DecodeFlvTag: %v", err)
		}
		if ft.TagType != tag.TagTypeAudio {
			t.Fatalf("TagType = %v, want Audio", ft.TagType)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for live tag fanout")
	}
}
