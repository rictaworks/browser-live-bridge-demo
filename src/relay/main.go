package main

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/backendclient"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/config"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/wsapi"
)

// newRouter は中継層（Gin）のルーターを組み立てます。
// ヘルスチェックに加え、配信スタジオからの送出受付（/ws/publish）とモニターの
// 視聴購読（/ws/monitor/:broadcast_token）を提供します（requirements.md 6.6節・10節）。
func newRouter(ingestAddr string, ingestSrv *ingest.Server, backend backendclient.Client) *gin.Engine {
	router := gin.Default()

	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	deps := wsapi.Deps{
		Backend:    backend,
		IngestAddr: ingestAddr,
		IngestSrv:  ingestSrv,
	}
	router.GET("/ws/publish", wsapi.PublishHandler(deps))
	router.GET("/ws/monitor/:broadcast_token", wsapi.MonitorHandler(deps))

	return router
}

func main() {
	cfg := config.Load()

	ingestSrv, err := ingest.NewServer(cfg.IngestAddr, cfg.IngestRetention, cfg.MonitorMaxSubscribersPerBroadcast)
	if err != nil {
		log.Fatalf("failed to start local ingest: %v", err)
	}
	go func() {
		if err := ingestSrv.Serve(); err != nil {
			log.Printf("local ingest server stopped: %v", err)
		}
	}()

	backend := backendclient.NewHTTPClient(cfg.BackendBaseURL)

	router := newRouter(cfg.IngestAddr, ingestSrv, backend)
	if err := router.Run(cfg.ListenAddr); err != nil {
		log.Fatalf("relay server stopped: %v", err)
	}
}
