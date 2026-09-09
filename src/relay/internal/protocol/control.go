package protocol

import (
	"encoding/binary"
	"fmt"
)

// ControlType は制御フレーム（Kind = KindControl）本文の先頭1バイトに置かれる
// 制御メッセージの種類です（requirements.md 6.6節「制御メッセージ」表）。
type ControlType uint8

const (
	// 送信側 → 中継
	ControlStartNotice  ControlType = 0x01 // 開始通知: セッションキー・配信トークン・エンコードプロファイル
	ControlStatusReport ControlType = 0x02 // 状態報告: 滞留時間・破棄フレーム数・現在の目標ビットレート
	ControlEndNotice    ControlType = 0x03 // 終了通知: 終了理由

	// 中継 → 送信側
	ControlAck                 ControlType = 0x81 // 受領応答: 受領済み時刻
	ControlKeyframeRequest     ControlType = 0x82 // キーフレーム要求
	ControlThrottleInstruction ControlType = 0x83 // 抑制指示: 目標ビットレート
	ControlFatal               ControlType = 0x84 // 致命通知: 継続不能な理由
)

// StartNotice は開始通知の内容です。
type StartNotice struct {
	SessionKey     string
	BroadcastToken string
	EncodeProfile  string
}

// StatusReport は状態報告の内容です。
type StatusReport struct {
	QueueMs            uint32
	DroppedVideoFrames uint32
	DroppedAudioFrames uint32
	TargetBitrateKbps  uint32
}

// EndNotice は終了通知の内容です。
type EndNotice struct {
	Reason string
}

// Ack は受領応答の内容です。
type Ack struct {
	ReceivedAtMicros uint64
}

// ThrottleInstruction は抑制指示の内容です。
type ThrottleInstruction struct {
	TargetBitrateKbps uint32
}

// FatalNotice は致命通知の内容です。
type FatalNotice struct {
	Reason string
}

func writeString(buf []byte, s string) []byte {
	l := make([]byte, 2)
	binary.BigEndian.PutUint16(l, uint16(len(s)))
	buf = append(buf, l...)
	buf = append(buf, s...)
	return buf
}

func readString(body []byte, offset int) (string, int, error) {
	if offset+2 > len(body) {
		return "", 0, fmt.Errorf("%w: control body truncated (string length)", ErrInvalidFrame)
	}
	l := int(binary.BigEndian.Uint16(body[offset : offset+2]))
	offset += 2
	if offset+l > len(body) {
		return "", 0, fmt.Errorf("%w: control body truncated (string content)", ErrInvalidFrame)
	}
	return string(body[offset : offset+l]), offset + l, nil
}

// EncodeStartNotice は開始通知の制御フレーム本文を生成します。
func EncodeStartNotice(n StartNotice) []byte {
	buf := []byte{byte(ControlStartNotice)}
	buf = writeString(buf, n.SessionKey)
	buf = writeString(buf, n.BroadcastToken)
	buf = writeString(buf, n.EncodeProfile)
	return buf
}

// DecodeStartNotice は制御フレーム本文から開始通知を復元します。
func DecodeStartNotice(body []byte) (StartNotice, error) {
	if len(body) < 1 || ControlType(body[0]) != ControlStartNotice {
		return StartNotice{}, fmt.Errorf("%w: not a start notice", ErrInvalidFrame)
	}
	sessionKey, off, err := readString(body, 1)
	if err != nil {
		return StartNotice{}, err
	}
	token, off, err := readString(body, off)
	if err != nil {
		return StartNotice{}, err
	}
	profile, _, err := readString(body, off)
	if err != nil {
		return StartNotice{}, err
	}
	return StartNotice{SessionKey: sessionKey, BroadcastToken: token, EncodeProfile: profile}, nil
}

// EncodeStatusReport は状態報告の制御フレーム本文を生成します。
func EncodeStatusReport(r StatusReport) []byte {
	buf := make([]byte, 1+4*4)
	buf[0] = byte(ControlStatusReport)
	binary.BigEndian.PutUint32(buf[1:5], r.QueueMs)
	binary.BigEndian.PutUint32(buf[5:9], r.DroppedVideoFrames)
	binary.BigEndian.PutUint32(buf[9:13], r.DroppedAudioFrames)
	binary.BigEndian.PutUint32(buf[13:17], r.TargetBitrateKbps)
	return buf
}

// DecodeStatusReport は制御フレーム本文から状態報告を復元します。
func DecodeStatusReport(body []byte) (StatusReport, error) {
	if len(body) < 17 || ControlType(body[0]) != ControlStatusReport {
		return StatusReport{}, fmt.Errorf("%w: not a status report", ErrInvalidFrame)
	}
	return StatusReport{
		QueueMs:            binary.BigEndian.Uint32(body[1:5]),
		DroppedVideoFrames: binary.BigEndian.Uint32(body[5:9]),
		DroppedAudioFrames: binary.BigEndian.Uint32(body[9:13]),
		TargetBitrateKbps:  binary.BigEndian.Uint32(body[13:17]),
	}, nil
}

// EncodeEndNotice は終了通知の制御フレーム本文を生成します。
func EncodeEndNotice(n EndNotice) []byte {
	buf := []byte{byte(ControlEndNotice)}
	buf = writeString(buf, n.Reason)
	return buf
}

// DecodeEndNotice は制御フレーム本文から終了通知を復元します。
func DecodeEndNotice(body []byte) (EndNotice, error) {
	if len(body) < 1 || ControlType(body[0]) != ControlEndNotice {
		return EndNotice{}, fmt.Errorf("%w: not an end notice", ErrInvalidFrame)
	}
	reason, _, err := readString(body, 1)
	if err != nil {
		return EndNotice{}, err
	}
	return EndNotice{Reason: reason}, nil
}

// EncodeAck は受領応答の制御フレーム本文を生成します。
func EncodeAck(a Ack) []byte {
	buf := make([]byte, 9)
	buf[0] = byte(ControlAck)
	binary.BigEndian.PutUint64(buf[1:9], a.ReceivedAtMicros)
	return buf
}

// EncodeKeyframeRequest はキーフレーム要求の制御フレーム本文を生成します。
func EncodeKeyframeRequest() []byte {
	return []byte{byte(ControlKeyframeRequest)}
}

// EncodeThrottleInstruction は抑制指示の制御フレーム本文を生成します。
func EncodeThrottleInstruction(t ThrottleInstruction) []byte {
	buf := make([]byte, 5)
	buf[0] = byte(ControlThrottleInstruction)
	binary.BigEndian.PutUint32(buf[1:5], t.TargetBitrateKbps)
	return buf
}

// DecodeThrottleInstruction は制御フレーム本文から抑制指示を復元します。
func DecodeThrottleInstruction(body []byte) (ThrottleInstruction, error) {
	if len(body) < 5 || ControlType(body[0]) != ControlThrottleInstruction {
		return ThrottleInstruction{}, fmt.Errorf("%w: not a throttle instruction", ErrInvalidFrame)
	}
	return ThrottleInstruction{TargetBitrateKbps: binary.BigEndian.Uint32(body[1:5])}, nil
}

// EncodeFatal は致命通知の制御フレーム本文を生成します。
func EncodeFatal(f FatalNotice) []byte {
	buf := []byte{byte(ControlFatal)}
	buf = writeString(buf, f.Reason)
	return buf
}

// DecodeFatal は制御フレーム本文から致命通知を復元します。
func DecodeFatal(body []byte) (FatalNotice, error) {
	if len(body) < 1 || ControlType(body[0]) != ControlFatal {
		return FatalNotice{}, fmt.Errorf("%w: not a fatal notice", ErrInvalidFrame)
	}
	reason, _, err := readString(body, 1)
	if err != nil {
		return FatalNotice{}, err
	}
	return FatalNotice{Reason: reason}, nil
}

// PeekControlType は制御フレーム本文の先頭バイトから種類のみを取り出します。
func PeekControlType(body []byte) (ControlType, error) {
	if len(body) < 1 {
		return 0, fmt.Errorf("%w: empty control body", ErrInvalidFrame)
	}
	return ControlType(body[0]), nil
}
