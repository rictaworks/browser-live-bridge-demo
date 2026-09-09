package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// newRouter は中継層（Gin）のルーターを組み立てます。
// 雛形段階では稼働確認用のヘルスチェックのみを提供し、業務ロジックは持ちません。
func newRouter() *gin.Engine {
	router := gin.Default()

	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	return router
}

func main() {
	router := newRouter()
	router.Run(":3002")
}
