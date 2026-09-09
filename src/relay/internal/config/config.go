// Package config は環境変数から中継層の設定を読み込みます。
// requirements.md 21節「外部通信」要件により、中継層は外部サービスの資格情報を
// 一切保持しません。ここで読み込むのはリスニングアドレスや内部通信先URLのみです。
package config

import (
	"os"
	"strconv"
	"time"
)

// Config は中継層の起動設定です。
type Config struct {
	// ListenAddr はGin（WebSocket・ヘルスチェック）の待受けアドレスです。
	ListenAddr string
	// IngestAddr はローカルingest（RTMPサーバー）の待受けアドレスです。
	// 外部から到達可能にする必要はなく、既定ではループバックに限定します。
	IngestAddr string
	// BackendBaseURL はアプリケーション層（Rails）内部APIのベースURLです。
	BackendBaseURL string
	// IngestRetention は到達映像の保持時間です（6.7節: 無制限蓄積の禁止）。
	IngestRetention time.Duration
	// MonitorMaxSubscribersPerBroadcast は配信1本あたりのモニター同時接続数上限です（10節）。
	MonitorMaxSubscribersPerBroadcast int
}

// Load は環境変数からConfigを構築します。未設定の項目は開発用の既定値を用います。
func Load() Config {
	return Config{
		ListenAddr:                        getEnv("RELAY_LISTEN_ADDR", ":3002"),
		IngestAddr:                        getEnv("RELAY_INGEST_ADDR", "127.0.0.1:19350"),
		BackendBaseURL:                    getEnv("RELAY_BACKEND_URL", "http://backend:3001"),
		IngestRetention:                   getEnvDuration("RELAY_INGEST_RETENTION_SECONDS", 8*time.Second),
		MonitorMaxSubscribersPerBroadcast: getEnvInt("RELAY_MONITOR_MAX_SUBSCRIBERS", 50),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	secs, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return time.Duration(secs) * time.Second
}
