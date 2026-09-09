package wsapi

import (
	"encoding/binary"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
)

// MonitorHandler は /ws/monitor/:broadcast_token を実装します
// （requirements.md 10節・6.7節・16.4節）。
//
// DBを一切参照せず、ローカルingest（ingest.Server）が保持するSinkの有無と
// 同時接続数上限のみで購読可否を判断します（10節: 「モニターで行えるのは
// ローカルingestに到達した映像ストリームの購読のみ」）。有効であれば、
// FLVファイルヘッダに続けて直近キーフレーム以降のタグ列、以後はライブの
// タグをそのままWebSocketバイナリメッセージとして送出します
// （frontend側はflv.jsで再生する契約）。
func MonitorHandler(deps Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.Param("broadcast_token")

		sink, ok := deps.IngestSrv.Sink(token)
		if !ok {
			// 配信トークンが無効（配信が存在しない・既に終了した）。
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		sub, catchUp, err := sink.Subscribe()
		if err != nil {
			// ErrTooManySubscribers（同時接続数上限）または ErrSinkFinished（配信終了）。
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			sink.Unsubscribe(sub)
			return
		}
		defer conn.Close()
		defer sink.Unsubscribe(sub)

		// クライアントからのメッセージは想定しないが、切断検知のためだけに
		// 読み取りループを走らせる（gorilla/websocketの作法）。
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()

		if !sendFlvBytes(conn, ingest.FlvHeader()) {
			return
		}
		if !sendFlvBytes(conn, previousTagSize(0)) {
			return
		}
		for _, tagBytes := range catchUp {
			if !sendFlvTag(conn, tagBytes) {
				return
			}
		}

		recvCh, closedCh := sub.Recv()
		for {
			select {
			case tagBytes, ok := <-recvCh:
				if !ok {
					return
				}
				if !sendFlvTag(conn, tagBytes) {
					return
				}
			case <-closedCh:
				// requirements.md 10節: 配信の停止に追随して再生を終了する。
				return
			case <-clientGone:
				return
			}
		}
	}
}

func sendFlvTag(conn *websocket.Conn, tagBytes []byte) bool {
	if !sendFlvBytes(conn, tagBytes) {
		return false
	}
	return sendFlvBytes(conn, previousTagSize(len(tagBytes)))
}

func sendFlvBytes(conn *websocket.Conn, b []byte) bool {
	return conn.WriteMessage(websocket.BinaryMessage, b) == nil
}

// previousTagSize はFLVビットストリーム上、各タグの直後に置かれる
// 「直前のタグのサイズ」4バイト（ビッグエンディアン）です。
// ファイル先頭（最初のタグの前）は常に0とします。
func previousTagSize(n int) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(n))
	return buf
}
