package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

const checkpointTimeout = 5 * time.Second

func (s *Server) startRun(parent context.Context, userID, sessionID, prompt, modelID, effort string, attachmentIDs []string, revision ...storage.Revision) (runtime.Snapshot, error) {
	if s.agent == nil {
		return runtime.Snapshot{}, errors.New("no model runner is configured")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer cancel()
	session, err := s.store.GetSession(ctx, userID, sessionID)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	if modelID == "" {
		modelID = session.ModelID
	}
	if effort == "" && modelID == session.ModelID {
		effort = session.Effort
	}
	var model storage.Model
	if _, demo := s.agent.(agent.DemoGenerator); demo {
		model.Name = "演示模式"
	} else {
		model, _, err = s.selectedModel(ctx, modelID, effort)
		if err != nil {
			return runtime.Snapshot{}, err
		}
		if err = s.checkHistoryCompatibility(ctx, sessionID, model); err != nil {
			return runtime.Snapshot{}, err
		}
	}
	if effort == "" {
		effort = model.DefaultEffort
	}
	if _, err = s.attachmentsForRun(ctx, userID, sessionID, attachmentIDs); err != nil {
		return runtime.Snapshot{}, err
	}
	var rev storage.Revision
	if len(revision) > 0 {
		rev = revision[0]
	}
	if rev.EditMessageID != "" || rev.RetryRunID != "" {
		if rev.EditMessageID != "" && rev.RetryRunID != "" {
			return runtime.Snapshot{}, errors.New("修改和重试不能同时进行")
		}
		if session.ActiveRunID != "" {
			return runtime.Snapshot{}, errors.New("请先停止当前轮次后再修改或重试")
		}
		last, lastErr := s.store.LastUserMessage(ctx, userID, sessionID, rev)
		if lastErr != nil {
			return runtime.Snapshot{}, lastErr
		}
		if rev.RetryRunID != "" {
			prompt = last.Content
		}
	}
	id, err := newID()
	if err != nil {
		return runtime.Snapshot{}, err
	}
	snapshot, err := s.store.EnqueueRun(ctx, storage.PendingRun{RunID: id, SessionID: sessionID, UserID: userID, Message: prompt, ModelID: model.ID, ModelName: model.Name, Effort: effort, AttachmentIDs: attachmentIDs, Revision: rev, Timezone: clientTimezone(ctx)}, rev.Priority)
	if err != nil {
		return snapshot, err
	}
	s.runtime.Restore(snapshot)
	if rev.Priority {
		s.cancelSessionActive(ctx, userID, sessionID)
	}
	s.launchQueued(sessionID)
	if live, ok := s.runtime.Get(id); ok {
		return live.Snapshot(), nil
	}
	return snapshot, nil
}

func (s *Server) StartQueue(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	s.queueCancel = cancel
	s.backgroundWG.Add(1)
	go func() {
		defer s.backgroundWG.Done()
		ticker := time.NewTicker(750 * time.Millisecond)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil || s.backgroundCtx.Err() != nil {
				return
			}
			query, done := context.WithTimeout(ctx, 5*time.Second)
			sessions, err := s.store.ReadyQueuedSessions(query)
			done()
			if err != nil && ctx.Err() == nil {
				log.Printf("pending requests: %v", err)
			}
			for _, id := range sessions {
				s.launchQueued(id)
			}
			select {
			case <-ctx.Done():
				return
			case <-s.backgroundCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *Server) launchQueued(sessionID string) {
	if !s.beginQueueAdmission() {
		return
	}
	defer s.queueAdmissions.Done()
	// Admission serializes only one session's short row-lock transaction. Its
	// canonical user turn is appended only after this pending input is claimed.
	ctx, cancel := context.WithTimeout(s.backgroundCtx, 15*time.Second)
	defer cancel()
	v, err := s.store.ClaimQueuedRun(ctx, sessionID)
	if errors.Is(err, storage.ErrActiveRun) || errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		log.Printf("claim queued request: %v", err)
		return
	}
	// Publish the claim before preparing attachments so a stop request can
	// cancel this manager-owned context even during slow file/provider setup.
	if claimed, readErr := s.store.GetRun(ctx, v.UserID, v.RunID); readErr == nil {
		s.runtime.ApplySnapshot(claimed)
	}
	ctx = withClientTimezone(ctx, v.Timezone)
	_, err = s.startQueuedRun(ctx, v.UserID, v.SessionID, v.RunID, v.Message, v.ModelID, v.Effort, v.AttachmentIDs, v.Revision)
	if err == nil {
		return
	}
	persist, finish := context.WithTimeout(context.Background(), checkpointTimeout)
	defer finish()
	snapshot, readErr := s.store.GetRun(persist, v.UserID, v.RunID)
	if readErr == nil {
		snapshot.Status, snapshot.Error = runtime.StatusFailed, err.Error()
		snapshot.Seq++
		snapshot.UpdatedAt = time.Now().UTC()
		_ = s.store.CompleteRun(persist, snapshot)
		s.runtime.ApplySnapshot(snapshot)
	}
	_ = s.store.DiscardRunRequest(persist, v.RunID)
	log.Printf("start queued run %s: %v", v.RunID, err)
}

func (s *Server) beginQueueAdmission() bool {
	s.queueAdmissionMu.Lock()
	defer s.queueAdmissionMu.Unlock()
	if s.draining || s.backgroundCtx.Err() != nil {
		return false
	}
	// Add and the drain boundary share a lock: Wait cannot miss a claimed run
	// that has not reached runtime.Start yet.
	s.queueAdmissions.Add(1)
	return true
}

func (s *Server) cancelSessionActive(ctx context.Context, userID, sessionID string) {
	session, err := s.store.GetSession(ctx, userID, sessionID)
	if err != nil || session.ActiveRunID == "" {
		return
	}
	if live, ok := s.runtime.Get(session.ActiveRunID); ok {
		live.Cancel()
	}
}

func (s *Server) registerQueueRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{id}/queue", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.PendingRuns(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}))
	mux.HandleFunc("DELETE /api/sessions/{id}/queue/{runId}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		userID := currentUser(r).ID
		if err := s.store.CancelPendingRun(r.Context(), userID, r.PathValue("id"), r.PathValue("runId")); err != nil {
			writeStoreError(w, err)
			return
		}
		if snapshot, err := s.store.GetRun(r.Context(), userID, r.PathValue("runId")); err == nil {
			s.runtime.ApplySnapshot(snapshot)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("PATCH /api/sessions/{id}/queue/{runId}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Message *string `json:"message"`
			ModelID *string `json:"model_id"`
			Effort  *string `json:"effort"`
		}
		if !decodeRequest(w, r, &input) {
			return
		}
		userID := currentUser(r).ID
		items, err := s.store.PendingRuns(r.Context(), userID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		var selected *storage.PendingRun
		for i := range items {
			if items[i].RunID == r.PathValue("runId") {
				selected = &items[i]
				break
			}
		}
		if selected == nil {
			writeStoreError(w, pgx.ErrNoRows)
			return
		}
		if input.Message != nil {
			selected.Message = strings.TrimSpace(*input.Message)
		}
		if input.ModelID != nil {
			selected.ModelID = *input.ModelID
			selected.Effort = ""
		}
		if input.Effort != nil {
			selected.Effort = *input.Effort
		}
		if selected.Message == "" {
			writeError(w, http.StatusBadRequest, errors.New("请输入消息"))
			return
		}
		if _, demo := s.agent.(agent.DemoGenerator); !demo {
			model, _, err := s.selectedModel(r.Context(), selected.ModelID, selected.Effort)
			if err != nil {
				writeStartError(w, err)
				return
			}
			selected.ModelName = model.Name
		}
		v, err := s.store.EditPendingRun(r.Context(), userID, selected.SessionID, selected.RunID, selected.Message, selected.ModelID, selected.ModelName, selected.Effort)
		if err != nil {
			writeStartError(w, err)
			return
		}
		if snapshot, err := s.store.GetRun(r.Context(), userID, v.RunID); err == nil {
			s.runtime.ApplySnapshot(snapshot)
		}
		writeJSON(w, http.StatusOK, v)
	}))
}
