package ratecontrol

import (
	"testing"
	"time"
)

func TestQueueDelayEmptyIsZero(t *testing.T) {
	q := NewQueue()
	if d := q.QueueDelay(time.Now()); d != 0 {
		t.Fatalf("QueueDelay() on empty queue = %v, want 0", d)
	}
}

func TestQueueDelayReflectsOldestItem(t *testing.T) {
	q := NewQueue()
	now := baseTime()

	q.Enqueue(Item{Kind: ItemVideo, EnqueuedAt: now})
	q.Enqueue(Item{Kind: ItemVideo, EnqueuedAt: now.Add(2 * time.Second)})

	later := now.Add(5 * time.Second)
	if d := q.QueueDelay(later); d != 5*time.Second {
		t.Fatalf("QueueDelay() = %v, want 5s (based on oldest item)", d)
	}
}

func TestDropOldestNonKeyVideoSkipsAudioAndKeyframes(t *testing.T) {
	q := NewQueue()
	now := baseTime()

	q.Enqueue(Item{Kind: ItemVideo, KeyFrame: true, EnqueuedAt: now, Payload: []byte("key")})
	q.Enqueue(Item{Kind: ItemAudio, EnqueuedAt: now.Add(time.Millisecond), Payload: []byte("audio")})
	q.Enqueue(Item{Kind: ItemVideo, KeyFrame: false, EnqueuedAt: now.Add(2 * time.Millisecond), Payload: []byte("delta")})

	if !q.DropOldestNonKeyVideo() {
		t.Fatalf("expected a non-key video frame to be dropped")
	}
	if got := q.DroppedVideoFrames(); got != 1 {
		t.Fatalf("DroppedVideoFrames() = %d, want 1", got)
	}
	if got := q.DroppedAudioFrames(); got != 0 {
		t.Fatalf("DroppedAudioFrames() = %d, want 0 (audio must never be dropped)", got)
	}

	// 残りは keyframe と audio のみのはず。
	if q.Len() != 2 {
		t.Fatalf("queue length = %d, want 2", q.Len())
	}
	first, ok := q.Drain()
	if !ok || first.Kind != ItemVideo || !first.KeyFrame {
		t.Fatalf("expected keyframe to remain first, got %+v", first)
	}
	second, ok := q.Drain()
	if !ok || second.Kind != ItemAudio {
		t.Fatalf("expected audio item to remain, got %+v", second)
	}
}

func TestDropOldestNonKeyVideoReturnsFalseWhenNoneEligible(t *testing.T) {
	q := NewQueue()
	now := baseTime()

	q.Enqueue(Item{Kind: ItemVideo, KeyFrame: true, EnqueuedAt: now})
	q.Enqueue(Item{Kind: ItemAudio, EnqueuedAt: now})

	if q.DropOldestNonKeyVideo() {
		t.Fatalf("expected no drop when only keyframes/audio remain")
	}
	if q.Len() != 2 {
		t.Fatalf("queue length changed unexpectedly: %d", q.Len())
	}
}

func TestDropOldestNonKeyVideoDropsInOrder(t *testing.T) {
	q := NewQueue()
	now := baseTime()

	q.Enqueue(Item{Kind: ItemVideo, KeyFrame: false, EnqueuedAt: now, Payload: []byte("oldest")})
	q.Enqueue(Item{Kind: ItemVideo, KeyFrame: false, EnqueuedAt: now.Add(time.Second), Payload: []byte("newer")})

	q.DropOldestNonKeyVideo()

	remaining, ok := q.Drain()
	if !ok {
		t.Fatalf("expected one item to remain")
	}
	if string(remaining.Payload) != "newer" {
		t.Fatalf("dropped wrong item; remaining = %q, want %q", remaining.Payload, "newer")
	}
}

func TestDrainFIFOOrder(t *testing.T) {
	q := NewQueue()
	now := baseTime()
	q.Enqueue(Item{Payload: []byte("a"), EnqueuedAt: now})
	q.Enqueue(Item{Payload: []byte("b"), EnqueuedAt: now})

	first, _ := q.Drain()
	second, _ := q.Drain()
	if string(first.Payload) != "a" || string(second.Payload) != "b" {
		t.Fatalf("drain order = %q, %q; want a, b", first.Payload, second.Payload)
	}
	if _, ok := q.Drain(); ok {
		t.Fatalf("expected empty queue after draining all items")
	}
}
