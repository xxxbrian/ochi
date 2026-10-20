package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func (s *Server) newSchedule(ctx context.Context, userID string, item storage.Schedule) (storage.Schedule, error) {
	if err := storage.NormalizeSchedule(&item); err != nil {
		return item, err
	}
	if item.ContextMode == "session" && item.SessionID != "" {
		session, err := s.store.GetSession(ctx, userID, item.SessionID)
		if err != nil {
			return item, err
		}
		if item.ProjectID != "" && item.ProjectID != session.ProjectID {
			return item, errors.New("所选对话不属于此项目")
		}
		item.ProjectID = session.ProjectID
	}
	if item.SessionID == "" {
		session, err := s.store.CreateSession(ctx, userID, item.ProjectID)
		if err != nil {
			return item, err
		}
		item.SessionID = session.ID
		if err = s.store.MarkScheduleSession(ctx, userID, session.ID, item.Name); err != nil {
			return item, err
		}
	}
	if item.ModelID != "" {
		if _, _, err := s.selectedModel(ctx, item.ModelID, item.Effort); err != nil {
			return item, err
		}
	}
	return s.store.SaveSchedule(ctx, userID, item)
}
func (s *Server) launchSchedule(ctx context.Context, userID string, item storage.Schedule) (runtime.Snapshot, error) {
	executionID, shouldRun := item.ExecutionID, !item.ExecutionSkipped
	var err error
	if executionID == "" {
		executionID, shouldRun, err = s.store.BeginScheduleExecution(ctx, userID, item.ID)
		if err != nil {
			return runtime.Snapshot{}, err
		}
	}
	if !shouldRun {
		return runtime.Snapshot{Status: "skipped"}, nil
	}
	fail := func(message string) (runtime.Snapshot, error) {
		persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := s.store.LinkScheduleExecution(persist, executionID, "", "", message); err != nil {
			log.Printf("persist failed schedule execution %s: %v", executionID, err)
		}
		return runtime.Snapshot{}, errors.New(message)
	}
	enabled, err := s.store.UserEnabled(ctx, userID)
	if err != nil || !enabled {
		return fail("账号未启用")
	}
	sessionID := item.SessionID
	if item.ContextMode != "session" {
		session, e := s.store.CreateSession(ctx, userID, item.ProjectID)
		if e != nil {
			return fail("创建执行会话失败")
		}
		sessionID = session.ID
		if e = s.store.MarkScheduleSession(ctx, userID, sessionID, item.Name+" · "+time.Now().Format("01-02 15:04")); e != nil {
			return fail("创建执行记录失败")
		}
	}
	snapshot, err := s.startRun(ctx, userID, sessionID, item.Prompt, item.ModelID, item.Effort, nil)
	if err != nil {
		return fail(err.Error())
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err = s.store.LinkScheduleExecution(persist, executionID, snapshot.RunID, sessionID, ""); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}
func (s *Server) registerScheduleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/schedules", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.store.Schedules(r.Context(), currentUser(r).ID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
	}))
	mux.HandleFunc("GET /api/schedules/{id}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		item, err := s.store.Schedule(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	}))
	save := s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		item := storage.Schedule{Enabled: true, Recurrence: "interval", Timezone: "Asia/Shanghai", TimeOfDay: "09:00", ContextMode: "independent", IntervalMinutes: 60}
		if id := r.PathValue("id"); id != "" {
			var err error
			item, err = s.store.Schedule(r.Context(), currentUser(r).ID, id)
			if err != nil {
				writeStoreError(w, err)
				return
			}
		}
		oldTiming, oldEnabled := storage.ScheduleTimingKey(item), item.Enabled
		if !decodeRequest(w, r, &item) {
			return
		}
		item.ID = r.PathValue("id")
		if oldTiming != storage.ScheduleTimingKey(item) || !oldEnabled && item.Enabled {
			item.NextRunAt = time.Time{}
		}
		result, err := s.newSchedule(r.Context(), currentUser(r).ID, item)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /api/schedules", save)
	mux.HandleFunc("PATCH /api/schedules/{id}", save)
	mux.HandleFunc("DELETE /api/schedules/{id}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.DeleteSchedule(r.Context(), currentUser(r).ID, r.PathValue("id")); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/schedules/{id}/run", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		item, err := s.store.Schedule(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		snapshot, err := s.launchSchedule(r.Context(), currentUser(r).ID, item)
		if err != nil {
			writeStartError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, snapshot)
	}))
	mux.HandleFunc("GET /api/schedules/{id}/executions", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.store.ScheduleExecutions(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		for i := range items {
			if live, ok := s.runtime.Get(items[i].RunID); ok {
				v := live.Snapshot()
				items[i].Status, items[i].Output, items[i].Error, items[i].Artifacts = v.Status, v.Output, v.Error, v.Artifacts
			}
		}
		writeJSON(w, http.StatusOK, items)
	}))
	mux.HandleFunc("GET /api/schedules/{id}/executions/{executionID}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		item, err := s.store.ScheduleExecution(r.Context(), currentUser(r).ID, r.PathValue("id"), r.PathValue("executionID"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if live, ok := s.runtime.Get(item.RunID); ok {
			v := live.Snapshot()
			item.Snapshot = &v
			item.Status, item.Output, item.Error, item.Artifacts = v.Status, v.Output, v.Error, v.Artifacts
		}
		writeJSON(w, http.StatusOK, item)
	}))
}
func (s *Server) StartScheduler(parent context.Context) {
	recovery, cancelRecovery := context.WithTimeout(parent, 10*time.Second)
	if err := s.store.RecoverScheduleExecutions(recovery); err != nil {
		log.Printf("recover schedule execution reservations: %v", err)
	}
	cancelRecovery()
	ctx, cancel := context.WithCancel(parent)
	s.schedulerCancel = cancel
	s.backgroundWG.Add(1)
	go func() {
		defer s.backgroundWG.Done()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			poll, finish := context.WithTimeout(ctx, 10*time.Second)
			items, err := s.store.ClaimDueSchedules(poll)
			finish()
			if err != nil {
				log.Printf("schedule poll: %v", err)
				continue
			}
			for _, item := range items {
				if ctx.Err() != nil {
					return
				}
				launch, done := context.WithTimeout(ctx, 30*time.Second)
				_, err := s.launchSchedule(launch, item.UserID, item)
				done()
				if err != nil {
					log.Printf("schedule execution %s: %v", item.ID, err)
				}
			}
		}
	}()
}
func (s *Server) scheduleTool(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
	var input struct {
		ID              string     `json:"id"`
		Name            string     `json:"name"`
		Prompt          string     `json:"prompt"`
		IntervalMinutes int        `json:"interval_minutes"`
		Recurrence      string     `json:"recurrence"`
		Timezone        string     `json:"timezone"`
		TimeOfDay       string     `json:"time_of_day"`
		Weekdays        []int      `json:"weekdays"`
		OnceAt          *time.Time `json:"once_at"`
		Enabled         *bool      `json:"enabled"`
		Delete          bool       `json:"delete"`
		ProjectID       *string    `json:"project_id"`
		ModelID         *string    `json:"model_id"`
		Effort          *string    `json:"effort"`
		ContextMode     *string    `json:"context_mode"`
		SessionID       *string    `json:"session_id"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return agent.ToolResult{}, err
	}
	var value any
	var err error
	switch name {
	case "schedule_list":
		value, err = s.store.Schedules(ctx, userID)
	case "schedule_create":
		scope, _ := agent.ScopeFromContext(ctx)
		item := storage.Schedule{Name: input.Name, Prompt: input.Prompt, IntervalMinutes: input.IntervalMinutes, Recurrence: input.Recurrence, Timezone: input.Timezone, TimeOfDay: input.TimeOfDay, Weekdays: input.Weekdays, OnceAt: input.OnceAt, ProjectID: scope.ProjectID, Enabled: true, ContextMode: "independent"}
		if input.ProjectID != nil {
			item.ProjectID = *input.ProjectID
		}
		if input.ModelID != nil {
			item.ModelID = *input.ModelID
		}
		if input.Effort != nil {
			item.Effort = *input.Effort
		}
		if input.ContextMode != nil {
			item.ContextMode = *input.ContextMode
		}
		if input.SessionID != nil {
			item.SessionID = *input.SessionID
		} else if item.ContextMode == "session" {
			item.SessionID = scope.SessionID
		}
		value, err = s.newSchedule(ctx, userID, item)
	case "schedule_update":
		if input.Delete {
			err = s.store.DeleteSchedule(ctx, userID, input.ID)
			value = map[string]bool{"deleted": err == nil}
		} else {
			item, e := s.store.Schedule(ctx, userID, input.ID)
			if e != nil {
				return agent.ToolResult{}, e
			}
			oldTiming, oldEnabled := storage.ScheduleTimingKey(item), item.Enabled
			if input.Enabled != nil {
				item.Enabled = *input.Enabled
			}
			if input.Prompt != "" {
				item.Prompt = input.Prompt
			}
			if input.Name != "" {
				item.Name = input.Name
			}
			if input.IntervalMinutes > 0 {
				item.IntervalMinutes = input.IntervalMinutes
			}
			if input.Recurrence != "" {
				item.Recurrence = input.Recurrence
			}
			if input.Timezone != "" {
				item.Timezone = input.Timezone
			}
			if input.TimeOfDay != "" {
				item.TimeOfDay = input.TimeOfDay
			}
			if input.Weekdays != nil {
				item.Weekdays = input.Weekdays
			}
			if input.OnceAt != nil {
				item.OnceAt = input.OnceAt
			}
			if input.ProjectID != nil {
				item.ProjectID = *input.ProjectID
			}
			if input.ModelID != nil {
				item.ModelID = *input.ModelID
			}
			if input.Effort != nil {
				item.Effort = *input.Effort
			}
			if input.ContextMode != nil {
				item.ContextMode = *input.ContextMode
			}
			if input.SessionID != nil {
				item.SessionID = *input.SessionID
			}
			if oldTiming != storage.ScheduleTimingKey(item) || !oldEnabled && item.Enabled {
				item.NextRunAt = time.Time{}
			}
			value, err = s.newSchedule(ctx, userID, item)
		}
	default:
		err = errors.New("unknown schedule tool: " + strings.TrimSpace(name))
	}
	data, _ := json.Marshal(value)
	return agent.ToolResult{Output: string(data)}, err
}
