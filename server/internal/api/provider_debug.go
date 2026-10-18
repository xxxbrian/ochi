package api

import (
	"context"
	"log"
	"time"

	"ochi/server/internal/agent"
)

func (s *Server) configureProviderDebug(config *agent.Config) {
	config.DebugEnabled = s.debugMode.Load
	config.ObserveProvider = s.recordProviderTrace
}

func (s *Server) startProviderDebugRetention() {
	s.launchBackground(func(parent context.Context) {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			ctx, cancel := context.WithTimeout(parent, 5*time.Second)
			if err := s.store.PruneProviderTraces(ctx); err != nil && parent.Err() == nil {
				log.Printf("provider debug: retention cleanup failed")
			}
			cancel()
			select {
			case <-parent.Done():
				return
			case <-ticker.C:
			}
		}
	})
}

// Debug writes are bounded and independent of token delivery. During shutdown,
// final traces can still drain after the run's execution context is cancelled.
func (s *Server) recordProviderTrace(trace agent.ProviderTrace) {
	select {
	case s.providerDebugSlots <- struct{}{}:
	default:
		log.Printf("provider debug %s: recording capacity reached", trace.ID)
		return
	}
	s.backgroundMu.Lock()
	if s.providerDebugClosed {
		s.backgroundMu.Unlock()
		<-s.providerDebugSlots
		return
	}
	s.providerDebugWG.Add(1)
	s.backgroundMu.Unlock()
	go func() {
		defer s.providerDebugWG.Done()
		defer func() { <-s.providerDebugSlots }()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.store.SaveProviderTrace(ctx, trace.RunID, trace); err != nil {
			log.Printf("provider debug %s: recording failed: %v", trace.ID, err)
		}
	}()
}
