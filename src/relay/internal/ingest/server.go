package ingest

import (
	"errors"
	"io"
	"net"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/yutopp/go-rtmp"
	"github.com/yutopp/go-rtmp/message"
)

// Server は「ローカルingest」（requirements.md 1.3節・2.1節）そのものです。
// 自プロセス内でRTMPサーバーとして待受け、RtmpPublisher（同一プロセス内のRTMPクライアント）
// からのpublishのみを受理します。ネットワーク越しの外部への送出・外部からの着信は
// 想定しません（ホストは既定でループバックに限定してください）。
type Server struct {
	rtmpSrv  *rtmp.Server
	listener net.Listener
	registry *registry

	retention      time.Duration
	maxSubscribers int
	logger         *logrus.Logger
}

// NewServer はローカルingestを構築します。
//
//	addr: 待受けアドレス（例: "127.0.0.1:19350"）
//	retention: 到達映像の保持時間（6.7節: 無制限蓄積の禁止）
//	maxSubscribersPerBroadcast: 配信1本あたりのモニター同時接続数上限（10節）
func NewServer(addr string, retention time.Duration, maxSubscribersPerBroadcast int) (*Server, error) {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}

	logger := logrus.New()
	logger.SetLevel(logrus.ErrorLevel) // 開発時のRTMP内部ログは抑制する。

	s := &Server{
		listener:       listener,
		registry:       newRegistry(),
		retention:      retention,
		maxSubscribers: maxSubscribersPerBroadcast,
		logger:         logger,
	}

	s.rtmpSrv = rtmp.NewServer(&rtmp.ServerConfig{
		OnConnect: func(conn net.Conn) (io.ReadWriteCloser, *rtmp.ConnConfig) {
			return conn, &rtmp.ConnConfig{
				Handler: &connHandler{server: s},
				Logger:  logger,
			}
		},
	})

	return s, nil
}

// Addr は実際に待受けているアドレスです（ポート0を渡した場合の実ポート確認等に使用）。
func (s *Server) Addr() net.Addr {
	return s.listener.Addr()
}

// Serve は接続の受付を開始します（ブロッキング）。
func (s *Server) Serve() error {
	return s.rtmpSrv.Serve(s.listener)
}

// Close はローカルingestを停止します。
func (s *Server) Close() error {
	return s.rtmpSrv.Close()
}

// Sink はストリームキー（配信トークン）に対応するSinkを返します。
// モニター側WebSocketハンドラは、DBを一切参照せずここだけを見て購読可否を判断します
// （10節: 「モニターで行えるのは...映像ストリームの購読のみ」）。
func (s *Server) Sink(streamKey string) (*Sink, bool) {
	return s.registry.get(streamKey)
}

// connHandler は1本のRTMP接続（= 1本の配信のpublish）を処理します。
// go-rtmp の Handler インターフェースを実装し、受理した音声・映像を
// 対応する Sink へ橋渡しします。
type connHandler struct {
	rtmp.DefaultHandler

	server    *Server
	streamKey string
	sink      *Sink
}

var errEmptyPublishingName = errors.New("ingest: publishing name (stream key) is empty")
var errMediaBeforePublish = errors.New("ingest: media received before publish")

func (h *connHandler) OnPublish(_ *rtmp.StreamContext, _ uint32, cmd *message.NetStreamPublish) error {
	if cmd.PublishingName == "" {
		return errEmptyPublishingName
	}
	h.streamKey = cmd.PublishingName
	h.sink = h.server.registry.getOrCreate(h.streamKey, h.server.retention, h.server.maxSubscribers)
	return nil
}

func (h *connHandler) OnAudio(timestamp uint32, payload io.Reader) error {
	if h.sink == nil {
		return errMediaBeforePublish
	}
	return h.sink.AppendAudio(timestamp, payload)
}

func (h *connHandler) OnVideo(timestamp uint32, payload io.Reader) error {
	if h.sink == nil {
		return errMediaBeforePublish
	}
	return h.sink.AppendVideo(timestamp, payload)
}

func (h *connHandler) OnClose() {
	if h.sink != nil {
		h.sink.Finish()
		h.server.registry.remove(h.streamKey)
	}
}
