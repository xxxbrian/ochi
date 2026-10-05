package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"ochi/server/internal/agent"
)

// Inspectable JSON is exact for bounded ordinary requests. Binary images and
// oversized text are explicitly replaced with byte/hash records, never silently
// represented as complete model input. The original-body hash remains intact.
func boundedInspection(v agent.ContextInspection) agent.ContextInspection {
	var body any
	if json.Unmarshal(v.Request, &body) != nil {
		v.Request = nil
		v.Redacted = true
		return v
	}
	var bound func(any) any
	bound = func(value any) any {
		switch value := value.(type) {
		case string:
			if strings.HasPrefix(value, "data:") || len(value) > 64000 {
				sum := sha256.Sum256([]byte(value))
				v.Redacted = true
				return map[string]any{"omitted": "large_or_binary_input", "bytes": len(value), "sha256": hex.EncodeToString(sum[:])}
			}
		case map[string]any:
			for key, child := range value {
				value[key] = bound(child)
			}
		case []any:
			for i, child := range value {
				value[i] = bound(child)
			}
		}
		return value
	}
	v.Request, _ = json.Marshal(bound(body))
	if len(v.Request) > 1000000 {
		v.Redacted = true
		v.Request, _ = json.Marshal(map[string]any{"omitted": "oversized_model_input", "exact_body_sha256": v.SHA256})
	}
	return v
}

type frozenRequestKey struct{}

func (s *Server) recordRunDiagnostic(runID string, event agent.Diagnostic) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.store.SaveDiagnostic(ctx, runID, event); err != nil {
		log.Printf("run %s: diagnostic recording unavailable", runID)
	}
}

func frozenRequest(ctx context.Context) (agent.Request, bool) {
	v, ok := ctx.Value(frozenRequestKey{}).(agent.Request)
	return v, ok
}

func (s *Server) configureRunContext(request *agent.Request) {
	rounds := request.Config.MaxToolRounds
	if rounds <= 0 {
		rounds = 48
	}
	request.Budget = agent.NewExecutionBudget(rounds + 1)
	request.BeforeCompaction = func(ctx context.Context) error {
		return s.preserveMemoryBeforeCompaction(ctx, request.UserID, request.RunID)
	}
	if request.AtBoundary == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		state := s.memoryBoundaryState(ctx, *request)
		cancel()
		request.AtBoundary = func(ctx context.Context) (agent.BoundaryUpdate, error) {
			return s.runBoundaryWithMemory(ctx, *request, state)
		}
	}
	request.ObserveContext = func(v agent.ContextInspection) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.store.SaveContextInspection(ctx, request.RunID, boundedInspection(v)); err != nil {
			log.Printf("run %s: context inspection unavailable", request.RunID)
		}
	}
	request.Config.Observe = func(v agent.Diagnostic) {
		s.recordRunDiagnostic(request.RunID, v)
	}
}

func (s *Server) registerContextRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/runs/{id}/diagnostics", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Diagnostics(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}))
	for _, route := range []string{"GET /api/runs/{id}/contexts", "GET /api/runs/{id}/contexts/{round}"} {
		mux.HandleFunc(route, s.auth.require(func(w http.ResponseWriter, r *http.Request) {
			v, err := s.store.ContextInspections(r.Context(), currentUser(r).ID, r.PathValue("id"), r.PathValue("round"))
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, v)
		}))
	}
}
