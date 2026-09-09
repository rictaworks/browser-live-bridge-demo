package ratecontrol

import (
	"container/list"
	"sync"
	"time"
)

// ItemKind は Queue に積まれる項目の種類です。
type ItemKind int

const (
	ItemVideo ItemKind = iota
	ItemAudio
)

// Item は送出待ちキューに積まれる1件（1フレーム分の多重化前データ）です。
type Item struct {
	Kind       ItemKind
	KeyFrame   bool
	Timestamp  uint64 // メディアクロック（マイクロ秒）。滞留時間の計算には使わない。
	EnqueuedAt time.Time
	Payload    []byte
}

// Queue は中継層がローカルingestへ送出するまでの送出待ちキューです。
// 滞留時間は「最古の未送出フレームがキューに積まれてからの経過時間」
// （requirements.md 3節「滞留時間」の定義）として実時計 EnqueuedAt から算出します。
// これは中継内部の処理待ち時間の計測であり、メディアクロック（6.5節）とは別物です。
//
// 音声フレームとキーフレームは破棄対象としません（7節要件）。
type Queue struct {
	mu sync.Mutex
	l  *list.List

	droppedVideoFrames uint64
	droppedAudioFrames uint64 // 常に0のまま推移する想定（監視用に保持）。

	// wake は、キューへ新規投入があったことを送出ワーカーへ知らせる通知チャネルです。
	// 容量1のノンブロッキング送信とし、送出ワーカー側は select で受信します。
	wake chan struct{}
}

// NewQueue は空のQueueを生成します。
func NewQueue() *Queue {
	return &Queue{l: list.New(), wake: make(chan struct{}, 1)}
}

// Enqueue は1件をキューへ積みます。
func (q *Queue) Enqueue(item Item) {
	q.mu.Lock()
	q.l.PushBack(item)
	q.mu.Unlock()

	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// Wake は新規投入の通知チャネルです。送出ワーカーがブロッキング待機に使います。
func (q *Queue) Wake() <-chan struct{} {
	return q.wake
}

// Len は現在のキュー長です。
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.l.Len()
}

// QueueDelay は最古の未送出フレームの滞留時間です。キューが空の場合は0です。
func (q *Queue) QueueDelay(now time.Time) time.Duration {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.l.Len() == 0 {
		return 0
	}
	front := q.l.Front().Value.(Item)
	d := now.Sub(front.EnqueuedAt)
	if d < 0 {
		return 0
	}
	return d
}

// DropOldestNonKeyVideo はキュー内の非キーフレーム映像を古い順に1件破棄します。
// 破棄できた場合はtrueを返します。音声フレーム・キーフレームはスキップし、
// 破棄対象としません（7節要件）。
func (q *Queue) DropOldestNonKeyVideo() bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	for e := q.l.Front(); e != nil; e = e.Next() {
		item := e.Value.(Item)
		if item.Kind == ItemVideo && !item.KeyFrame {
			q.l.Remove(e)
			q.droppedVideoFrames++
			return true
		}
	}
	return false
}

// DroppedVideoFrames はこれまでに破棄された映像フレーム数です。
func (q *Queue) DroppedVideoFrames() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.droppedVideoFrames
}

// DroppedAudioFrames はこれまでに破棄された音声フレーム数です（常に0）。
func (q *Queue) DroppedAudioFrames() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.droppedAudioFrames
}

// Drain はキューの先頭から1件取り出します（FIFO）。空の場合は ok=false です。
func (q *Queue) Drain() (Item, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	front := q.l.Front()
	if front == nil {
		return Item{}, false
	}
	q.l.Remove(front)
	return front.Value.(Item), true
}
