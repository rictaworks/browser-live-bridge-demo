// Package muxer は、requirements.md 6.7節「中継・多重化・送出仕様」を実装します。
//
// 受信したフレーム（内部的にはprotocol.Frame相当のデータ）をFLVタグの
// ペイロード（AudioData/VideoDataのバイト列）へ変換します。この変換は
// コンテナ（容器）の詰め替えのみであり、符号化データ（NALU・AACフレーム等）
// そのものには一切手を加えません。すなわち再エンコードを行いません
// （requirements.md 6.1節・20節）。
//
// 生成したバイト列は、
//   - RTMP の AudioMessage / VideoMessage の Payload としてそのまま利用でき（RTMPの
//     音声・映像メッセージ本体はFLVのAudioData/VideoDataと同一形式であるため）、
//   - go-flv の tag.FlvTag.Data としてそのまま利用でき、モニター配信用の
//     完全なFLVタグ（ヘッダ + 本体 + PreviousTagSize）を組み立てる際にも使えます。
package muxer

import (
	"bytes"
	"fmt"

	"github.com/yutopp/go-flv/tag"
)

// エンコードプロファイルは requirements.md 6.5節に固定されている
// （H.264 Baseline/Level 3.1, AAC-LC 48kHz/2ch）ため、FLVのオーディオ
// ヘッダ情報（サンプリング周波数フラグ等）もこれに合わせて固定します。
// 実データのサンプリング周波数はAACSpecificConfig（音声設定フレームの本文）
// 側に格納されており、この固定フラグはFLVコンテナ上の形式的な表現に過ぎません。

// EncodeVideoConfig は映像設定フレーム（AVCDecoderConfigurationRecordの生バイト列）を
// FLVのVideoDataペイロードへ変換します。
func EncodeVideoConfig(avcDecoderConfig []byte) ([]byte, error) {
	return encodeVideo(tag.AVCPacketTypeSequenceHeader, true, avcDecoderConfig)
}

// EncodeVideo は映像フレーム（符号化データそのまま、AVCC形式のNALU列）を
// FLVのVideoDataペイロードへ変換します。再エンコードは行いません。
func EncodeVideo(keyFrame bool, avccNALUs []byte) ([]byte, error) {
	return encodeVideo(tag.AVCPacketTypeNALU, keyFrame, avccNALUs)
}

func encodeVideo(packetType tag.AVCPacketType, keyFrame bool, payload []byte) ([]byte, error) {
	frameType := tag.FrameTypeInterFrame
	if keyFrame {
		frameType = tag.FrameTypeKeyFrame
	}

	data := &tag.VideoData{
		FrameType:       frameType,
		CodecID:         tag.CodecIDAVC,
		AVCPacketType:   packetType,
		CompositionTime: 0,
		Data:            bytes.NewReader(payload),
	}

	var buf bytes.Buffer
	if err := tag.EncodeVideoData(&buf, data); err != nil {
		return nil, fmt.Errorf("muxer: encode video data: %w", err)
	}
	return buf.Bytes(), nil
}

// EncodeAudioConfig は音声設定フレーム（AudioSpecificConfigの生バイト列）を
// FLVのAudioDataペイロードへ変換します。
func EncodeAudioConfig(audioSpecificConfig []byte) ([]byte, error) {
	return encodeAudio(tag.AACPacketTypeSequenceHeader, audioSpecificConfig)
}

// EncodeAudio は音声フレーム（符号化データそのまま、ADTSなしの生AACフレーム）を
// FLVのAudioDataペイロードへ変換します。再エンコードは行いません。
func EncodeAudio(rawAAC []byte) ([]byte, error) {
	return encodeAudio(tag.AACPacketTypeRaw, rawAAC)
}

func encodeAudio(packetType tag.AACPacketType, payload []byte) ([]byte, error) {
	data := &tag.AudioData{
		SoundFormat: tag.SoundFormatAAC,
		// AACの場合、FLV仕様上SoundRateは44kHzフラグを立てるのが慣例であり、
		// 実際のサンプリング周波数（6.5節: 48kHz）はAudioSpecificConfig側で
		// 表現される。プレイヤー側もAAC時はこのフラグを参照しない。
		SoundRate:     tag.SoundRate44kHz,
		SoundSize:     tag.SoundSize16Bit,
		SoundType:     tag.SoundTypeStereo,
		AACPacketType: packetType,
		Data:          bytes.NewReader(payload),
	}

	var buf bytes.Buffer
	if err := tag.EncodeAudioData(&buf, data); err != nil {
		return nil, fmt.Errorf("muxer: encode audio data: %w", err)
	}
	return buf.Bytes(), nil
}
