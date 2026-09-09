package ingest

import (
	"bytes"
	"sync"

	"github.com/sirupsen/logrus"
	"github.com/yutopp/go-rtmp"
	"github.com/yutopp/go-rtmp/message"
)

// チャンクストリームID。RTMP仕様上0-2は制御用に予約されているため、
// go-rtmpのexample（server_relay_demo）に倣い音声・映像で別IDを用いる。
const (
	audioChunkStreamID    = 5
	videoChunkStreamID    = 6
	createStreamChunkSize = 128
)

// Publisher は「ローカルingestへのRTMP publish」を行うRTMPクライアントです
// （requirements.md クラス図の RtmpPublisher に相当）。
//
// 受け取った符号化データ（FLV AudioData/VideoData形式のバイト列）を、
// go-rtmp が提供するRTMPハンドシェイク・メッセージ送信機能を用いてそのまま
// 送出します。ここでもエンコード・デコードは行わず、バイト列を右から左へ
// 受け渡すのみです（再エンコード禁止）。
type Publisher struct {
	conn   *rtmp.ClientConn
	stream *rtmp.Stream

	// mu は同一ストリームへの並行書き込み（送出ワーカーからのキュー排出と、
	// ライブ中の設定再送が別ゴルーチンから同時に発生し得るため）を直列化します。
	mu sync.Mutex
}

// Dial はローカルingest（addr）へ接続し、RTMPハンドシェイク・publishまでを行います。
// requirements.md 6.7節の要件により、呼び出し側は映像設定・音声設定の両方を
// 受け取ってから本関数を呼び出してください（本関数自体はpublish開始のみを担当します）。
func Dial(addr string, streamKey string) (*Publisher, error) {
	logger := logrus.New()
	logger.SetLevel(logrus.ErrorLevel)

	conn, err := rtmp.Dial("rtmp", addr, &rtmp.ConnConfig{
		Logger: logger,
	})
	if err != nil {
		return nil, err
	}

	if err := conn.Connect(nil); err != nil {
		_ = conn.Close()
		return nil, err
	}

	stream, err := conn.CreateStream(nil, createStreamChunkSize)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}

	if err := stream.Publish(&message.NetStreamPublish{
		PublishingName: streamKey,
		PublishingType: "live",
	}); err != nil {
		_ = stream.Close()
		_ = conn.Close()
		return nil, err
	}

	return &Publisher{conn: conn, stream: stream}, nil
}

// WriteVideo は映像タグ本体（FLV VideoData形式）をRTMPの映像メッセージとして送出します。
// タグの時刻(timestampMs)は呼び出し側から渡されたメディアクロック由来の値をそのまま用い、
// 中継側で再採番しません（requirements.md 6.7節）。
func (p *Publisher) WriteVideo(timestampMs uint32, flvVideoDataBytes []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stream.Write(videoChunkStreamID, timestampMs, &message.VideoMessage{
		Payload: bytes.NewReader(flvVideoDataBytes),
	})
}

// WriteAudio は音声タグ本体（FLV AudioData形式）をRTMPの音声メッセージとして送出します。
func (p *Publisher) WriteAudio(timestampMs uint32, flvAudioDataBytes []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stream.Write(audioChunkStreamID, timestampMs, &message.AudioMessage{
		Payload: bytes.NewReader(flvAudioDataBytes),
	})
}

// Close は配信終了時にRTMP接続を閉じます。
func (p *Publisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.stream.Close()
	return p.conn.Close()
}
