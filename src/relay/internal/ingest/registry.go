package ingest

import (
	"sync"
	"time"
)

// registry はストリームキー（配信トークン）ごとのSinkを管理します。
type registry struct {
	mu    sync.Mutex
	sinks map[string]*Sink
}

func newRegistry() *registry {
	return &registry{sinks: make(map[string]*Sink)}
}

func (r *registry) getOrCreate(streamKey string, retention time.Duration, maxSubscribers int) *Sink {
	r.mu.Lock()
	defer r.mu.Unlock()

	if sink, ok := r.sinks[streamKey]; ok {
		return sink
	}
	sink := NewSink(retention, maxSubscribers)
	r.sinks[streamKey] = sink
	return sink
}

func (r *registry) get(streamKey string) (*Sink, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sink, ok := r.sinks[streamKey]
	return sink, ok
}

func (r *registry) remove(streamKey string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sinks, streamKey)
}
