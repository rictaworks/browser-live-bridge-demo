// Package ingest は、requirements.md 6.7節・10節を実装します。
//
// 中継プロセス内に「ローカルingest」（RTMP受け口）を持ち、RtmpPublisher（RTMPクライアント）
// が実際にRTMPハンドシェイク・publishを行ってそこへ送出します。ローカルingestが受理した
// 到達データはSinkに保持され、モニター（視聴側WebSocket）へ配信されます。
//
// 到達したデータの変換（デコード→再エンコード）はgo-flvが提供する構造体を用いて
// 行っており、符号化データ本体（NALU・AACフレーム）のバイト列そのものには一切
// 手を加えません（再エンコード禁止, 6.1節・20節）。
package ingest

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"time"

	flv "github.com/yutopp/go-flv"
	"github.com/yutopp/go-flv/tag"
)

// ErrTooManySubscribers はモニターの同時接続数上限に達したことを表します（10節）。
var ErrTooManySubscribers = errors.New("ingest: too many monitor subscribers")

// ErrSinkFinished は配信が終了したSinkへの操作を表します。
var ErrSinkFinished = errors.New("ingest: sink already finished")

type storedTag struct {
	bytes    []byte // FLVタグ本体（タグヘッダ11バイト + 符号化データ）。PreviousTagSizeは含まない。
	isVideo  bool
	isKey    bool
	isConfig bool
	storedAt time.Time
}

// Subscriber は1件のモニター接続に対応する配信キューです。
type Subscriber struct {
	ch     chan []byte // 送出すべきFLVタグ本体（storedTag.bytes相当）を1件ずつ受け取る
	closed chan struct{}
}

// Recv はライブ配信されるタグ本体を1件受信します。Sinkが終了するとcloseされます。
func (s *Subscriber) Recv() (<-chan []byte, <-chan struct{}) {
	return s.ch, s.closed
}

// Sink は1配信分の到達データ保持と、モニターへのファンアウトを担います
// （requirements.md クラス図の LocalIngestSink + MonitorBroadcaster に相当）。
type Sink struct {
	mu sync.Mutex

	retention      time.Duration
	maxSubscribers int

	tags            []storedTag
	lastKeyframeIdx int // -1 = キーフレーム未受信

	videoConfig []byte // 直近の映像設定タグ本体（保持期間の対象外で常に最新のものを保つ）
	audioConfig []byte // 直近の音声設定タグ本体

	subscribers map[*Subscriber]struct{}
	finished    bool
}

// NewSink は空のSinkを生成します。
// retention は到達映像の保持時間（無制限蓄積を避けるための上限, 6.7節）、
// maxSubscribers はモニターの同時接続数上限（10節）です。
func NewSink(retention time.Duration, maxSubscribers int) *Sink {
	return &Sink{
		retention:       retention,
		maxSubscribers:  maxSubscribers,
		lastKeyframeIdx: -1,
		subscribers:     make(map[*Subscriber]struct{}),
	}
}

// AppendVideo はRTMPで受信した映像メッセージ本体（FLV VideoData形式のバイト列）を取り込みます。
func (s *Sink) AppendVideo(timestampMs uint32, payload io.Reader) error {
	var vd tag.VideoData
	if err := tag.DecodeVideoData(payload, &vd); err != nil {
		return err
	}
	defer vd.Close()

	codecBytes, err := io.ReadAll(vd.Data)
	if err != nil {
		return err
	}

	// 符号化データ(codecBytes)には一切手を加えず、コンテナ情報のみ引き継いで
	// タグを再構成する（再エンコード禁止）。
	flvTag := &tag.FlvTag{
		TagType:   tag.TagTypeVideo,
		Timestamp: timestampMs,
		StreamID:  0,
		Data: &tag.VideoData{
			FrameType:       vd.FrameType,
			CodecID:         vd.CodecID,
			AVCPacketType:   vd.AVCPacketType,
			CompositionTime: vd.CompositionTime,
			Data:            bytes.NewReader(codecBytes),
		},
	}

	var buf bytes.Buffer
	if err := tag.EncodeFlvTag(&buf, flvTag); err != nil {
		return err
	}

	isConfig := vd.AVCPacketType == tag.AVCPacketTypeSequenceHeader
	isKey := vd.FrameType == tag.FrameTypeKeyFrame

	return s.append(storedTag{
		bytes:    buf.Bytes(),
		isVideo:  true,
		isKey:    isKey,
		isConfig: isConfig,
		storedAt: time.Now(),
	})
}

// AppendAudio はRTMPで受信した音声メッセージ本体（FLV AudioData形式のバイト列）を取り込みます。
func (s *Sink) AppendAudio(timestampMs uint32, payload io.Reader) error {
	var ad tag.AudioData
	if err := tag.DecodeAudioData(payload, &ad); err != nil {
		return err
	}
	defer ad.Close()

	codecBytes, err := io.ReadAll(ad.Data)
	if err != nil {
		return err
	}

	flvTag := &tag.FlvTag{
		TagType:   tag.TagTypeAudio,
		Timestamp: timestampMs,
		StreamID:  0,
		Data: &tag.AudioData{
			SoundFormat:   ad.SoundFormat,
			SoundRate:     ad.SoundRate,
			SoundSize:     ad.SoundSize,
			SoundType:     ad.SoundType,
			AACPacketType: ad.AACPacketType,
			Data:          bytes.NewReader(codecBytes),
		},
	}

	var buf bytes.Buffer
	if err := tag.EncodeFlvTag(&buf, flvTag); err != nil {
		return err
	}

	isConfig := ad.AACPacketType == tag.AACPacketTypeSequenceHeader

	return s.append(storedTag{
		bytes:    buf.Bytes(),
		isVideo:  false,
		isKey:    true, // 音声は破棄対象としない方針（7節）に合わせ、保持上も常に対象外扱いとしない
		isConfig: isConfig,
		storedAt: time.Now(),
	})
}

func (s *Sink) append(t storedTag) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.finished {
		return ErrSinkFinished
	}

	if t.isConfig {
		if t.isVideo {
			s.videoConfig = t.bytes
		} else {
			s.audioConfig = t.bytes
		}
		// 設定チャンクは再接続時に必ず再送されるため(6.5節)、リングバッファにも
		// 積んでおくとキーフレーム探索の起点として自然に扱える。
	}

	s.tags = append(s.tags, t)
	if t.isVideo && t.isKey {
		s.lastKeyframeIdx = len(s.tags) - 1
	}

	s.pruneLocked()
	s.fanoutLocked(t.bytes)

	return nil
}

// pruneLocked は保持時間を超えた古いタグを取り除きます（無制限蓄積の禁止, 6.7節）。
// mu をロックした状態で呼び出すこと。
func (s *Sink) pruneLocked() {
	if s.retention <= 0 || len(s.tags) == 0 {
		return
	}
	cutoff := time.Now().Add(-s.retention)

	removed := 0
	for removed < len(s.tags) && s.tags[removed].storedAt.Before(cutoff) {
		removed++
	}
	if removed == 0 {
		return
	}
	s.tags = s.tags[removed:]
	s.lastKeyframeIdx -= removed
	if s.lastKeyframeIdx < -1 {
		s.lastKeyframeIdx = -1
	}
}

func (s *Sink) fanoutLocked(tagBytes []byte) {
	for sub := range s.subscribers {
		select {
		case sub.ch <- tagBytes:
		default:
			// 受信が追いつかない購読者にはこのタグを配信しない（バックプレッシャーで
			// 中継全体を遅延させないため）。モニターは体験用の視聴経路であり、
			// 配信本体（RTMP送出）には影響しない。
		}
	}
}

// FlvHeader はFLVファイルヘッダの9バイトです。
func FlvHeader() []byte {
	var buf bytes.Buffer
	// go-flv自体はio.Writerへ直接ヘッダを書き出すAPIしか提供しないため、
	// バッファへ書かせてバイト列として取り出す。
	_ = flv.EncodeFlvHeader(&buf, &flv.Header{
		Version:    1,
		Flags:      flv.FlagsAudio | flv.FlagsVideo,
		DataOffset: flv.HeaderLength,
	})
	return buf.Bytes()
}

// Subscribe は新規モニター接続を登録します。
// 直近のキーフレーム以降のタグ（映像設定・音声設定を先頭に付与）を catchUp として返し、
// 以後のライブタグは返却された Subscriber から受信できます（10節・6.7節）。
func (s *Sink) Subscribe() (sub *Subscriber, catchUp [][]byte, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.finished {
		return nil, nil, ErrSinkFinished
	}
	if len(s.subscribers) >= s.maxSubscribers {
		return nil, nil, ErrTooManySubscribers
	}

	if s.videoConfig != nil {
		catchUp = append(catchUp, s.videoConfig)
	}
	if s.audioConfig != nil {
		catchUp = append(catchUp, s.audioConfig)
	}

	if s.lastKeyframeIdx >= 0 {
		for _, t := range s.tags[s.lastKeyframeIdx:] {
			// 設定タグは上で個別に追加済みなので二重に積まない。
			if t.isConfig {
				continue
			}
			catchUp = append(catchUp, t.bytes)
		}
	}

	sub = &Subscriber{
		ch:     make(chan []byte, 256),
		closed: make(chan struct{}),
	}
	s.subscribers[sub] = struct{}{}

	return sub, catchUp, nil
}

// Unsubscribe はモニター接続の終了時に呼び出します。
func (s *Sink) Unsubscribe(sub *Subscriber) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subscribers, sub)
}

// SubscriberCount は現在の同時接続数です。
func (s *Sink) SubscriberCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subscribers)
}

// Finish は配信終了時に呼び出し、以後のモニター購読を受け付けなくします。
// 既存の購読者にはclosedチャネルで終了を通知します（10節: 配信終了後は購読を受け付けない）。
func (s *Sink) Finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished {
		return
	}
	s.finished = true
	for sub := range s.subscribers {
		close(sub.closed)
	}
	s.subscribers = make(map[*Subscriber]struct{})
	s.tags = nil
	s.videoConfig = nil
	s.audioConfig = nil
}
