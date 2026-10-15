package api

import (
	"context"
	"log"
	"time"
)

func (s *Server) enqueueMemoryIndexesAfterConfigChange(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	// Effective configuration fingerprints reject old vectors immediately.
	// This is only a prompt wakeup; the durable worker's backlog scan also
	// recovers a crash between config commit and enqueue. Unchanged failed jobs
	// are not reset, and unrelated admin edits do not force a full reindex.
	if err := s.store.EnqueueAllMemoryIndexes(ctx, false); err != nil {
		log.Printf("memory indexing wakeup unavailable; durable backlog scan will retry")
	}
}
