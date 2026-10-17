package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func (s *Server) launchBackground(fn func(context.Context)) {
	s.backgroundMu.Lock()
	if s.backgroundCtx.Err() != nil {
		s.backgroundMu.Unlock()
		return
	}
	s.backgroundWG.Add(1)
	s.backgroundMu.Unlock()
	go func() {
		defer s.backgroundWG.Done()
		fn(s.backgroundCtx)
	}()
}

func (s *Server) auxiliaryModel(ctx context.Context, id string) (*agent.Config, error) {
	return s.auxiliaryModelKind(ctx, id, "chat")
}

func (s *Server) auxiliaryModelKind(ctx context.Context, id, kind string) (*agent.Config, error) {
	if id == "" {
		return nil, nil
	}
	m, err := s.store.Model(ctx, id)
	if err != nil || !m.Available || m.Kind != kind {
		return nil, errors.New("辅助模型不可用")
	}
	p, err := s.store.Provider(ctx, m.ProviderID)
	if err != nil || !p.Enabled {
		return nil, errors.New("辅助模型服务未启用")
	}
	config := agent.AuxiliaryConfig(*s.modelConfig(ctx, m, p, m.DefaultEffort, storage.Settings{}))
	return &config, nil
}

func (s *Server) memoryContext(ctx context.Context, userID, projectID, sessionID, prompt string) (string, error) {
	text, _, err := s.memoryContextWithDiagnostics(ctx, userID, projectID, sessionID, prompt)
	return text, err
}

func (s *Server) memoryContextWithDiagnostics(ctx context.Context, userID, projectID, sessionID, prompt string) (string, []agent.Diagnostic, error) {
	diagnostics := []agent.Diagnostic{}
	pref, err := s.store.Preferences(ctx, userID)
	if err != nil || !pref.MemoryEnabled {
		return "", diagnostics, err
	}
	profile, exists, err := s.store.FrozenMemoryContext(ctx, userID, sessionID)
	if err != nil {
		return "", diagnostics, err
	}
	if !exists {
		items, err := s.store.StableMemoryProfile(ctx, userID)
		if err != nil {
			return "", diagnostics, err
		}
		profile, err = s.store.FreezeMemoryProfile(ctx, userID, sessionID, storage.MemoryProfileText(items), pref.MemoryRevision)
		if err != nil {
			return "", diagnostics, err
		}
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return "", diagnostics, err
	}
	var vector []float32
	short, cancel := context.WithTimeout(ctx, 4*time.Second)
	vectors, target, embedErr := s.embeddingVectorsTarget(short, settings.EmbeddingModelID, []string{prompt})
	cancel()
	if embedErr == nil && len(vectors) > 0 {
		vector = vectors[0]
	} else {
		diagnostics = memoryRecallDiagnostics(storage.MemoryRecallStatus{Mode: "lexical", Degraded: true, Events: []string{"embedding_unavailable", "lexical_fallback"}})
	}
	recalled, err := s.store.RecallMemoriesWithStatus(ctx, userID, projectID, prompt, target.Identity, vector)
	if err != nil {
		return "", diagnostics, err
	}
	diagnostics = append(diagnostics, memoryRecallDiagnostics(recalled.Status)...)
	// Dynamic recall runs once per accepted turn, never once per token/tool.
	// Explicit changes during retrieval must not return a stale deletion/setting.
	current, err := s.store.Preferences(ctx, userID)
	if err != nil || !current.MemoryEnabled || current.MemoryRevision != pref.MemoryRevision {
		return "", diagnostics, err
	}
	dynamic := make([]storage.Memory, 0, len(recalled.Items))
	for _, item := range recalled.Items {
		if !strings.Contains(profile, "id="+item.ID+" ") {
			dynamic = append(dynamic, item)
		}
	}
	return strings.TrimSpace(profile + "\n" + storage.MemoryContextText(dynamic)), diagnostics, nil
}

func memoryRecallDiagnostics(status storage.MemoryRecallStatus) []agent.Diagnostic {
	events := []agent.Diagnostic{}
	for _, kind := range status.Events {
		message := ""
		switch kind {
		case "embedding_unavailable":
			message = "Memory query embedding was unavailable; no vector was invented."
		case "lexical_fallback":
			message = "Memory recall used scoped lexical matching instead of vector recall."
		case "vector_query_failed":
			message = "Memory vector lookup failed; partial vector results were discarded."
		case "memory_changed":
			message = "Memory content or settings changed during recall; no stale records were returned."
		default:
			continue
		}
		events = append(events, agent.Diagnostic{Kind: kind, Class: "retrieval", Message: message})
	}
	return events
}

func trimRunes(v string, max int) string {
	runes := []rune(v)
	if len(runes) <= max {
		return v
	}
	return string(runes[:max])
}

func jsonObject(text string) string {
	start, end := strings.IndexByte(text, '{'), strings.LastIndexByte(text, '}')
	if start < 0 || end < start {
		return ""
	}
	return text[start : end+1]
}

func (s *Server) memoryTool(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
	var req struct {
		ID           string `json:"id"`
		Query        string `json:"query"`
		Content      string `json:"content"`
		Excerpt      string `json:"excerpt"`
		ProjectScope bool   `json:"project_scope"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return agent.ToolResult{}, err
	}
	pref, err := s.store.Preferences(ctx, userID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	if !pref.MemoryEnabled && name != "memory_delete" {
		return agent.ToolResult{Output: `{"memory_enabled":false,"memories":[]}`}, nil
	}
	scope, _ := agent.ScopeFromContext(ctx)
	if scope.UserID != userID || scope.SessionID == "" {
		return agent.ToolResult{}, errors.New("missing authorized memory scope")
	}
	session, err := s.store.GetSession(ctx, userID, scope.SessionID)
	if err != nil || session.ProjectID != scope.ProjectID {
		return agent.ToolResult{}, errors.New("memory namespace does not match the current conversation")
	}
	var value any
	switch name {
	case "memory_search":
		settings, _ := s.store.Settings(ctx)
		var vector []float32
		var target storage.MemoryEmbeddingTarget
		unavailable := false
		if req.Query != "" {
			short, cancel := context.WithTimeout(ctx, 8*time.Second)
			vectors, resolved, e := s.embeddingVectorsTarget(short, settings.EmbeddingModelID, []string{req.Query})
			cancel()
			target = resolved
			if e == nil && len(vectors) > 0 {
				vector = vectors[0]
			} else {
				unavailable = true
			}
		}
		var result storage.MemoryRecallResult
		result, err = s.store.RecallMemoriesWithStatus(ctx, userID, scope.ProjectID, req.Query, target.Identity, vector)
		if unavailable {
			result.Status.Degraded = true
			result.Status.Events = append([]string{"embedding_unavailable", "lexical_fallback"}, result.Status.Events...)
		}
		current, currentErr := s.store.Preferences(ctx, userID)
		if currentErr != nil {
			return agent.ToolResult{}, currentErr
		}
		if !current.MemoryEnabled || current.MemoryRevision != pref.MemoryRevision {
			result.Items = []storage.Memory{}
			result.Status.Degraded = true
			result.Status.Events = append(result.Status.Events, "memory_changed")
		}
		if scope.RunID != "" {
			if run, owned := s.store.GetRun(ctx, userID, scope.RunID); owned == nil && run.SessionID == scope.SessionID {
				for _, diagnostic := range memoryRecallDiagnostics(result.Status) {
					_ = s.store.SaveDiagnostic(ctx, scope.RunID, diagnostic)
				}
			}
		}
		value = result
	case "memory_save":
		m := storage.Memory{ID: req.ID, Content: req.Content, Kind: "fact", Source: "agent", SourceSessionID: scope.SessionID, SourceRunID: scope.RunID, SourceExcerpt: req.Excerpt, ExpectedRevision: &pref.MemoryRevision}
		if req.ProjectScope {
			if scope.ProjectID == "" {
				return agent.ToolResult{}, errors.New("project memory requires a project conversation")
			}
			m.ProjectID = scope.ProjectID
		}
		if req.ID != "" {
			old, e := s.store.Memory(ctx, userID, req.ID)
			if e != nil || old.ProjectID != m.ProjectID || (old.Kind != "fact" && old.Kind != "preference") {
				return agent.ToolResult{}, errors.New("memory correction is outside the current namespace or fact lifecycle")
			}
			m.Kind = old.Kind
		}
		if strings.TrimSpace(req.Excerpt) == "" || len(req.Excerpt) > 3000 {
			return agent.ToolResult{}, errors.New("memory_save requires a bounded exact excerpt from the current user statement")
		}
		value, err = s.store.SaveMemoryRecord(ctx, userID, m)
	case "memory_delete":
		old, e := s.store.Memory(ctx, userID, req.ID)
		if e != nil || (old.ProjectID != "" && old.ProjectID != scope.ProjectID) {
			return agent.ToolResult{}, errors.New("memory is outside the current namespace")
		}
		err = s.store.DeleteMemory(ctx, userID, req.ID)
		value = map[string]bool{"deleted": err == nil}
	default:
		err = fmt.Errorf("unknown memory tool %s", name)
	}
	if err != nil {
		return agent.ToolResult{}, err
	}
	data, _ := json.Marshal(value)
	return agent.ToolResult{Output: string(data)}, nil
}

func (s *Server) registerMemoryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/memories", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		items, err := s.store.ScopedMemories(r.Context(), currentUser(r).ID, q.Get("project_id"), q.Get("q"), !q.Has("project_id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	}))
	mux.HandleFunc("GET /api/memories/jobs", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.store.MemoryJobs(r.Context(), currentUser(r).ID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	}))
	mux.HandleFunc("GET /api/memories/index-job", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		job, err := s.store.MemoryIndexJobStatus(r.Context(), currentUser(r).ID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, job)
	}))
	save := s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		userID := currentUser(r).ID
		var input struct {
			Content   string     `json:"content"`
			Kind      string     `json:"kind"`
			ProjectID *string    `json:"project_id"`
			ExpiresAt *time.Time `json:"expires_at"`
		}
		if !decodeRequest(w, r, &input) {
			return
		}
		m := storage.Memory{Content: input.Content, Kind: input.Kind, Source: "user", ExpiresAt: input.ExpiresAt}
		if input.ProjectID != nil {
			m.ProjectID = *input.ProjectID
		}
		if id := r.PathValue("id"); id != "" {
			old, err := s.store.Memory(r.Context(), userID, id)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			m = old
			m.Content, m.Source = input.Content, "user"
			if input.Kind != "" {
				m.Kind = input.Kind
			}
			if input.ProjectID != nil {
				m.ProjectID = *input.ProjectID
			}
			if input.ExpiresAt != nil {
				m.ExpiresAt = input.ExpiresAt
			}
		}
		result, err := s.store.SaveMemoryRecord(r.Context(), userID, m)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /api/memories", save)
	mux.HandleFunc("PATCH /api/memories/{id}", save)
	mux.HandleFunc("DELETE /api/memories/{id}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.DeleteMemory(r.Context(), currentUser(r).ID, r.PathValue("id")); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}
