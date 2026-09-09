package wsapi

import (
	"context"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/broadcast"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
)

// PublishHandler は /ws/publish を実装します（requirements.md 6.6節・6.7節）。
// 配信スタジオ（ブラウザ）からのWebSocket接続を受理し、1本のbroadcast.Sessionを
// 生成してフレームの受信・多重化・適応制御・ローカルingestへの送出を仲介します。
func PublishHandler(deps Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			// Upgrade失敗時点で応答は書き込み済みのため、これ以上何もしない。
			return
		}
		defer conn.Close()
		conn.SetReadLimit(maxReadLimit)

		writer := &wsFrameWriter{conn: conn}
		sessionDeps := broadcast.Deps{
			Backend:    deps.Backend,
			IngestAddr: deps.IngestAddr,
		}
		session := broadcast.NewSession(sessionDeps, writer)

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		done := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			runDrainWorker(ctx, session, done)
		}()
		go func() {
			defer workers.Done()
			runTickWorker(ctx, session, conn, done, deps.tickInterval())
		}()

		readLoop(ctx, conn, session)

		session.Close()
		close(done)
		workers.Wait()
	}
}

// readLoop はWebSocketから届く1メッセージ = 1フレームを読み取り、
// broadcast.Session へ引き渡します。構造検証に失敗したフレーム（識別子・版・
// 種別・長さの不整合）は Decode の時点で破棄されます（requirements.md 21節）。
func readLoop(ctx context.Context, conn *websocket.Conn, session *broadcast.Session) {
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.BinaryMessage {
			// テキストメッセージ等、プロトコル外のメッセージは無視する。
			continue
		}
		frame, err := protocol.Decode(data)
		if err != nil {
			continue // 21節: 逸脱するフレームは破棄する
		}
		if action := session.HandleFrame(ctx, frame); action != broadcast.ActionNone {
			return
		}
	}
}

// runDrainWorker は送出待ちキューへの新規投入を待ち、到着次第
// ローカルingestへ排出します（requirements.md 6.7節: 中継は再エンコードを
// 行わずそのまま送出する）。Session が Live 状態に至るまで Wake() は nil を
// 返すため、その間は短い間隔で再確認します。
func runDrainWorker(ctx context.Context, session *broadcast.Session, done <-chan struct{}) {
	pollTicker := time.NewTicker(5 * time.Millisecond)
	defer pollTicker.Stop()

	for {
		wake := session.Wake()
		if wake == nil {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-pollTicker.C:
				continue
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-wake:
			session.DrainOnce()
		}
	}
}

// runTickWorker は毎秒（既定値）Session.Tick を呼び出し、適応制御の評価
// （requirements.md 7節）を行います。致命的な判定（劣化の継続等）が返った
// 場合は接続を閉じ、readLoop 側をエラー終了させます。
func runTickWorker(ctx context.Context, session *broadcast.Session, conn *websocket.Conn, done <-chan struct{}, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case now := <-ticker.C:
			if action := session.Tick(ctx, now); action != broadcast.ActionNone {
				_ = conn.Close() // readLoop側のReadMessageをエラーで終了させる
				return
			}
		}
	}
}
