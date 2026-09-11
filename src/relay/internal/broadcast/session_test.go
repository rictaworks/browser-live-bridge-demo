package broadcast

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/muxer"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ratecontrol"
)

// --- テスト用フェイク実装 ---

type verifyCall struct {
	sessionKey, broadcastToken string
}

type eventCall struct {
	broadcastID, broadcastToken, eventType, detail string
}

type finishCall struct {
	broadcastID, broadcastToken, reason string
}

// fakeBackend は backendclient.Client のテスト用実装です。
// Session はHealth/Event/Finishの一部を別ゴルーチンから呼び出すため、
// 受信をチャネルで待ち合わせられるようにしています。
type fakeBackend struct {
	mu           sync.Mutex
	verifyResult backendclient.VerifyResult
	verifyErr    error
	verifyCalls  []verifyCall

	healthCh chan backendclient.HealthSample
	eventCh  chan eventCall
	finishCh chan finishCall
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{
		healthCh: make(chan backendclient.HealthSample, 16),
		eventCh:  make(chan eventCall, 16),
		finishCh: make(chan finishCall, 16),
	}
}

func (f *fakeBackend) Verify(_ context.Context, sessionKey, broadcastToken string) (backendclient.VerifyResult, error) {
	f.mu.Lock()
	f.verifyCalls = append(f.verifyCalls, verifyCall{sessionKey, broadcastToken})
	result, err := f.verifyResult, f.verifyErr
	f.mu.Unlock()
	return result, err
}

func (f *fakeBackend) ReportHealth(_ context.Context, _, _ string, sample backendclient.HealthSample) error {
	f.healthCh <- sample
	return nil
}

func (f *fakeBackend) ReportEvent(_ context.Context, broadcastID, broadcastToken, eventType, detail string) error {
	f.eventCh <- eventCall{broadcastID, broadcastToken, eventType, detail}
	return nil
}

func (f *fakeBackend) Finish(_ context.Context, broadcastID, broadcastToken, reason string) error {
	f.finishCh <- finishCall{broadcastID, broadcastToken, reason}
	return nil
}

func (f *fakeBackend) verifyCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.verifyCalls)
}

var _ backendclient.Client = (*fakeBackend)(nil)

type writeCall struct {
	kind        string // "video" または "audio"
	timestampMs uint32
	payload     []byte
}

// fakePublisher は Publisher のテスト用実装です。実際のRTMP接続を張らずに
// Sessionの多重化・送出ロジックを検証します。
type fakePublisher struct {
	mu     sync.Mutex
	writes []writeCall
	closed bool

	writeVideoErr error
	writeAudioErr error
}

func (p *fakePublisher) WriteVideo(ts uint32, payload []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.writeVideoErr != nil {
		return p.writeVideoErr
	}
	p.writes = append(p.writes, writeCall{"video", ts, append([]byte(nil), payload...)})
	return nil
}

func (p *fakePublisher) WriteAudio(ts uint32, payload []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.writeAudioErr != nil {
		return p.writeAudioErr
	}
	p.writes = append(p.writes, writeCall{"audio", ts, append([]byte(nil), payload...)})
	return nil
}

func (p *fakePublisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	return nil
}

func (p *fakePublisher) snapshot() []writeCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]writeCall(nil), p.writes...)
}

var _ Publisher = (*fakePublisher)(nil)

// fakeFrameWriter は FrameWriter のテスト用実装です。
type fakeFrameWriter struct {
	mu     sync.Mutex
	frames []protocol.Frame
}

func (w *fakeFrameWriter) WriteFrame(f protocol.Frame) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.frames = append(w.frames, f)
	return nil
}

func (w *fakeFrameWriter) snapshot() []protocol.Frame {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]protocol.Frame(nil), w.frames...)
}

func (w *fakeFrameWriter) last() (protocol.Frame, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.frames) == 0 {
		return protocol.Frame{}, false
	}
	return w.frames[len(w.frames)-1], true
}

var _ FrameWriter = (*fakeFrameWriter)(nil)

// --- フレーム構築ヘルパー ---

func startNoticeFrame(sessionKey, token, profile string) protocol.Frame {
	return protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{SessionKey: sessionKey, BroadcastToken: token, EncodeProfile: profile}),
	}
}

func endNoticeFrame(reason string) protocol.Frame {
	return protocol.Frame{Kind: protocol.KindControl, Body: protocol.EncodeEndNotice(protocol.EndNotice{Reason: reason})}
}

func videoConfigFrame(b []byte) protocol.Frame {
	return protocol.Frame{Kind: protocol.KindVideoConfig, Body: b}
}

func audioConfigFrame(b []byte) protocol.Frame {
	return protocol.Frame{Kind: protocol.KindAudioConfig, Body: b}
}

func videoFrame(ts uint64, key bool, b []byte) protocol.Frame {
	return protocol.Frame{Kind: protocol.KindVideo, TimestampMicros: ts, KeyFrame: key, Body: b}
}

func audioFrame(ts uint64, b []byte) protocol.Frame {
	return protocol.Frame{Kind: protocol.KindAudio, TimestampMicros: ts, Body: b}
}

func filterKind(writes []writeCall, kind string) []writeCall {
	var out []writeCall
	for _, w := range writes {
		if w.kind == kind {
			out = append(out, w)
		}
	}
	return out
}

func mustNone(t *testing.T, action Action) {
	t.Helper()
	if action != ActionNone {
		t.Fatalf("action = %v, want ActionNone", action)
	}
}

func mustRecvHealth(t *testing.T, ch <-chan backendclient.HealthSample) backendclient.HealthSample {
	t.Helper()
	select {
	case s := <-ch:
		return s
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ReportHealth call")
	}
	return backendclient.HealthSample{}
}

func mustRecvEvent(t *testing.T, ch <-chan eventCall) eventCall {
	t.Helper()
	select {
	case c := <-ch:
		return c
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ReportEvent call")
	}
	return eventCall{}
}

// mustLiveSession は開始通知・映像設定・音声設定までを完了させ、Live状態の
// Sessionを返します。
func mustLiveSession(t *testing.T) (*Session, *fakeBackend, *fakePublisher, *fakeFrameWriter) {
	t.Helper()
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	pub := &fakePublisher{}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		IngestAddr: "127.0.0.1:19350",
		DialIngest: func(addr, streamKey string) (Publisher, error) { return pub, nil },
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "tok-1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01, 0x42, 0xC0, 0x1F})))
	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90})))
	return session, backend, pub, fw
}

// --- テスト本体 ---

func TestDiscardsMediaFramesBeforeStartNotice(t *testing.T) {
	backend := newFakeBackend()
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)

	action := session.HandleFrame(context.Background(), videoFrame(1, true, []byte("x")))
	mustNone(t, action)

	if backend.verifyCallCount() != 0 {
		t.Fatalf("Verify should not be called before start notice")
	}
	if len(fw.snapshot()) != 0 {
		t.Fatalf("no frame should be written back for a discarded media frame")
	}
}

func TestRejectsInvalidStartNotice(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: false}
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)

	action := session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "profile"))
	if action != ActionCloseFatal {
		t.Fatalf("action = %v, want ActionCloseFatal", action)
	}

	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected a fatal frame to be written")
	}
	fatal, err := protocol.DecodeFatal(last.Body)
	if err != nil || fatal.Reason != "verification_failed" {
		t.Fatalf("fatal = %+v, err = %v, want reason verification_failed", fatal, err)
	}
}

func TestRejectsStartNoticeWhenBackendUnreachable(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyErr = errors.New("backend unreachable")
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)

	action := session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "profile"))
	if action != ActionCloseFatal {
		t.Fatalf("action = %v, want ActionCloseFatal", action)
	}
}

func TestAcksValidStartNotice(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)

	action := session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "profile"))
	mustNone(t, action)

	if got := session.BroadcastID(); got != "b-1" {
		t.Fatalf("BroadcastID() = %q, want b-1", got)
	}
	if backend.verifyCallCount() != 1 {
		t.Fatalf("Verify call count = %d, want 1", backend.verifyCallCount())
	}

	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected an ack frame to be written")
	}
	ct, err := protocol.PeekControlType(last.Body)
	if err != nil || ct != protocol.ControlAck {
		t.Fatalf("expected ControlAck frame, got %v (err=%v)", ct, err)
	}
}

func TestDiscardsMediaFramesBeforeConfig(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	dialCalls := 0
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend: backend,
		DialIngest: func(addr, streamKey string) (Publisher, error) {
			dialCalls++
			return &fakePublisher{}, nil
		},
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))

	action := session.HandleFrame(context.Background(), videoFrame(1, true, []byte("x")))
	mustNone(t, action)
	if dialCalls != 0 {
		t.Fatalf("dial should not be called before both configs are received")
	}
}

func TestStartsPublishOnceBothConfigsReceived(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	pub := &fakePublisher{}
	var gotAddr, gotStreamKey string
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		IngestAddr: "127.0.0.1:19350",
		DialIngest: func(addr, streamKey string) (Publisher, error) {
			gotAddr, gotStreamKey = addr, streamKey
			return pub, nil
		},
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "tok-1", "p")))

	videoConfigBytes := []byte{0x01, 0x42, 0xC0, 0x1F}
	audioConfigBytes := []byte{0x11, 0x90}

	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame(videoConfigBytes)))
	if len(pub.snapshot()) != 0 {
		t.Fatalf("publish should not start until both video and audio configs are received")
	}

	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame(audioConfigBytes)))

	if gotAddr != "127.0.0.1:19350" || gotStreamKey != "tok-1" {
		t.Fatalf("dial(addr=%q, streamKey=%q), want (127.0.0.1:19350, tok-1)", gotAddr, gotStreamKey)
	}

	writes := pub.snapshot()
	if len(writes) != 2 {
		t.Fatalf("writes = %d, want 2 (video config, audio config): %+v", len(writes), writes)
	}
	if writes[0].kind != "video" || writes[1].kind != "audio" {
		t.Fatalf("unexpected write order: %+v", writes)
	}

	wantVideoEncoded, err := muxer.EncodeVideoConfig(videoConfigBytes)
	if err != nil {
		t.Fatalf("muxer.EncodeVideoConfig: %v", err)
	}
	if !bytes.Equal(writes[0].payload, wantVideoEncoded) {
		t.Errorf("video config payload does not match muxer output (was re-encoded?)")
	}
	wantAudioEncoded, err := muxer.EncodeAudioConfig(audioConfigBytes)
	if err != nil {
		t.Fatalf("muxer.EncodeAudioConfig: %v", err)
	}
	if !bytes.Equal(writes[1].payload, wantAudioEncoded) {
		t.Errorf("audio config payload does not match muxer output (was re-encoded?)")
	}

	// requirements.md 16.3節: publish開始直後にキーフレーム要求が送られること。
	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected a frame to be written after publish starts")
	}
	ct, err := protocol.PeekControlType(last.Body)
	if err != nil || ct != protocol.ControlKeyframeRequest {
		t.Fatalf("expected ControlKeyframeRequest frame, got %v (err=%v)", ct, err)
	}

	if session.Wake() == nil {
		t.Fatalf("Wake() should return a non-nil channel once live")
	}
}

func TestDialFailureSendsFatalAndEndsSession(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend: backend,
		DialIngest: func(addr, streamKey string) (Publisher, error) {
			return nil, errors.New("connection refused")
		},
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01})))
	action := session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90}))

	if action != ActionCloseFatal {
		t.Fatalf("action = %v, want ActionCloseFatal", action)
	}
	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected a fatal frame to be written")
	}
	fatal, err := protocol.DecodeFatal(last.Body)
	if err != nil || fatal.Reason != "ingest_connect_failed" {
		t.Fatalf("fatal = %+v, err=%v, want reason ingest_connect_failed", fatal, err)
	}

	// stateEnded後はいかなるフレームも無視される。
	if action2 := session.HandleFrame(context.Background(), videoFrame(1, true, []byte("x"))); action2 != ActionNone {
		t.Fatalf("frames after fatal close should be ignored, got action %v", action2)
	}
}

func TestEnqueuesAndDrainsLiveMediaFrames(t *testing.T) {
	session, _, pub, _ := mustLiveSession(t)

	mustNone(t, session.HandleFrame(context.Background(), videoFrame(1000, true, []byte("nalu-key"))))
	mustNone(t, session.HandleFrame(context.Background(), audioFrame(1010, []byte("aac-frame"))))

	session.DrainOnce()

	writes := pub.snapshot()
	// 先頭2件はpublish開始時の映像設定・音声設定。
	if len(writes) != 4 {
		t.Fatalf("writes = %d, want 4: %+v", len(writes), writes)
	}
	if writes[2].kind != "video" || writes[3].kind != "audio" {
		t.Fatalf("unexpected write order after live frames: %+v", writes)
	}
	if writes[2].timestampMs != 1 { // 1000マイクロ秒 = 1ミリ秒（中継側で再採番しないこと, 6.7節）
		t.Errorf("video timestampMs = %d, want 1", writes[2].timestampMs)
	}
	if writes[3].timestampMs != 1 {
		t.Errorf("audio timestampMs = %d, want 1", writes[3].timestampMs)
	}
}

func TestRejectsOutOfOrderVideoTimestamp(t *testing.T) {
	session, _, pub, _ := mustLiveSession(t)

	mustNone(t, session.HandleFrame(context.Background(), videoFrame(1000, true, []byte("a"))))
	mustNone(t, session.HandleFrame(context.Background(), videoFrame(500, false, []byte("b")))) // 逆行 -> 破棄（21節）

	session.DrainOnce()

	// mustLiveSession が発行するpublish開始時の映像設定書き込み(kind=video)が1件
	// 含まれるため、正しく破棄されていれば「設定 + 受理された1件」の2件のみとなる。
	videoWrites := filterKind(pub.snapshot(), "video")
	if len(videoWrites) != 2 {
		t.Fatalf("video writes = %d, want 2 (config + accepted frame; out-of-order frame must be discarded)", len(videoWrites))
	}
}

func TestRejectsOutOfOrderAudioTimestamp(t *testing.T) {
	session, _, pub, _ := mustLiveSession(t)

	mustNone(t, session.HandleFrame(context.Background(), audioFrame(1000, []byte("a"))))
	mustNone(t, session.HandleFrame(context.Background(), audioFrame(999, []byte("b")))) // 逆行 -> 破棄（21節）

	session.DrainOnce()

	audioWrites := filterKind(pub.snapshot(), "audio")
	if len(audioWrites) != 2 {
		t.Fatalf("audio writes = %d, want 2 (config + accepted frame; out-of-order frame must be discarded)", len(audioWrites))
	}
}

func TestEndNoticeInLiveClosesGracefullyAndReportsFinish(t *testing.T) {
	session, backend, _, _ := mustLiveSession(t)

	action := session.HandleFrame(context.Background(), endNoticeFrame("user_stopped"))
	if action != ActionCloseGraceful {
		t.Fatalf("action = %v, want ActionCloseGraceful", action)
	}

	call := <-backend.finishCh
	if call.reason != "user_stopped" || call.broadcastID != "b-1" {
		t.Fatalf("Finish call = %+v, want {reason: user_stopped, broadcastID: b-1}", call)
	}
}

func TestEndNoticeInAwaitingConfigReportsFinish(t *testing.T) {
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-2"}
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))

	action := session.HandleFrame(context.Background(), endNoticeFrame(""))
	if action != ActionCloseGraceful {
		t.Fatalf("action = %v, want ActionCloseGraceful", action)
	}

	call := <-backend.finishCh
	if call.reason != "unspecified" || call.broadcastID != "b-2" {
		t.Fatalf("Finish call = %+v, want {reason: unspecified, broadcastID: b-2}", call)
	}
}

func TestCloseClosesPublisher(t *testing.T) {
	session, _, pub, _ := mustLiveSession(t)
	session.Close()
	if !pub.closed {
		t.Fatalf("expected publisher to be closed")
	}
}

func TestTickReportsHealthAndAppliesThrottle(t *testing.T) {
	fixedNow := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	pub := &fakePublisher{}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		Now:        func() time.Time { return fixedNow },
		DialIngest: func(addr, streamKey string) (Publisher, error) { return pub, nil },
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01})))
	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90})))

	// キューが空(滞留0ms) -> 300ms未満・破棄なしのため引き上げが発生する（7節）。
	action := session.Tick(context.Background(), fixedNow)
	mustNone(t, action)

	sample := mustRecvHealth(t, backend.healthCh)
	if sample.State != "live" {
		t.Errorf("health sample state = %q, want live", sample.State)
	}

	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected a throttle frame to be written")
	}
	ct, err := protocol.PeekControlType(last.Body)
	if err != nil || ct != protocol.ControlThrottleInstruction {
		t.Fatalf("expected ControlThrottleInstruction, got %v (err=%v)", ct, err)
	}
}

func TestTickReportsSentBitrateFromBytesActuallyWrittenSinceLastTick(t *testing.T) {
	fixedNow := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	pub := &fakePublisher{}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		Now:        func() time.Time { return fixedNow },
		DialIngest: func(addr, streamKey string) (Publisher, error) { return pub, nil },
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01})))
	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90})))

	// 1000バイトの映像フレームを1本、キューへ積んで送出させる。
	payload := bytes.Repeat([]byte{0xAB}, 1000)
	mustNone(t, session.HandleFrame(context.Background(), videoFrame(1, true, payload)))
	session.DrainOnce()

	// 1秒後にTickを呼ぶと、直前1秒間で送出した1000バイト分からビットレートを算出する。
	t1 := fixedNow.Add(1 * time.Second)
	mustNone(t, session.Tick(context.Background(), t1))

	sample := mustRecvHealth(t, backend.healthCh)
	// 1000 bytes * 8 / 1000 / 1s = 8 kbps
	if sample.SentBitrateKbps != 8 {
		t.Errorf("SentBitrateKbps = %d, want 8", sample.SentBitrateKbps)
	}

	// 次のTick（送出なし）ではリセットされ0に戻る。
	t2 := t1.Add(1 * time.Second)
	mustNone(t, session.Tick(context.Background(), t2))
	sample2 := mustRecvHealth(t, backend.healthCh)
	if sample2.SentBitrateKbps != 0 {
		t.Errorf("SentBitrateKbps (2nd tick, no traffic) = %d, want 0", sample2.SentBitrateKbps)
	}
}

func TestTickTransitionsToDegradedAndRequestsReconnect(t *testing.T) {
	fixedNow := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-1"}
	pub := &fakePublisher{}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		Now:        func() time.Time { return fixedNow },
		DialIngest: func(addr, streamKey string) (Publisher, error) { return pub, nil },
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01})))
	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90})))

	// キーフレームは破棄対象外（7節）のため、キューに残り続け滞留悪化を模擬できる。
	mustNone(t, session.HandleFrame(context.Background(), videoFrame(1, true, []byte("stuck-keyframe"))))

	t1 := fixedNow.Add(8500 * time.Millisecond)
	if action := session.Tick(context.Background(), t1); action != ActionNone {
		t.Fatalf("action at t1 = %v, want ActionNone (degraded, not yet sustained)", action)
	}
	mustRecvHealth(t, backend.healthCh)
	if ev := mustRecvEvent(t, backend.eventCh); ev.eventType != "state_changed" {
		t.Fatalf("event at t1 = %+v, want state_changed", ev)
	}

	t2 := t1.Add(ratecontrol.DegradedSustainedDuration + time.Second)
	action := session.Tick(context.Background(), t2)
	if action != ActionCloseFatal {
		t.Fatalf("action at t2 = %v, want ActionCloseFatal", action)
	}
	mustRecvHealth(t, backend.healthCh)

	gotTypes := map[string]bool{}
	for i := 0; i < 2; i++ {
		ev := mustRecvEvent(t, backend.eventCh)
		gotTypes[ev.eventType] = true
	}
	if !gotTypes["state_changed"] || !gotTypes["reconnect_requested"] {
		t.Fatalf("events at t2 = %v, want state_changed and reconnect_requested", gotTypes)
	}

	last, ok := fw.last()
	if !ok {
		t.Fatalf("expected a fatal frame to be written")
	}
	fatal, err := protocol.DecodeFatal(last.Body)
	if err != nil || fatal.Reason != "queue_congestion_sustained" {
		t.Fatalf("fatal = %+v, err=%v, want reason queue_congestion_sustained", fatal, err)
	}

	// 劣化継続による強制終了後は、以後のTickは何もしない。
	if action3 := session.Tick(context.Background(), t2.Add(time.Second)); action3 != ActionNone {
		t.Fatalf("Tick after session ended = %v, want ActionNone", action3)
	}
}

// Issue #36: relayが受信した映像・音声フレーム数を1tickごとにログへ出力し、
// railway logs等から「マイクの音が届いているか」を直接確認できるようにする。
func TestTickLogsIngressFrameCountsSinceLastTick(t *testing.T) {
	fixedNow := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	backend := newFakeBackend()
	backend.verifyResult = backendclient.VerifyResult{Valid: true, BroadcastID: "b-log-1"}
	pub := &fakePublisher{}
	fw := &fakeFrameWriter{}
	deps := Deps{
		Backend:    backend,
		Now:        func() time.Time { return fixedNow },
		DialIngest: func(addr, streamKey string) (Publisher, error) { return pub, nil },
	}
	session := NewSession(deps, fw)
	mustNone(t, session.HandleFrame(context.Background(), startNoticeFrame("s1", "t1", "p")))
	mustNone(t, session.HandleFrame(context.Background(), videoConfigFrame([]byte{0x01})))
	mustNone(t, session.HandleFrame(context.Background(), audioConfigFrame([]byte{0x11, 0x90})))

	// 映像2本・音声3本を受信させる。
	mustNone(t, session.HandleFrame(context.Background(), videoFrame(1, true, []byte("v1"))))
	mustNone(t, session.HandleFrame(context.Background(), videoFrame(2, false, []byte("v2"))))
	mustNone(t, session.HandleFrame(context.Background(), audioFrame(1, []byte("a1"))))
	mustNone(t, session.HandleFrame(context.Background(), audioFrame(2, []byte("a2"))))
	mustNone(t, session.HandleFrame(context.Background(), audioFrame(3, []byte("a3"))))

	var logBuf strings.Builder
	origOutput := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&logBuf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origOutput)
		log.SetFlags(origFlags)
	}()

	t1 := fixedNow.Add(1 * time.Second)
	mustNone(t, session.Tick(context.Background(), t1))
	mustRecvHealth(t, backend.healthCh)

	out := logBuf.String()
	if !strings.Contains(out, "b-log-1") {
		t.Errorf("log output missing broadcastID: %q", out)
	}
	if !strings.Contains(out, "video_frames_in=2") {
		t.Errorf("log output missing video_frames_in=2: %q", out)
	}
	if !strings.Contains(out, "audio_frames_in=3") {
		t.Errorf("log output missing audio_frames_in=3: %q", out)
	}

	// 次のtick（受信なし）ではカウンタが0にリセットされること。
	logBuf.Reset()
	t2 := t1.Add(1 * time.Second)
	mustNone(t, session.Tick(context.Background(), t2))
	mustRecvHealth(t, backend.healthCh)

	out2 := logBuf.String()
	if !strings.Contains(out2, "video_frames_in=0") || !strings.Contains(out2, "audio_frames_in=0") {
		t.Errorf("expected reset counters on 2nd tick, got: %q", out2)
	}
}

func TestTickIsNoopBeforeLive(t *testing.T) {
	backend := newFakeBackend()
	fw := &fakeFrameWriter{}
	session := NewSession(Deps{Backend: backend}, fw)

	if action := session.Tick(context.Background(), time.Now()); action != ActionNone {
		t.Fatalf("Tick before live = %v, want ActionNone", action)
	}
	select {
	case s := <-backend.healthCh:
		t.Fatalf("unexpected health report before live: %+v", s)
	default:
	}
}
