// Package protocol は、配信スタジオ（ブラウザ）と中継サーバーの間で交わされる
// WebSocketバイナリフレームの構造を定義します（requirements.md 6.6節）。
//
// フレーム構造（固定ヘッダ17バイト + 可変本文）:
//
//	識別子   2バイト  プロトコル識別（"BL" = 0x42 0x4C）
//	版       1バイト  プロトコル版（現行 = 1）
//	種別     1バイト  Kind（映像設定・映像・音声設定・音声・制御）
//	属性     1バイト  Attributes（bit0 = キーフレームか否か）
//	時刻     8バイト  メディアクロック（マイクロ秒, ビッグエンディアン）
//	本文長   4バイト  本文のバイト数（ビッグエンディアン）
//	本文     可変     符号化データまたは制御内容
//
// このフレーム構造・制御メッセージのバイナリ表現は、backend/frontend実装との
// 内部契約が requirements.md に具体定義されていなかったため、本タスクの
// オーケストレーターの指示に基づき中継層側で定義したものです。
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Identifier はフレーム先頭2バイトの固定識別子です。
var Identifier = [2]byte{0x42, 0x4C} // "BL"

// Version は現在サポートするプロトコル版です。
const Version uint8 = 1

// HeaderLength は固定ヘッダ部の長さです。
const HeaderLength = 2 + 1 + 1 + 1 + 8 + 4

// MaxBodyLength は本文の上限バイト数です。
// 無制限な確保を避けるための安全弁であり、実運用の1フレーム
// （720p 30fpsの符号化チャンク1枚）を大きく上回る値とします。
const MaxBodyLength = 4 * 1024 * 1024 // 4MiB

// Kind はフレームの種別（6.6節「種別」欄）です。
type Kind uint8

const (
	KindUnknown     Kind = 0
	KindVideoConfig Kind = 1 // 映像設定（復号器設定, 例: AVCDecoderConfigurationRecord）
	KindVideo       Kind = 2 // 映像（符号化データそのまま）
	KindAudioConfig Kind = 3 // 音声設定（復号器設定, 例: AudioSpecificConfig）
	KindAudio       Kind = 4 // 音声（符号化データそのまま）
	KindControl     Kind = 5 // 制御メッセージ
)

// IsValid はKindが既知の値かどうかを返します。
func (k Kind) IsValid() bool {
	switch k {
	case KindVideoConfig, KindVideo, KindAudioConfig, KindAudio, KindControl:
		return true
	default:
		return false
	}
}

func (k Kind) String() string {
	switch k {
	case KindVideoConfig:
		return "video_config"
	case KindVideo:
		return "video"
	case KindAudioConfig:
		return "audio_config"
	case KindAudio:
		return "audio"
	case KindControl:
		return "control"
	default:
		return "unknown"
	}
}

// 属性バイトのビット定義。
const (
	AttrKeyFrame uint8 = 1 << 0
)

// Frame は1つのWebSocketバイナリメッセージに対応するフレームです。
type Frame struct {
	Kind            Kind
	KeyFrame        bool
	TimestampMicros uint64
	Body            []byte
}

// ErrInvalidFrame はフレームの構造検証（識別子・版・種別・長さ）に失敗したことを表します。
// 該当フレームは破棄対象です（requirements.md 21節）。
var ErrInvalidFrame = errors.New("protocol: invalid frame")

// Encode はフレームをWebSocketバイナリメッセージへ変換します。
func Encode(f Frame) ([]byte, error) {
	if !f.Kind.IsValid() {
		return nil, fmt.Errorf("%w: unknown kind %d", ErrInvalidFrame, f.Kind)
	}
	if len(f.Body) > MaxBodyLength {
		return nil, fmt.Errorf("%w: body too large (%d bytes)", ErrInvalidFrame, len(f.Body))
	}

	buf := make([]byte, HeaderLength+len(f.Body))
	buf[0], buf[1] = Identifier[0], Identifier[1]
	buf[2] = Version
	buf[3] = byte(f.Kind)
	var attr uint8
	if f.KeyFrame {
		attr |= AttrKeyFrame
	}
	buf[4] = attr
	binary.BigEndian.PutUint64(buf[5:13], f.TimestampMicros)
	binary.BigEndian.PutUint32(buf[13:17], uint32(len(f.Body)))
	copy(buf[17:], f.Body)

	return buf, nil
}

// Decode はWebSocketバイナリメッセージをフレームへ変換します。
// 識別子・版・種別・本文長のいずれかが不正な場合は ErrInvalidFrame を返します。
// 呼び出し側は、エラー時に当該フレームを破棄してください（requirements.md 21節）。
func Decode(msg []byte) (Frame, error) {
	if len(msg) < HeaderLength {
		return Frame{}, fmt.Errorf("%w: message too short (%d bytes)", ErrInvalidFrame, len(msg))
	}
	if msg[0] != Identifier[0] || msg[1] != Identifier[1] {
		return Frame{}, fmt.Errorf("%w: bad identifier", ErrInvalidFrame)
	}
	if msg[2] != Version {
		return Frame{}, fmt.Errorf("%w: unsupported version %d", ErrInvalidFrame, msg[2])
	}

	kind := Kind(msg[3])
	if !kind.IsValid() {
		return Frame{}, fmt.Errorf("%w: unknown kind %d", ErrInvalidFrame, msg[3])
	}

	attr := msg[4]
	timestamp := binary.BigEndian.Uint64(msg[5:13])
	bodyLen := binary.BigEndian.Uint32(msg[13:17])

	if bodyLen > MaxBodyLength {
		return Frame{}, fmt.Errorf("%w: declared body too large (%d bytes)", ErrInvalidFrame, bodyLen)
	}
	if uint32(len(msg)-HeaderLength) != bodyLen {
		return Frame{}, fmt.Errorf("%w: body length mismatch (declared %d, actual %d)", ErrInvalidFrame, bodyLen, len(msg)-HeaderLength)
	}

	body := make([]byte, bodyLen)
	copy(body, msg[HeaderLength:])

	return Frame{
		Kind:            kind,
		KeyFrame:        attr&AttrKeyFrame != 0,
		TimestampMicros: timestamp,
		Body:            body,
	}, nil
}

// ReadFrame はio.Readerから固定長ヘッダを読み取り、本文まで含めた完全なフレームを返します。
// WebSocket以外の経路（テスト等）でフレームを組み立てる際に利用します。
func ReadFrame(r io.Reader) (Frame, error) {
	header := make([]byte, HeaderLength)
	if _, err := io.ReadFull(r, header); err != nil {
		return Frame{}, fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	bodyLen := binary.BigEndian.Uint32(header[13:17])
	if bodyLen > MaxBodyLength {
		return Frame{}, fmt.Errorf("%w: declared body too large (%d bytes)", ErrInvalidFrame, bodyLen)
	}
	full := make([]byte, HeaderLength+int(bodyLen))
	copy(full, header)
	if _, err := io.ReadFull(r, full[HeaderLength:]); err != nil {
		return Frame{}, fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	return Decode(full)
}
