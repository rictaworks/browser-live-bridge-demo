// Package wsapi は、requirements.md 6.6節・10節のWebSocketエンドポイントを
// Gin上に実装します。配信スタジオからの送出受付（/ws/publish）と、
// モニターからの視聴購読（/ws/monitor/:broadcast_token）の2本です。
//
// フレームの検証・多重化・適応制御そのものは broadcast パッケージが担い、
// 本パッケージはWebSocketの読み書きとゴルーチンの配線のみを担当します。
package wsapi

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
)

// Deps は wsapi ハンドラの依存部品です。
type Deps struct {
	// Backend はアプリケーション層（Rails）内部APIの呼び出し先です。
	Backend backendclient.Client
	// IngestAddr はローカルingest（RTMPサーバー）の待受けアドレスです。
	// PublishHandler がこのアドレスへ publish 接続を確立します。
	IngestAddr string
	// IngestSrv はローカルingestそのものです。MonitorHandler がここから
	// 配信トークンに対応するSinkを取得します。
	IngestSrv *ingest.Server
	// TickInterval は適応制御評価の周期です（省略時は1秒, requirements.md 7節）。
	TickInterval time.Duration
}

func (d Deps) tickInterval() time.Duration {
	if d.TickInterval > 0 {
		return d.TickInterval
	}
	return 1 * time.Second
}

// upgrader はHTTP接続をWebSocketへ引き上げます。
// requirements.md 21節「認証・認可を設計に組み込まない」方針のとおり、
// 本デモにOriginベースの制限は設けません（送出先も自プロセス内に限定されるため
// 想定される攻撃面は限定的です）。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// maxReadLimit はWebSocket 1メッセージあたりの読み取り上限です。
// protocol.MaxBodyLength を超える本文を宣言するフレームは Decode 側で
// 破棄されますが、その判定に至る前の際限ない読み込みを避けるための安全弁です。
const maxReadLimit = int64(protocol.HeaderLength + protocol.MaxBodyLength)

// wsFrameWriter は broadcast.FrameWriter の実装です。
// 同一WebSocket接続への書き込みは、送出ワーカー・Tickゴルーチン・読み取り
// ループ（開始通知への即時応答）の複数箇所から発生し得るため、排他します。
type wsFrameWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsFrameWriter) WriteFrame(f protocol.Frame) error {
	encoded, err := protocol.Encode(f)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.BinaryMessage, encoded)
}
