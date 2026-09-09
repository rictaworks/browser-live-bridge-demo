package protocol

import (
	"bytes"
	"errors"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []Frame{
		{Kind: KindVideoConfig, KeyFrame: false, TimestampMicros: 0, Body: []byte{0x01, 0x02, 0x03}},
		{Kind: KindVideo, KeyFrame: true, TimestampMicros: 123456789, Body: bytes.Repeat([]byte{0xAB}, 500)},
		{Kind: KindAudioConfig, KeyFrame: false, TimestampMicros: 1, Body: []byte{0x11, 0x90}},
		{Kind: KindAudio, KeyFrame: false, TimestampMicros: 999999999999, Body: []byte("raw-aac-bytes")},
		{Kind: KindControl, KeyFrame: false, TimestampMicros: 42, Body: []byte{0x01}},
		{Kind: KindVideo, KeyFrame: false, TimestampMicros: 5, Body: nil},
	}

	for _, want := range cases {
		encoded, err := Encode(want)
		if err != nil {
			t.Fatalf("Encode() error = %v", err)
		}

		if len(encoded) < HeaderLength {
			t.Fatalf("encoded frame shorter than header: %d bytes", len(encoded))
		}
		if encoded[0] != Identifier[0] || encoded[1] != Identifier[1] {
			t.Fatalf("unexpected identifier bytes: %v", encoded[0:2])
		}
		if encoded[2] != Version {
			t.Fatalf("unexpected version byte: %d", encoded[2])
		}

		got, err := Decode(encoded)
		if err != nil {
			t.Fatalf("Decode() error = %v", err)
		}

		if got.Kind != want.Kind {
			t.Errorf("Kind = %v, want %v", got.Kind, want.Kind)
		}
		if got.KeyFrame != want.KeyFrame {
			t.Errorf("KeyFrame = %v, want %v", got.KeyFrame, want.KeyFrame)
		}
		if got.TimestampMicros != want.TimestampMicros {
			t.Errorf("TimestampMicros = %d, want %d", got.TimestampMicros, want.TimestampMicros)
		}
		if !bytes.Equal(got.Body, want.Body) {
			t.Errorf("Body = %v, want %v", got.Body, want.Body)
		}
	}
}

func TestDecodeRejectsBadIdentifier(t *testing.T) {
	f := Frame{Kind: KindVideo, TimestampMicros: 1, Body: []byte("x")}
	encoded, err := Encode(f)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	encoded[0] = 0xFF

	if _, err := Decode(encoded); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestDecodeRejectsUnsupportedVersion(t *testing.T) {
	f := Frame{Kind: KindVideo, TimestampMicros: 1, Body: []byte("x")}
	encoded, err := Encode(f)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	encoded[2] = 99

	if _, err := Decode(encoded); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestDecodeRejectsUnknownKind(t *testing.T) {
	f := Frame{Kind: KindVideo, TimestampMicros: 1, Body: []byte("x")}
	encoded, err := Encode(f)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	encoded[3] = 0x7F

	if _, err := Decode(encoded); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestDecodeRejectsBodyLengthMismatch(t *testing.T) {
	f := Frame{Kind: KindVideo, TimestampMicros: 1, Body: []byte("hello")}
	encoded, err := Encode(f)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	// 本文長フィールドを実際より大きい値に書き換える。
	encoded[13], encoded[14], encoded[15], encoded[16] = 0, 0, 0, 200

	if _, err := Decode(encoded); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestDecodeRejectsTooShortMessage(t *testing.T) {
	if _, err := Decode([]byte{0x42, 0x4C, 0x01}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestDecodeRejectsOversizedDeclaredBody(t *testing.T) {
	header := make([]byte, HeaderLength)
	header[0], header[1] = Identifier[0], Identifier[1]
	header[2] = Version
	header[3] = byte(KindVideo)
	header[13], header[14], header[15], header[16] = 0xFF, 0xFF, 0xFF, 0xFF

	if _, err := Decode(header); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Decode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestEncodeRejectsOversizedBody(t *testing.T) {
	f := Frame{Kind: KindVideo, Body: make([]byte, MaxBodyLength+1)}
	if _, err := Encode(f); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("Encode() error = %v, want ErrInvalidFrame", err)
	}
}

func TestReadFrame(t *testing.T) {
	want := Frame{Kind: KindAudio, KeyFrame: false, TimestampMicros: 77, Body: []byte("abc")}
	encoded, err := Encode(want)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	got, err := ReadFrame(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	if got.Kind != want.Kind || got.TimestampMicros != want.TimestampMicros || !bytes.Equal(got.Body, want.Body) {
		t.Fatalf("ReadFrame() = %+v, want %+v", got, want)
	}
}
