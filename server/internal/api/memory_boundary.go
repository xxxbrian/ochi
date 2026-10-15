package api

import (
	"context"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

type memoryBoundaryState struct {
	preferences storage.Preferences
	known       bool
	expiresAt   *time.Time
}

func (s *Server) memoryBoundaryState(ctx context.Context, request agent.Request) *memoryBoundaryState {
	preferences, err := s.store.Preferences(ctx, request.UserID)
	expires, expiryErr := s.store.MemoryContextExpiry(ctx, request.UserID, request.Scope.ProjectID)
	return &memoryBoundaryState{preferences: preferences, known: err == nil && expiryErr == nil, expiresAt: expires}
}

func observeBoundaryMemory(request agent.Request, event agent.Diagnostic) {
	if request.Config != nil && request.Config.Observe != nil {
		request.Config.Observe(event)
	}
}

func (s *Server) refreshBoundaryMemory(ctx context.Context, request agent.Request, state *memoryBoundaryState) *string {
	current, err := s.store.Preferences(ctx, request.UserID)
	empty := ""
	if err != nil {
		state.known = false
		observeBoundaryMemory(request, agent.Diagnostic{Kind: "memory_recall_degraded", Class: "retrieval", Message: "Memory settings could not be checked; prior retrieved context was removed."})
		return &empty
	}
	if !current.MemoryEnabled {
		state.preferences, state.known, state.expiresAt = current, true, nil
		return &empty
	}
	profile, exists, err := s.store.FrozenMemoryContext(ctx, request.UserID, request.SessionID)
	if err != nil {
		state.known = false
		observeBoundaryMemory(request, agent.Diagnostic{Kind: "memory_recall_degraded", Class: "retrieval", Message: "Memory profile could not be checked; prior retrieved context was removed."})
		return &empty
	}
	if state.known && state.preferences.MemoryEnabled && current.MemoryRevision == state.preferences.MemoryRevision && exists && (state.expiresAt == nil || time.Now().Before(*state.expiresAt)) {
		return nil
	}
	// User changes/expiry invalidate old related recall. Rebuild only the small
	// stable profile here; a new accepted input still receives full turn recall.
	if !exists {
		items, readErr := s.store.StableMemoryProfile(ctx, request.UserID)
		if readErr == nil {
			profile, readErr = s.store.FreezeMemoryProfile(ctx, request.UserID, request.SessionID, storage.MemoryProfileText(items), current.MemoryRevision)
		}
		err = readErr
	}
	expires, expiryErr := s.store.MemoryContextExpiry(ctx, request.UserID, request.Scope.ProjectID)
	latest, guardErr := s.store.Preferences(ctx, request.UserID)
	state.preferences, state.known, state.expiresAt = current, err == nil && expiryErr == nil && guardErr == nil, expires
	if !state.known || !latest.MemoryEnabled || latest.MemoryRevision != current.MemoryRevision {
		state.known = false
		observeBoundaryMemory(request, agent.Diagnostic{Kind: "memory_recall_degraded", Class: "retrieval", Message: "Memory changed during refresh; prior retrieved context was removed."})
		return &empty
	}
	observeBoundaryMemory(request, agent.Diagnostic{Kind: "memory_context_invalidated", Class: "retrieval", Message: "Memory changes or expiry removed prior related recall; only the current stable profile remains."})
	return &profile
}
