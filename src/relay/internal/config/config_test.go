package config

import (
	"os"
	"testing"
	"time"
)

// clearRelayEnv は各テストが他のテストへ環境変数を持ち越さないようにします。
func clearRelayEnv(t *testing.T) {
	t.Helper()
	keys := []string{
		"RELAY_LISTEN_ADDR",
		"RELAY_INGEST_ADDR",
		"RELAY_BACKEND_URL",
		"RELAY_INGEST_RETENTION_SECONDS",
		"RELAY_MONITOR_MAX_SUBSCRIBERS",
	}
	for _, k := range keys {
		orig, had := os.LookupEnv(k)
		os.Unsetenv(k)
		t.Cleanup(func() {
			if had {
				os.Setenv(k, orig)
			} else {
				os.Unsetenv(k)
			}
		})
	}
}

func TestLoadUsesDevelopmentDefaultsWhenUnset(t *testing.T) {
	clearRelayEnv(t)

	cfg := Load()

	if cfg.ListenAddr != ":3002" {
		t.Errorf("ListenAddr = %q, want :3002", cfg.ListenAddr)
	}
	if cfg.IngestAddr != "127.0.0.1:19350" {
		t.Errorf("IngestAddr = %q, want 127.0.0.1:19350 (loopback-only default)", cfg.IngestAddr)
	}
	if cfg.BackendBaseURL != "http://backend:3001" {
		t.Errorf("BackendBaseURL = %q, want http://backend:3001", cfg.BackendBaseURL)
	}
	if cfg.IngestRetention != 8*time.Second {
		t.Errorf("IngestRetention = %v, want 8s", cfg.IngestRetention)
	}
	if cfg.MonitorMaxSubscribersPerBroadcast != 50 {
		t.Errorf("MonitorMaxSubscribersPerBroadcast = %d, want 50", cfg.MonitorMaxSubscribersPerBroadcast)
	}
}

func TestLoadReadsOverridesFromEnv(t *testing.T) {
	clearRelayEnv(t)

	os.Setenv("RELAY_LISTEN_ADDR", ":9999")
	os.Setenv("RELAY_INGEST_ADDR", "127.0.0.1:9350")
	os.Setenv("RELAY_BACKEND_URL", "http://backend.internal:3001")
	os.Setenv("RELAY_INGEST_RETENTION_SECONDS", "20")
	os.Setenv("RELAY_MONITOR_MAX_SUBSCRIBERS", "5")

	cfg := Load()

	if cfg.ListenAddr != ":9999" {
		t.Errorf("ListenAddr = %q, want :9999", cfg.ListenAddr)
	}
	if cfg.IngestAddr != "127.0.0.1:9350" {
		t.Errorf("IngestAddr = %q, want 127.0.0.1:9350", cfg.IngestAddr)
	}
	if cfg.BackendBaseURL != "http://backend.internal:3001" {
		t.Errorf("BackendBaseURL = %q, want http://backend.internal:3001", cfg.BackendBaseURL)
	}
	if cfg.IngestRetention != 20*time.Second {
		t.Errorf("IngestRetention = %v, want 20s", cfg.IngestRetention)
	}
	if cfg.MonitorMaxSubscribersPerBroadcast != 5 {
		t.Errorf("MonitorMaxSubscribersPerBroadcast = %d, want 5", cfg.MonitorMaxSubscribersPerBroadcast)
	}
}

func TestLoadFallsBackOnInvalidNumericEnv(t *testing.T) {
	clearRelayEnv(t)

	os.Setenv("RELAY_INGEST_RETENTION_SECONDS", "not-a-number")
	os.Setenv("RELAY_MONITOR_MAX_SUBSCRIBERS", "not-a-number")

	cfg := Load()

	if cfg.IngestRetention != 8*time.Second {
		t.Errorf("IngestRetention = %v, want fallback 8s for invalid input", cfg.IngestRetention)
	}
	if cfg.MonitorMaxSubscribersPerBroadcast != 50 {
		t.Errorf("MonitorMaxSubscribersPerBroadcast = %d, want fallback 50 for invalid input", cfg.MonitorMaxSubscribersPerBroadcast)
	}
}
