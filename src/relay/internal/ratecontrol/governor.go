// Package ratecontrol は、requirements.md 7節「適応制御要件」を実装します。
//
// 中継層は、受信フレームをFLV多重化してローカルingestへpublishするまでの間、
// 自らの送出待ちキュー（Queue）を持ちます。そのキューの滞留時間を毎秒評価し、
// 目標ビットレートと破棄方針を決定するのが BitrateGovernor の役割です。
//
// 判定結果として算出された目標ビットレートは、抑制指示（6.6節）として
// 送信側（配信スタジオ）へ通知されます。中継側からの抑制指示は送信側の
// 判定より優先されるため（7節要件）、中継層自身がこの評価を行う必要があります。
package ratecontrol

import "time"

// 閾値・変化率は requirements.md 7節の表・要件に基づく定数です。
const (
	// QueueDelayHighThreshold を2回連続で超えるとビットレートを引き下げます。
	QueueDelayHighThreshold = 1500 * time.Millisecond
	// QueueDelayLowThreshold 未満かつ直近10秒の破棄が皆無であれば引き上げます。
	QueueDelayLowThreshold = 300 * time.Millisecond
	// QueueDelayDropThreshold を超えると非キーフレーム映像を古い順に破棄します。
	QueueDelayDropThreshold = 4000 * time.Millisecond
	// QueueDelayDegradedThreshold を超えると劣化状態に遷移します。
	QueueDelayDegradedThreshold = 8000 * time.Millisecond
	// DegradedSustainedDuration の間、劣化状態が継続すると再接続へ移行します。
	DegradedSustainedDuration = 10 * time.Second
	// NoDropLookback は「直近10秒の破棄が皆無」を判定する窓の長さです。
	NoDropLookback = 10 * time.Second

	// DecreaseFactor は引き下げ幅（30%）です。
	DecreaseFactor = 0.30
	// IncreaseFactor は引き上げ幅（10%）です。引き下げより緩やかにするため
	// DecreaseFactor より小さい値とします（7節要件）。
	IncreaseFactor = 0.10

	// MinBitrateChangeInterval はビットレート変更を1秒に1回までに制限します。
	MinBitrateChangeInterval = 1 * time.Second
)

// State は配信状態です（8節・18.1節の一部に対応）。
type State int

const (
	StateLive State = iota
	StateDegraded
	StateNeedsReconnect
)

func (s State) String() string {
	switch s {
	case StateLive:
		return "live"
	case StateDegraded:
		return "degraded"
	case StateNeedsReconnect:
		return "needs_reconnect"
	default:
		return "unknown"
	}
}

// Config は BitrateGovernor の初期化パラメータです。
type Config struct {
	InitialBitrateKbps uint32 // 映像ビットレート初期値（6.5節）
	MinBitrateKbps     uint32 // 映像ビットレート下限（6.5節）
	MaxBitrateKbps     uint32 // 映像ビットレート上限（6.5節）
}

// DefaultConfig は requirements.md 6.5節の表の値です。
func DefaultConfig() Config {
	return Config{InitialBitrateKbps: 2500, MinBitrateKbps: 800, MaxBitrateKbps: 4000}
}

// Decision は1回の評価結果です。
type Decision struct {
	TargetBitrateKbps        uint32 // 評価後の目標ビットレート
	BitrateChanged           bool   // 今回の評価でビットレートを変更したか
	ShouldDropOldNonKeyVideo bool   // 非キーフレーム映像を古い順に破棄すべきか
	State                    State  // 評価後の配信状態
	ShouldReconnect          bool   // 再接続へ移行すべきか（劣化がDegradedSustainedDuration継続）
}

// dropEvent は破棄が発生した時刻の記録です（直近10秒の破棄有無判定に使用）。
type dropEvent struct {
	at time.Time
}

// BitrateGovernor は毎秒の滞留時間評価から目標ビットレートと破棄方針を決定します。
// 音声フレーム・キーフレームは呼び出し側（Queue実装）で破棄対象から除外される前提であり、
// 本構造体はその方針の決定のみを担います。
type BitrateGovernor struct {
	cfg Config

	target uint32

	// 滞留時間が閾値超過だった連続回数（引き下げ判定用）。
	consecutiveHighDelay int

	lastBitrateChangeAt time.Time
	hasChangedOnce      bool

	// 劣化状態に入った時刻。劣化していない場合はゼロ値。
	degradedSince time.Time
	state         State

	dropHistory []dropEvent
}

// NewBitrateGovernor は初期目標ビットレートを cfg.InitialBitrateKbps として governor を生成します。
func NewBitrateGovernor(cfg Config) *BitrateGovernor {
	return &BitrateGovernor{
		cfg:    cfg,
		target: cfg.InitialBitrateKbps,
		state:  StateLive,
	}
}

// TargetBitrateKbps は現在の目標ビットレートです。
func (g *BitrateGovernor) TargetBitrateKbps() uint32 {
	return g.target
}

// State は現在の配信状態です。
func (g *BitrateGovernor) State() State {
	return g.state
}

// RecordDrop は映像フレームの破棄が発生したことを記録します。
// 「直近10秒の破棄が皆無」の判定に用いるため、音声フレーム・キーフレームの
// 破棄（そもそも発生しない）は記録しません。
func (g *BitrateGovernor) RecordDrop(at time.Time) {
	g.dropHistory = append(g.dropHistory, dropEvent{at: at})
}

func (g *BitrateGovernor) hasRecentDrop(now time.Time) bool {
	cutoff := now.Add(-NoDropLookback)
	// 古い記録を掃除しつつ判定する。
	kept := g.dropHistory[:0]
	found := false
	for _, d := range g.dropHistory {
		if d.at.After(cutoff) {
			kept = append(kept, d)
			found = true
		}
	}
	g.dropHistory = kept
	return found
}

func (g *BitrateGovernor) canChangeBitrate(now time.Time) bool {
	if !g.hasChangedOnce {
		return true
	}
	return now.Sub(g.lastBitrateChangeAt) >= MinBitrateChangeInterval
}

func clampBitrate(v, min, max uint32) uint32 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// Evaluate は毎秒呼び出され、現在の滞留時間（queueDelay）から次の1秒間の
// 目標ビットレート・破棄方針・配信状態を決定します（requirements.md 7節）。
func (g *BitrateGovernor) Evaluate(now time.Time, queueDelay time.Duration) Decision {
	decision := Decision{TargetBitrateKbps: g.target}

	// --- 引き下げ / 引き上げ判定（1500ms超過2回連続 / 300ms未満かつ無破棄） ---
	if queueDelay > QueueDelayHighThreshold {
		g.consecutiveHighDelay++
	} else {
		g.consecutiveHighDelay = 0
	}

	if g.consecutiveHighDelay >= 2 && g.canChangeBitrate(now) {
		newTarget := clampBitrate(
			uint32(float64(g.target)*(1-DecreaseFactor)),
			g.cfg.MinBitrateKbps, g.cfg.MaxBitrateKbps,
		)
		if newTarget != g.target {
			g.target = newTarget
			g.lastBitrateChangeAt = now
			g.hasChangedOnce = true
			decision.BitrateChanged = true
		}
		// 引き下げの契機は消費し、連続カウントをリセットする。
		g.consecutiveHighDelay = 0
	} else if queueDelay < QueueDelayLowThreshold && !g.hasRecentDrop(now) && g.canChangeBitrate(now) {
		newTarget := clampBitrate(
			uint32(float64(g.target)*(1+IncreaseFactor)),
			g.cfg.MinBitrateKbps, g.cfg.MaxBitrateKbps,
		)
		if newTarget != g.target {
			g.target = newTarget
			g.lastBitrateChangeAt = now
			g.hasChangedOnce = true
			decision.BitrateChanged = true
		}
	}
	decision.TargetBitrateKbps = g.target

	// --- 破棄方針（4000ms超） ---
	if queueDelay > QueueDelayDropThreshold {
		decision.ShouldDropOldNonKeyVideo = true
	}

	// --- 劣化状態・再接続判定（8000ms超が10秒継続） ---
	if queueDelay > QueueDelayDegradedThreshold {
		if g.state != StateDegraded && g.state != StateNeedsReconnect {
			g.state = StateDegraded
			g.degradedSince = now
		}
		if g.state == StateDegraded && now.Sub(g.degradedSince) >= DegradedSustainedDuration {
			g.state = StateNeedsReconnect
			decision.ShouldReconnect = true
		}
	} else {
		// 滞留が回復した場合は劣化状態を解除する（18.1節: Degraded --> Live）。
		if g.state == StateDegraded {
			g.state = StateLive
			g.degradedSince = time.Time{}
		}
	}
	decision.State = g.state

	return decision
}

// ApplyThrottle は、中継側が独自に検知した逼迫に基づき目標ビットレートを
// 直接指定します。中継側からの抑制指示は送信側の判定より優先されるため、
// 段階的な引き下げ計算を経ずに即時反映しますが、上限・下限は遵守します。
func (g *BitrateGovernor) ApplyThrottle(now time.Time, kbps uint32) uint32 {
	g.target = clampBitrate(kbps, g.cfg.MinBitrateKbps, g.cfg.MaxBitrateKbps)
	g.lastBitrateChangeAt = now
	g.hasChangedOnce = true
	return g.target
}
