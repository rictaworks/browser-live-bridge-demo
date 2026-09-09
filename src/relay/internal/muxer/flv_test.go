package muxer

import (
	"bytes"
	"io"
	"testing"

	"github.com/yutopp/go-flv/tag"
)

// codecBytesは実際のH.264/AACの符号化データを模したダミーバイト列です。
// 中継層はこれをバイト単位で一切変更せず（再エンコードせず）に
// コンテナへ詰め替えるだけであることを検証します。
var videoConfigBytes = []byte{0x01, 0x42, 0xC0, 0x1F, 0xFF, 0xE1, 0x00, 0x1B}
var videoNALUBytes = []byte{0x00, 0x00, 0x00, 0x10, 0x65, 0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03}
var audioConfigBytes = []byte{0x11, 0x90}
var rawAACBytes = []byte{0x21, 0x10, 0x04, 0x60, 0x8C, 0x1C}

func TestEncodeVideoConfigPreservesBytesExactly(t *testing.T) {
	out, err := EncodeVideoConfig(videoConfigBytes)
	if err != nil {
		t.Fatalf("EncodeVideoConfig() error = %v", err)
	}

	var got tag.VideoData
	if err := tag.DecodeVideoData(bytes.NewReader(out), &got); err != nil {
		t.Fatalf("DecodeVideoData() error = %v", err)
	}
	defer got.Close()

	if got.CodecID != tag.CodecIDAVC {
		t.Errorf("CodecID = %v, want AVC", got.CodecID)
	}
	if got.AVCPacketType != tag.AVCPacketTypeSequenceHeader {
		t.Errorf("AVCPacketType = %v, want SequenceHeader", got.AVCPacketType)
	}
	if got.FrameType != tag.FrameTypeKeyFrame {
		t.Errorf("FrameType = %v, want KeyFrame", got.FrameType)
	}

	payload, err := io.ReadAll(got.Data)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if !bytes.Equal(payload, videoConfigBytes) {
		t.Errorf("payload was mutated: got %v, want %v (must pass through unchanged - no re-encoding)", payload, videoConfigBytes)
	}
}

func TestEncodeVideoKeyAndInterFrame(t *testing.T) {
	keyOut, err := EncodeVideo(true, videoNALUBytes)
	if err != nil {
		t.Fatalf("EncodeVideo(key) error = %v", err)
	}
	var keyGot tag.VideoData
	if err := tag.DecodeVideoData(bytes.NewReader(keyOut), &keyGot); err != nil {
		t.Fatalf("DecodeVideoData() error = %v", err)
	}
	defer keyGot.Close()
	if keyGot.FrameType != tag.FrameTypeKeyFrame {
		t.Errorf("FrameType = %v, want KeyFrame", keyGot.FrameType)
	}
	if keyGot.AVCPacketType != tag.AVCPacketTypeNALU {
		t.Errorf("AVCPacketType = %v, want NALU", keyGot.AVCPacketType)
	}
	payload, _ := io.ReadAll(keyGot.Data)
	if !bytes.Equal(payload, videoNALUBytes) {
		t.Errorf("payload mutated: got %v, want %v", payload, videoNALUBytes)
	}

	interOut, err := EncodeVideo(false, videoNALUBytes)
	if err != nil {
		t.Fatalf("EncodeVideo(inter) error = %v", err)
	}
	var interGot tag.VideoData
	if err := tag.DecodeVideoData(bytes.NewReader(interOut), &interGot); err != nil {
		t.Fatalf("DecodeVideoData() error = %v", err)
	}
	defer interGot.Close()
	if interGot.FrameType != tag.FrameTypeInterFrame {
		t.Errorf("FrameType = %v, want InterFrame", interGot.FrameType)
	}
}

func TestEncodeAudioConfigPreservesBytesExactly(t *testing.T) {
	out, err := EncodeAudioConfig(audioConfigBytes)
	if err != nil {
		t.Fatalf("EncodeAudioConfig() error = %v", err)
	}

	var got tag.AudioData
	if err := tag.DecodeAudioData(bytes.NewReader(out), &got); err != nil {
		t.Fatalf("DecodeAudioData() error = %v", err)
	}
	defer got.Close()

	if got.SoundFormat != tag.SoundFormatAAC {
		t.Errorf("SoundFormat = %v, want AAC", got.SoundFormat)
	}
	if got.AACPacketType != tag.AACPacketTypeSequenceHeader {
		t.Errorf("AACPacketType = %v, want SequenceHeader", got.AACPacketType)
	}

	payload, err := io.ReadAll(got.Data)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if !bytes.Equal(payload, audioConfigBytes) {
		t.Errorf("payload was mutated: got %v, want %v", payload, audioConfigBytes)
	}
}

func TestEncodeAudioPreservesBytesExactly(t *testing.T) {
	out, err := EncodeAudio(rawAACBytes)
	if err != nil {
		t.Fatalf("EncodeAudio() error = %v", err)
	}

	var got tag.AudioData
	if err := tag.DecodeAudioData(bytes.NewReader(out), &got); err != nil {
		t.Fatalf("DecodeAudioData() error = %v", err)
	}
	defer got.Close()

	if got.AACPacketType != tag.AACPacketTypeRaw {
		t.Errorf("AACPacketType = %v, want Raw", got.AACPacketType)
	}

	payload, err := io.ReadAll(got.Data)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if !bytes.Equal(payload, rawAACBytes) {
		t.Errorf("payload was mutated: got %v, want %v", payload, rawAACBytes)
	}
}
