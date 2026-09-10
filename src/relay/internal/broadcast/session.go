// Package broadcast は、1本の配信publish接続（requirements.mdクラス図の
// IngestSession に相当）のライフサイクルを実装します。
//
// WebSocketで受信したフレーム（protocol.Frame）を検証・多重化し、
// ローカルingestへのRTMP publish（ingest.Publisher）へ橋渡しします。
// 適応制御（7節）はratecontrolパッケージの部品を用いて中継自身の
// 送出待ちキューに対して行い、判定結果を制御フレームとして送信側へ返します。
package broadcast

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/muxer"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ratecontrol"
)

// FrameWriter は、中継からブラウザ配信スタジオへ制御フレームを送信する経路です。
// 実装（WebSocket送信）は wsapi パッケージが担います。
type FrameWriter interface {
	WriteFrame(f protocol.Frame) error
}

// Publisher は、ローカルingestへ多重化済みデータを送出する経路です
// （requirements.md クラス図の RtmpPublisher に相当。実装は ingest.Publisher）。
// テスト容易性のため、具象型ではなくインターフェースとして受け取ります。
type Publisher interface {
	WriteVideo(timestampMs uint32, flvVideoDataBytes []byte) error
	WriteAudio(timestampMs uint32, flvAudioDataBytes []byte) error
	Close() error
}

type sessionState int

const (
	stateAwaitingStart sessionState = iota
	stateAwaitingConfig
	stateLive
	stateEnded
)

// Action は HandleFrame / Tick の呼び出し元（wsapi）に対する後続動作の指示です。
type Action int

const (
	ActionNone Action = iota
	// ActionCloseGraceful は正常終了（終了通知の受理等）による接続クローズを表します。
	ActionCloseGraceful
	// ActionCloseFatal は致命的な状態（照合失敗・劣化継続等）による接続クローズを表します。
	ActionCloseFatal
)

// Deps は Session の依存部品です。
type Deps struct {
	Backend    backendclient.Client
	IngestAddr string
	// Now は現在時刻の取得手段です（テスト容易性のため注入可能にしています）。
	// 6.5節のメディアクロックとは異なり、ここでの時刻は中継内部のキュー滞留時間
	// （実時計基準, 3節「滞留時間」の定義）計測にのみ使用します。
	Now func() time.Time
	// DialIngest はローカルingestへのRTMP publish接続を確立します（テスト差し替え用）。
	DialIngest func(addr, streamKey string) (Publisher, error)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) dial(addr, streamKey string) (Publisher, error) {
	if d.DialIngest != nil {
		return d.DialIngest(addr, streamKey)
	}
	return ingest.Dial(addr, streamKey)
}

// Session は1本の配信publish接続を管理します。
type Session struct {
	deps Deps
	out  FrameWriter

	mu    sync.Mutex
	state sessionState

	sessionKey     string
	broadcastToken string
	broadcastID    string

	queue             *ratecontrol.Queue
	governor          *ratecontrol.BitrateGovernor
	lastReportedState ratecontrol.State

	publisher Publisher

	pendingVideoConfig          []byte
	pendingVideoConfigTimestamp uint32
	pendingAudioConfig          []byte
	pendingAudioConfigTimestamp uint32
	haveVideoConfig             bool
	haveAudioConfig             bool

	lastVideoTimestamp uint64
	seenVideo          bool
	lastAudioTimestamp uint64
	seenAudio          bool

	// 送出ビットレート計測用（12.1節・16.2節の健全性表示）。DrainOnceで
	// 実際にpublisherへ書き出したバイト数を積算し、Tickで直前計測からの
	// 経過時間で割ってkbpsを算出したのち、この2つをリセットする。
	sentBytesSinceTick uint64
	lastTickAt         time.Time
}

// NewSession は開始通知待ちの新規Sessionを生成します。
func NewSession(deps Deps, out FrameWriter) *Session {
	return &Session{deps: deps, out: out, state: stateAwaitingStart}
}

// BroadcastID は照合済みの配信IDです（未照合の場合は空文字）。
func (s *Session) BroadcastID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.broadcastID
}

// HandleFrame は1件のフレームを処理します。
func (s *Session) HandleFrame(ctx context.Context, f protocol.Frame) Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch s.state {
	case stateAwaitingStart:
		return s.handleAwaitingStartLocked(ctx, f)
	case stateAwaitingConfig:
		return s.handleAwaitingConfigLocked(f)
	case stateLive:
		return s.handleLiveLocked(f)
	default: // stateEnded
		return ActionNone
	}
}

func (s *Session) handleAwaitingStartLocked(ctx context.Context, f protocol.Frame) Action {
	// requirements.md 6.6節: 開始通知の完了前に受信したメディアフレームは破棄すること。
	if f.Kind != protocol.KindControl {
		return ActionNone
	}
	ct, err := protocol.PeekControlType(f.Body)
	if err != nil || ct != protocol.ControlStartNotice {
		return ActionNone
	}
	notice, err := protocol.DecodeStartNotice(f.Body)
	if err != nil {
		return ActionNone // 破棄（21節: 逸脱フレームの破棄）
	}

	result, verr := s.deps.Backend.Verify(ctx, notice.SessionKey, notice.BroadcastToken)
	if verr != nil || !result.Valid {
		_ = s.out.WriteFrame(fatalFrame(s.deps.now(), "verification_failed"))
		s.state = stateEnded
		return ActionCloseFatal
	}

	s.sessionKey = notice.SessionKey
	s.broadcastToken = notice.BroadcastToken
	s.broadcastID = result.BroadcastID
	s.state = stateAwaitingConfig

	_ = s.out.WriteFrame(ackFrame(s.deps.now()))
	return ActionNone
}

func (s *Session) handleAwaitingConfigLocked(f protocol.Frame) Action {
	switch f.Kind {
	case protocol.KindVideoConfig:
		encoded, err := muxer.EncodeVideoConfig(f.Body)
		if err != nil {
			return ActionNone
		}
		s.pendingVideoConfig = encoded
		s.pendingVideoConfigTimestamp = toRTMPTimestamp(f.TimestampMicros)
		s.haveVideoConfig = true

	case protocol.KindAudioConfig:
		encoded, err := muxer.EncodeAudioConfig(f.Body)
		if err != nil {
			return ActionNone
		}
		s.pendingAudioConfig = encoded
		s.pendingAudioConfigTimestamp = toRTMPTimestamp(f.TimestampMicros)
		s.haveAudioConfig = true

	case protocol.KindControl:
		if ct, err := protocol.PeekControlType(f.Body); err == nil && ct == protocol.ControlEndNotice {
			notice, _ := protocol.DecodeEndNotice(f.Body)
			reason := notice.Reason
			if reason == "" {
				reason = "unspecified"
			}
			s.state = stateEnded
			s.finishBackendAsync(reason)
			return ActionCloseGraceful
		}
		return ActionNone

	default:
		// requirements.md 6.7節: 映像設定・音声設定を受け取るまでpublishを開始しないため、
		// この時点で届く映像・音声フレームは破棄する。
		return ActionNone
	}

	if s.haveVideoConfig && s.haveAudioConfig {
		return s.startPublishLocked()
	}
	return ActionNone
}

func (s *Session) startPublishLocked() Action {
	pub, err := s.deps.dial(s.deps.IngestAddr, s.broadcastToken)
	if err != nil {
		_ = s.out.WriteFrame(fatalFrame(s.deps.now(), "ingest_connect_failed"))
		s.state = stateEnded
		return ActionCloseFatal
	}

	if err := pub.WriteVideo(s.pendingVideoConfigTimestamp, s.pendingVideoConfig); err != nil {
		_ = s.out.WriteFrame(fatalFrame(s.deps.now(), "ingest_write_failed"))
		s.state = stateEnded
		return ActionCloseFatal
	}
	if err := pub.WriteAudio(s.pendingAudioConfigTimestamp, s.pendingAudioConfig); err != nil {
		_ = s.out.WriteFrame(fatalFrame(s.deps.now(), "ingest_write_failed"))
		s.state = stateEnded
		return ActionCloseFatal
	}

	s.publisher = pub
	s.queue = ratecontrol.NewQueue()
	s.governor = ratecontrol.NewBitrateGovernor(ratecontrol.DefaultConfig())
	s.lastReportedState = ratecontrol.StateLive
	s.sentBytesSinceTick = 0
	s.lastTickAt = s.deps.now()
	s.state = stateLive

	// requirements.md 16.3節: 接続確立直後にキーフレーム発行を求め、モニターの
	// 新規購読者が即座に描画を開始できるようにする。
	_ = s.out.WriteFrame(keyframeRequestFrame(s.deps.now()))

	return ActionNone
}

func (s *Session) handleLiveLocked(f protocol.Frame) Action {
	switch f.Kind {
	case protocol.KindVideoConfig:
		// requirements.md 6.5節: 再接続時は初期化情報を再送すること。
		if encoded, err := muxer.EncodeVideoConfig(f.Body); err == nil {
			_ = s.publisher.WriteVideo(toRTMPTimestamp(f.TimestampMicros), encoded)
		}

	case protocol.KindAudioConfig:
		if encoded, err := muxer.EncodeAudioConfig(f.Body); err == nil {
			_ = s.publisher.WriteAudio(toRTMPTimestamp(f.TimestampMicros), encoded)
		}

	case protocol.KindVideo:
		if !s.validateVideoTimestampLocked(f.TimestampMicros) {
			return ActionNone // 21節: 時刻の整合検証に反するフレームは破棄
		}
		encoded, err := muxer.EncodeVideo(f.KeyFrame, f.Body)
		if err != nil {
			return ActionNone
		}
		s.queue.Enqueue(ratecontrol.Item{
			Kind: ratecontrol.ItemVideo, KeyFrame: f.KeyFrame,
			Timestamp: f.TimestampMicros, EnqueuedAt: s.deps.now(), Payload: encoded,
		})

	case protocol.KindAudio:
		if !s.validateAudioTimestampLocked(f.TimestampMicros) {
			return ActionNone
		}
		encoded, err := muxer.EncodeAudio(f.Body)
		if err != nil {
			return ActionNone
		}
		// requirements.md 7節: 音声フレームは破棄対象としない。
		s.queue.Enqueue(ratecontrol.Item{
			Kind: ratecontrol.ItemAudio, KeyFrame: true,
			Timestamp: f.TimestampMicros, EnqueuedAt: s.deps.now(), Payload: encoded,
		})

	case protocol.KindControl:
		ct, err := protocol.PeekControlType(f.Body)
		if err != nil {
			return ActionNone
		}
		switch ct {
		case protocol.ControlEndNotice:
			notice, _ := protocol.DecodeEndNotice(f.Body)
			reason := notice.Reason
			if reason == "" {
				reason = "unspecified"
			}
			s.state = stateEnded
			s.finishBackendAsync(reason)
			return ActionCloseGraceful
		}
	}
	return ActionNone
}

func (s *Session) validateVideoTimestampLocked(ts uint64) bool {
	if s.seenVideo && ts < s.lastVideoTimestamp {
		return false
	}
	s.lastVideoTimestamp = ts
	s.seenVideo = true
	return true
}

func (s *Session) validateAudioTimestampLocked(ts uint64) bool {
	if s.seenAudio && ts < s.lastAudioTimestamp {
		return false
	}
	s.lastAudioTimestamp = ts
	s.seenAudio = true
	return true
}

// DrainOnce はキュー内のフレームを可能な限りローカルingestへ送出します。
// wsapi 側の送出ワーカーが定期的（またはキュー投入の通知を受けて）呼び出します。
func (s *Session) DrainOnce() {
	s.mu.Lock()
	pub := s.publisher
	q := s.queue
	s.mu.Unlock()

	if pub == nil || q == nil {
		return
	}

	for {
		item, ok := q.Drain()
		if !ok {
			return
		}
		var err error
		switch item.Kind {
		case ratecontrol.ItemVideo:
			err = pub.WriteVideo(toRTMPTimestamp(item.Timestamp), item.Payload)
		case ratecontrol.ItemAudio:
			err = pub.WriteAudio(toRTMPTimestamp(item.Timestamp), item.Payload)
		}
		if err != nil {
			// ingestとの接続断等。ここでは送出を諦めるに留め、Tick側の劣化検知・
			// 再接続要求に処理を委ねる。
			return
		}
		s.mu.Lock()
		s.sentBytesSinceTick += uint64(len(item.Payload))
		s.mu.Unlock()
	}
}

// Wake はキューへの新規投入通知チャネルです（stateLive未到達の間はnil）。
func (s *Session) Wake() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.queue == nil {
		return nil
	}
	return s.queue.Wake()
}

// Tick は毎秒1回呼び出され、適応制御の評価（7節）と健全性報告を行います。
func (s *Session) Tick(ctx context.Context, now time.Time) Action {
	s.mu.Lock()
	if s.state != stateLive {
		s.mu.Unlock()
		return ActionNone
	}
	q := s.queue
	gov := s.governor
	broadcastID := s.broadcastID
	broadcastToken := s.broadcastToken
	s.mu.Unlock()

	delay := q.QueueDelay(now)
	decision := gov.Evaluate(now, delay)

	if decision.ShouldDropOldNonKeyVideo {
		for {
			if q.QueueDelay(now) <= ratecontrol.QueueDelayDropThreshold {
				break
			}
			if !q.DropOldestNonKeyVideo() {
				break
			}
			gov.RecordDrop(now)
		}
	}

	if decision.BitrateChanged {
		_ = s.out.WriteFrame(throttleFrame(now, decision.TargetBitrateKbps))
	}

	s.mu.Lock()
	stateChanged := decision.State != s.lastReportedState
	s.lastReportedState = decision.State
	sentBytes := s.sentBytesSinceTick
	s.sentBytesSinceTick = 0
	elapsed := now.Sub(s.lastTickAt)
	s.lastTickAt = now
	s.mu.Unlock()

	sentBitrateKbps := 0
	if elapsed > 0 && sentBytes > 0 {
		sentBitrateKbps = int(float64(sentBytes*8) / 1000 / elapsed.Seconds())
	}
	if stateChanged {
		detail := fmt.Sprintf("state=%s queue_delay_ms=%d", decision.State.String(), delay.Milliseconds())
		go func() {
			_ = s.deps.Backend.ReportEvent(ctx, broadcastID, broadcastToken, "state_changed", detail)
		}()
	}

	sample := backendclient.HealthSample{
		QueueMs:            delay.Milliseconds(),
		SentBitrateKbps:    sentBitrateKbps,
		TargetBitrateKbps:  int(decision.TargetBitrateKbps),
		DroppedVideoFrames: int64(q.DroppedVideoFrames()),
		DroppedAudioFrames: int64(q.DroppedAudioFrames()),
		State:              decision.State.String(),
	}
	go func() {
		_ = s.deps.Backend.ReportHealth(ctx, broadcastID, broadcastToken, sample)
	}()

	if decision.ShouldReconnect {
		_ = s.out.WriteFrame(fatalFrame(now, "queue_congestion_sustained"))
		go func() {
			_ = s.deps.Backend.ReportEvent(ctx, broadcastID, broadcastToken, "reconnect_requested", "queue delay exceeded degraded threshold for sustained duration")
		}()
		s.mu.Lock()
		s.state = stateEnded
		s.mu.Unlock()
		return ActionCloseFatal
	}

	return ActionNone
}

// Close は接続終了時の後始末です。publish済みであればRTMP接続を閉じます。
func (s *Session) Close() {
	s.mu.Lock()
	pub := s.publisher
	s.publisher = nil
	s.mu.Unlock()
	if pub != nil {
		_ = pub.Close()
	}
}

func (s *Session) finishBackendAsync(reason string) {
	broadcastID := s.broadcastID
	broadcastToken := s.broadcastToken
	go func() {
		_ = s.deps.Backend.Finish(context.Background(), broadcastID, broadcastToken, reason)
	}()
}

func toRTMPTimestamp(micros uint64) uint32 {
	return uint32(micros / 1000)
}

func ackFrame(now time.Time) protocol.Frame {
	return protocol.Frame{
		Kind:            protocol.KindControl,
		TimestampMicros: uint64(now.UnixMicro()),
		Body:            protocol.EncodeAck(protocol.Ack{ReceivedAtMicros: uint64(now.UnixMicro())}),
	}
}

func keyframeRequestFrame(now time.Time) protocol.Frame {
	return protocol.Frame{
		Kind:            protocol.KindControl,
		TimestampMicros: uint64(now.UnixMicro()),
		Body:            protocol.EncodeKeyframeRequest(),
	}
}

func fatalFrame(now time.Time, reason string) protocol.Frame {
	return protocol.Frame{
		Kind:            protocol.KindControl,
		TimestampMicros: uint64(now.UnixMicro()),
		Body:            protocol.EncodeFatal(protocol.FatalNotice{Reason: reason}),
	}
}

func throttleFrame(now time.Time, targetKbps uint32) protocol.Frame {
	return protocol.Frame{
		Kind:            protocol.KindControl,
		TimestampMicros: uint64(now.UnixMicro()),
		Body:            protocol.EncodeThrottleInstruction(protocol.ThrottleInstruction{TargetBitrateKbps: targetKbps}),
	}
}
