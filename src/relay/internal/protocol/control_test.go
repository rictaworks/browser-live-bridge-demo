package protocol

import "testing"

func TestStartNoticeRoundTrip(t *testing.T) {
	want := StartNotice{SessionKey: "sess-123", BroadcastToken: "tok-abcXYZ", EncodeProfile: "h264-baseline-3.1"}
	body := EncodeStartNotice(want)

	got, err := DecodeStartNotice(body)
	if err != nil {
		t.Fatalf("DecodeStartNotice() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestStartNoticeEmptyProfile(t *testing.T) {
	want := StartNotice{SessionKey: "s", BroadcastToken: "t", EncodeProfile: ""}
	body := EncodeStartNotice(want)

	got, err := DecodeStartNotice(body)
	if err != nil {
		t.Fatalf("DecodeStartNotice() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestDecodeStartNoticeWrongType(t *testing.T) {
	if _, err := DecodeStartNotice([]byte{byte(ControlEndNotice)}); err == nil {
		t.Fatal("expected error for mismatched control type")
	}
}

func TestDecodeStartNoticeTruncated(t *testing.T) {
	if _, err := DecodeStartNotice([]byte{byte(ControlStartNotice), 0x00, 0x05, 'a', 'b'}); err == nil {
		t.Fatal("expected error for truncated body")
	}
}

func TestStatusReportRoundTrip(t *testing.T) {
	want := StatusReport{QueueMs: 1234, DroppedVideoFrames: 5, DroppedAudioFrames: 0, TargetBitrateKbps: 2500}
	body := EncodeStatusReport(want)

	got, err := DecodeStatusReport(body)
	if err != nil {
		t.Fatalf("DecodeStatusReport() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestEndNoticeRoundTrip(t *testing.T) {
	want := EndNotice{Reason: "user_stopped"}
	body := EncodeEndNotice(want)

	got, err := DecodeEndNotice(body)
	if err != nil {
		t.Fatalf("DecodeEndNotice() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestThrottleInstructionRoundTrip(t *testing.T) {
	want := ThrottleInstruction{TargetBitrateKbps: 1750}
	body := EncodeThrottleInstruction(want)

	got, err := DecodeThrottleInstruction(body)
	if err != nil {
		t.Fatalf("DecodeThrottleInstruction() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestFatalNoticeRoundTrip(t *testing.T) {
	want := FatalNotice{Reason: "verification_failed"}
	body := EncodeFatal(want)

	got, err := DecodeFatal(body)
	if err != nil {
		t.Fatalf("DecodeFatal() error = %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestPeekControlType(t *testing.T) {
	ty, err := PeekControlType(EncodeKeyframeRequest())
	if err != nil {
		t.Fatalf("PeekControlType() error = %v", err)
	}
	if ty != ControlKeyframeRequest {
		t.Errorf("got %v, want %v", ty, ControlKeyframeRequest)
	}

	if _, err := PeekControlType(nil); err == nil {
		t.Fatal("expected error for empty body")
	}
}

func TestAckEncodesReceivedTimestamp(t *testing.T) {
	body := EncodeAck(Ack{ReceivedAtMicros: 42})
	if ControlType(body[0]) != ControlAck {
		t.Fatalf("unexpected control type byte: %d", body[0])
	}
	if len(body) != 9 {
		t.Fatalf("unexpected ack body length: %d", len(body))
	}
}
