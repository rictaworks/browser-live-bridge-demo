package ratecontrol

import (
	"testing"
	"time"
)

func baseTime() time.Time {
	return time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
}

func TestInitialTargetBitrate(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	if got := g.TargetBitrateKbps(); got != 2500 {
		t.Fatalf("initial target = %d, want 2500", got)
	}
	if g.State() != StateLive {
		t.Fatalf("initial state = %v, want Live", g.State())
	}
}

func TestDecreaseAfterTwoConsecutiveHighDelays(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d1 := g.Evaluate(now, 1600*time.Millisecond)
	if d1.BitrateChanged {
		t.Fatalf("bitrate should not change on first high-delay sample")
	}
	if d1.TargetBitrateKbps != 2500 {
		t.Fatalf("target after 1st sample = %d, want 2500", d1.TargetBitrateKbps)
	}

	now = now.Add(1 * time.Second)
	d2 := g.Evaluate(now, 1600*time.Millisecond)
	if !d2.BitrateChanged {
		t.Fatalf("bitrate should change on 2nd consecutive high-delay sample")
	}
	want := uint32(2500 * 0.70) // 30%引き下げ
	if d2.TargetBitrateKbps != want {
		t.Fatalf("target after 2nd sample = %d, want %d", d2.TargetBitrateKbps, want)
	}
}

func TestDecreaseDoesNotTriggerOnSingleSpike(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	g.Evaluate(now, 1600*time.Millisecond)
	now = now.Add(1 * time.Second)
	// 滞留が回復すれば連続カウントはリセットされる。
	d2 := g.Evaluate(now, 500*time.Millisecond)
	if d2.BitrateChanged && d2.TargetBitrateKbps < 2500 {
		t.Fatalf("should not decrease after recovery, got %d", d2.TargetBitrateKbps)
	}
}

func TestDecreaseClampsAtLowerBound(t *testing.T) {
	cfg := DefaultConfig()
	cfg.InitialBitrateKbps = 900
	g := NewBitrateGovernor(cfg)
	now := baseTime()

	g.Evaluate(now, 2000*time.Millisecond)
	now = now.Add(1 * time.Second)
	d := g.Evaluate(now, 2000*time.Millisecond)

	if d.TargetBitrateKbps < cfg.MinBitrateKbps {
		t.Fatalf("target %d below floor %d", d.TargetBitrateKbps, cfg.MinBitrateKbps)
	}
	if d.TargetBitrateKbps != cfg.MinBitrateKbps {
		t.Fatalf("target = %d, want floor %d (900*0.7=630 < 800)", d.TargetBitrateKbps, cfg.MinBitrateKbps)
	}
}

func TestIncreaseWhenDelayLowAndNoRecentDrop(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d := g.Evaluate(now, 100*time.Millisecond)
	if !d.BitrateChanged {
		t.Fatalf("expected bitrate increase")
	}
	want := uint32(2500 * 1.10)
	if d.TargetBitrateKbps != want {
		t.Fatalf("target = %d, want %d", d.TargetBitrateKbps, want)
	}
}

func TestIncreaseSmallerThanDecrease(t *testing.T) {
	if IncreaseFactor >= DecreaseFactor {
		t.Fatalf("increase factor (%v) must be smaller than decrease factor (%v)", IncreaseFactor, DecreaseFactor)
	}
}

func TestIncreaseSuppressedByRecentDrop(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	g.RecordDrop(now)
	d := g.Evaluate(now, 100*time.Millisecond)
	if d.BitrateChanged {
		t.Fatalf("should not increase within 10s of a drop, got change to %d", d.TargetBitrateKbps)
	}
}

func TestIncreaseResumesAfterDropWindowExpires(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	g.RecordDrop(now)
	now = now.Add(NoDropLookback + time.Second)
	d := g.Evaluate(now, 100*time.Millisecond)
	if !d.BitrateChanged {
		t.Fatalf("expected increase once drop window has expired")
	}
}

func TestIncreaseClampsAtUpperBound(t *testing.T) {
	cfg := DefaultConfig()
	cfg.InitialBitrateKbps = 3900
	g := NewBitrateGovernor(cfg)
	now := baseTime()

	d := g.Evaluate(now, 100*time.Millisecond)
	if d.TargetBitrateKbps != cfg.MaxBitrateKbps {
		t.Fatalf("target = %d, want ceiling %d", d.TargetBitrateKbps, cfg.MaxBitrateKbps)
	}
}

func TestBitrateChangeLimitedToOncePerSecond(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d1 := g.Evaluate(now, 100*time.Millisecond)
	if !d1.BitrateChanged {
		t.Fatalf("expected first change to apply")
	}

	// 500ms後、まだ十分な間隔が空いていない。
	now = now.Add(500 * time.Millisecond)
	d2 := g.Evaluate(now, 100*time.Millisecond)
	if d2.BitrateChanged {
		t.Fatalf("bitrate should not change more than once per second")
	}
	if d2.TargetBitrateKbps != d1.TargetBitrateKbps {
		t.Fatalf("target should remain %d until interval elapses, got %d", d1.TargetBitrateKbps, d2.TargetBitrateKbps)
	}
}

func TestDropOldNonKeyVideoAboveFourSeconds(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d := g.Evaluate(now, 4500*time.Millisecond)
	if !d.ShouldDropOldNonKeyVideo {
		t.Fatalf("expected drop policy to trigger above 4000ms")
	}
}

func TestNoDropBelowFourSeconds(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d := g.Evaluate(now, 3000*time.Millisecond)
	if d.ShouldDropOldNonKeyVideo {
		t.Fatalf("did not expect drop policy below 4000ms")
	}
}

func TestDegradedStateAboveEightSeconds(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	d := g.Evaluate(now, 8500*time.Millisecond)
	if d.State != StateDegraded {
		t.Fatalf("state = %v, want Degraded", d.State)
	}
	if d.ShouldReconnect {
		t.Fatalf("should not request reconnect immediately upon entering degraded state")
	}
}

func TestReconnectAfterDegradedSustainedTenSeconds(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	g.Evaluate(now, 8500*time.Millisecond)
	now = now.Add(DegradedSustainedDuration + time.Second)
	d := g.Evaluate(now, 8500*time.Millisecond)

	if d.State != StateNeedsReconnect {
		t.Fatalf("state = %v, want NeedsReconnect", d.State)
	}
	if !d.ShouldReconnect {
		t.Fatalf("expected ShouldReconnect = true after sustained degradation")
	}
}

func TestDegradedRecoversToLiveWhenDelayDrops(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	g.Evaluate(now, 8500*time.Millisecond)
	now = now.Add(1 * time.Second)
	d := g.Evaluate(now, 100*time.Millisecond)

	if d.State != StateLive {
		t.Fatalf("state = %v, want Live after recovery", d.State)
	}
}

func TestApplyThrottleOverridesTargetImmediatelyAndClamps(t *testing.T) {
	g := NewBitrateGovernor(DefaultConfig())
	now := baseTime()

	got := g.ApplyThrottle(now, 1200)
	if got != 1200 {
		t.Fatalf("ApplyThrottle returned %d, want 1200", got)
	}
	if g.TargetBitrateKbps() != 1200 {
		t.Fatalf("target after throttle = %d, want 1200", g.TargetBitrateKbps())
	}

	// 下限を下回る値は下限にクランプされる。
	got = g.ApplyThrottle(now, 100)
	if got != DefaultConfig().MinBitrateKbps {
		t.Fatalf("ApplyThrottle should clamp to floor, got %d", got)
	}

	// 上限を上回る値は上限にクランプされる。
	got = g.ApplyThrottle(now, 999999)
	if got != DefaultConfig().MaxBitrateKbps {
		t.Fatalf("ApplyThrottle should clamp to ceiling, got %d", got)
	}
}
