package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/selfupdate"
	"ochi/server/internal/storage"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type Server struct {
	store               *storage.Store
	runtime             *runtime.Manager
	agent               agent.Generator
	auth                *authentication
	tools               agent.ToolSource
	schedulerCancel     context.CancelFunc
	backgroundCtx       context.Context
	backgroundCancel    context.CancelFunc
	backgroundWG        sync.WaitGroup
	backgroundMu        sync.Mutex
	settingsUpdateMu    sync.Mutex
	debugMode           atomic.Bool
	providerDebugSlots  chan struct{}
	providerDebugWG     sync.WaitGroup
	providerDebugClosed bool
	queueCancel         context.CancelFunc
	queueAdmissionMu    sync.Mutex
	queueAdmissions     sync.WaitGroup
	draining            bool
	resources           *resourceManager
	desktops            *desktopHub
	permissionMu        sync.Mutex
	computerCalls       sync.Map
	preparedScopes      sync.Map
	scopePreparations   sync.Map
	memoryWorkerOnce    sync.Once
	extensionMu         sync.Mutex
	updater             *selfupdate.Manager
}

func NewServer(store *storage.Store, generator agent.Generator, accounts []Account, secureCookies bool) (*Server, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	settings, err := store.Settings(ctx)
	cancel()
	if err != nil {
		return nil, err
	}
	auth, err := newAuthentication(store, accounts, secureCookies)
	if err != nil {
		return nil, err
	}
	backgroundCtx, backgroundCancel := context.WithCancel(context.Background())
	s := &Server{store: store, runtime: runtime.NewManager(), agent: generator, auth: auth, resources: newResourceManager(), desktops: newDesktopHub(), backgroundCtx: backgroundCtx, backgroundCancel: backgroundCancel, providerDebugSlots: make(chan struct{}, 8)}
	s.debugMode.Store(settings.DebugMode)
	s.startProviderDebugRetention()
	return s, nil
}

// Drain pauses queue claims, lets their in-flight preparation finish, and then
// waits for current runs. New inputs stay queued in PostgreSQL for the restart.
func (s *Server) Drain(ctx context.Context) error {
	s.stopQueueAdmissions()
	if err := s.waitQueueAdmissions(ctx); err != nil {
		return err
	}
	return s.runtime.Drain(ctx)
}

func (s *Server) stopQueueAdmissions() {
	s.queueAdmissionMu.Lock()
	s.draining = true
	s.queueAdmissionMu.Unlock()
	if s.schedulerCancel != nil {
		s.schedulerCancel()
	}
	if s.queueCancel != nil {
		s.queueCancel()
	}
}

func (s *Server) waitQueueAdmissions(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.queueAdmissions.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.stopQueueAdmissions()
	s.desktops.Close()
	s.backgroundMu.Lock()
	s.backgroundCancel()
	s.backgroundMu.Unlock()
	if err := s.runtime.Shutdown(ctx); err != nil {
		return err
	}
	if err := s.waitQueueAdmissions(ctx); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		s.backgroundWG.Wait()
		s.backgroundMu.Lock()
		s.providerDebugClosed = true
		s.backgroundMu.Unlock()
		s.providerDebugWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) SetTools(source agent.ToolSource) {
	s.tools = s.wrapTools(source)
}

func (s *Server) SetUpdater(updater *selfupdate.Manager) {
	s.updater = updater
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/auth/login", s.auth.login)
	mux.HandleFunc("POST /api/auth/logout", s.auth.logout)
	mux.HandleFunc("POST /api/auth/webview", s.auth.require(s.auth.webview))
	mux.HandleFunc("GET /api/auth/webview", s.auth.require(s.auth.webview))
	mux.HandleFunc("GET /api/auth/me", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, currentUser(r))
	}))
	mux.HandleFunc("POST /api/sessions", s.auth.require(s.createSession))
	mux.HandleFunc("GET /api/sessions", s.auth.require(s.listSessions))
	mux.HandleFunc("GET /api/sessions/page", s.auth.require(s.sessionsPage))
	mux.HandleFunc("GET /api/sessions/{id}", s.auth.require(s.getSession))
	mux.HandleFunc("POST /api/sessions/{id}/runs", s.auth.require(s.createRun))
	mux.HandleFunc("GET /api/sessions/{id}/messages", s.auth.require(s.messages))
	mux.HandleFunc("GET /api/runs/{id}", s.auth.require(s.getRun))
	mux.HandleFunc("GET /api/runs/{id}/events", s.auth.require(s.runEvents))
	mux.HandleFunc("POST /api/runs/{id}/cancel", s.auth.require(s.cancelRun))
	mux.HandleFunc("POST /api/runs/{id}/resume", s.auth.require(s.resumeRun))
	mux.HandleFunc("PATCH /api/sessions/{id}", s.auth.require(s.updateSession))
	mux.HandleFunc("DELETE /api/sessions/{id}", s.auth.require(s.deleteSession))
	s.registerProjectRoutes(mux)
	s.registerQueueRoutes(mux)
	s.registerAdminRoutes(mux)
	s.registerUpdateRoutes(mux)
	s.registerExtraRoutes(mux)
	s.registerTaskRoutes(mux)
	s.registerContextRoutes(mux)
	return mux
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ModelID          string `json:"model_id"`
		Effort           string `json:"effort"`
		ProjectID        string `json:"project_id"`
		BudgetTokens     *int   `json:"budget_tokens"`
		ReasoningEnabled *bool  `json:"reasoning_enabled"`
		ComputerEnabled  *bool  `json:"computer_enabled"`
	}
	if r.ContentLength > 0 && !decodeRequest(w, r, &req) {
		return
	}
	if req.BudgetTokens != nil {
		req.Effort = "budget:" + strconv.Itoa(*req.BudgetTokens)
	}
	if req.ReasoningEnabled != nil {
		req.Effort = "off"
		if *req.ReasoningEnabled {
			req.Effort = "on"
		}
	}
	if req.ModelID != "" {
		if _, _, err := s.selectedModel(r.Context(), req.ModelID, req.Effort); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	item, err := s.store.CreateSession(r.Context(), currentUser(r).ID, req.ProjectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if req.ModelID != "" {
		item, err = s.store.UpdateSession(r.Context(), currentUser(r).ID, item.ID, "", req.ModelID, req.Effort)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if req.ComputerEnabled != nil {
		item, err = s.store.SetSessionComputer(r.Context(), currentUser(r).ID, item.ID, *req.ComputerEnabled, true)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, item)
}
func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 60
	if q.Get("limit") != "" {
		if n, e := strconv.Atoi(q.Get("limit")); e == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	items, err := s.store.SearchSessions(r.Context(), currentUser(r).ID, q.Get("q"), q.Get("before"), limit, q.Get("project_id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	userID, sessionID := currentUser(r).ID, r.PathValue("id")
	item, err := s.store.GetSession(r.Context(), userID, sessionID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	latest, err := s.store.LatestRun(r.Context(), userID, sessionID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if latest != nil {
		if live, ok := s.runtime.Get(latest.RunID); ok {
			snap := live.Snapshot()
			latest = &snap
		}
	}
	writeJSON(w, http.StatusOK, struct {
		storage.Session
		LatestRun *runtime.Snapshot `json:"latest_run"`
	}{item, latest})
}
func (s *Server) updateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title            *string `json:"title"`
		ModelID          *string `json:"model_id"`
		Effort           *string `json:"effort"`
		BudgetTokens     *int    `json:"budget_tokens"`
		ReasoningEnabled *bool   `json:"reasoning_enabled"`
		ComputerEnabled  *bool   `json:"computer_enabled"`
		RememberComputer *bool   `json:"remember_computer_default"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	if req.BudgetTokens != nil {
		effort := "budget:" + strconv.Itoa(*req.BudgetTokens)
		req.Effort = &effort
	}
	if req.ReasoningEnabled != nil {
		effort := "off"
		if *req.ReasoningEnabled {
			effort = "on"
		}
		req.Effort = &effort
	}
	current, err := s.store.GetSession(r.Context(), currentUser(r).ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	title := ""
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" || len([]rune(title)) > 120 {
			writeError(w, http.StatusBadRequest, errors.New("标题应为 1 到 120 个字符"))
			return
		}
	}
	modelID, effort := current.ModelID, current.Effort
	if req.ModelID != nil {
		modelID = *req.ModelID
		if modelID != current.ModelID {
			effort = ""
		}
	}
	if req.Effort != nil {
		effort = *req.Effort
	}
	if modelID != "" && (req.ModelID != nil || req.Effort != nil) {
		model, _, err := s.selectedModel(r.Context(), modelID, effort)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if modelID != current.ModelID {
			if err := s.checkHistoryCompatibility(r.Context(), current.ID, model); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
		}
	}
	item := current
	if req.Title != nil || req.ModelID != nil || req.Effort != nil {
		item, err = s.store.UpdateSession(r.Context(), currentUser(r).ID, r.PathValue("id"), title, modelID, effort)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if req.ComputerEnabled != nil {
		s.permissionMu.Lock()
		remember := req.RememberComputer == nil || *req.RememberComputer
		item, err = s.store.SetSessionComputer(r.Context(), currentUser(r).ID, current.ID, *req.ComputerEnabled, remember)
		if err == nil && current.ActiveRunID != "" {
			if run, ok := s.runtime.Get(current.ActiveRunID); ok {
				if !*req.ComputerEnabled {
					run.RevokeComputerGrant()
				} else if pending := run.Snapshot().WaitingInput; pending != nil && pending.Kind == "computer_permission" {
					grant := true
					_, err = run.ResumeWithGrant("allow_session", &grant, func(snapshot runtime.Snapshot) error { return s.store.Checkpoint(r.Context(), snapshot) })
				}
			}
		}
		if err == nil && !*req.ComputerEnabled {
			if active := s.interruptComputerCalls(current.ID); !active && current.ActiveRunID != "" {
				s.resources.releaseRun(current.ActiveRunID)
			}
			s.resources.wake()
		}
		s.permissionMu.Unlock()
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSession(r.Context(), currentUser(r).ID, r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	if source, err := s.bridgeSource(); err == nil {
		if cleaner, ok := source.(interface {
			RemoveCompute(context.Context, string, string) error
		}); ok {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
			if err := cleaner.RemoveCompute(ctx, currentUser(r).ID, r.PathValue("id")); err != nil {
				log.Printf("remove conversation scratch: %v", err)
			}
			cancel()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message          string   `json:"message"`
		ModelID          string   `json:"model_id"`
		Effort           string   `json:"effort"`
		BudgetTokens     *int     `json:"budget_tokens"`
		ReasoningEnabled *bool    `json:"reasoning_enabled"`
		AttachmentIDs    []string `json:"attachment_ids"`
		EditMessageID    string   `json:"edit_message_id"`
		RetryRunID       string   `json:"retry_run_id"`
		StopCurrent      bool     `json:"stop_current"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	if req.BudgetTokens != nil {
		req.Effort = "budget:" + strconv.Itoa(*req.BudgetTokens)
	}
	if req.ReasoningEnabled != nil {
		req.Effort = "off"
		if *req.ReasoningEnabled {
			req.Effort = "on"
		}
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" && req.RetryRunID == "" {
		if len(req.AttachmentIDs) == 0 {
			writeError(w, http.StatusBadRequest, errors.New("请输入消息"))
			return
		}
		req.Message = "请查看这些附件。"
	}
	returnRun, err := s.startRun(withClientTimezone(r.Context(), r.Header.Get("X-Client-Timezone")), currentUser(r).ID, r.PathValue("id"), req.Message, req.ModelID, req.Effort, req.AttachmentIDs, storage.Revision{EditMessageID: req.EditMessageID, RetryRunID: req.RetryRunID, Priority: req.StopCurrent})
	if err != nil {
		writeStartError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, returnRun)
}
func (s *Server) startQueuedRun(parent context.Context, userID, sessionID, runID, prompt, modelID, effort string, attachmentIDs []string, revision ...storage.Revision) (runtime.Snapshot, error) {
	if s.agent == nil {
		return runtime.Snapshot{}, errors.New("no model runner is configured")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer cancel()
	session, err := s.store.GetSession(ctx, userID, sessionID)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	if len(revision) > 0 && (revision[0].EditMessageID != "" || revision[0].RetryRunID != "") {
		if revision[0].EditMessageID != "" && revision[0].RetryRunID != "" {
			return runtime.Snapshot{}, errors.New("修改和重试不能同时进行")
		}
		last, e := s.store.LastUserMessage(ctx, userID, sessionID, revision[0])
		if e != nil {
			return runtime.Snapshot{}, e
		}
		if revision[0].RetryRunID != "" {
			prompt = last.Content
		}
		if len(attachmentIDs) == 0 {
			var previous []agent.Attachment
			_ = json.Unmarshal(last.Attachments, &previous)
			for _, a := range previous {
				attachmentIDs = append(attachmentIDs, a.ID)
			}
		}
	}
	if modelID == "" {
		modelID = session.ModelID
	}
	if effort == "" && modelID == session.ModelID {
		effort = session.Effort
	}
	var model storage.Model
	var provider storage.Provider
	if _, demo := s.agent.(agent.DemoGenerator); demo {
		model.Name = "演示模式"
	} else {
		model, provider, err = s.selectedModel(ctx, modelID, effort)
		if err != nil {
			return runtime.Snapshot{}, err
		}
	}
	if effort == "" {
		effort = model.DefaultEffort
	}
	attachments, err := s.attachmentsForRun(ctx, userID, sessionID, attachmentIDs)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	if (model.SupportsVision || !model.MetadataKnown["supports_vision"]) && len(attachments) > 0 {
		for i := range attachments {
			attachment := &attachments[i]
			if !strings.HasPrefix(attachment.MIMEType, "image/") {
				continue
			}
			if attachment.Size > 8*1024*1024 {
				return runtime.Snapshot{}, errors.New("图像超过 8 MB，请缩小后上传")
			}
			item, fetchErr := s.store.GetArtifact(ctx, userID, attachment.ID)
			if fetchErr != nil {
				return runtime.Snapshot{}, fetchErr
			}
			data, fetchErr := artifactBytes(item)
			if fetchErr != nil {
				return runtime.Snapshot{}, fetchErr
			}
			attachment.DataURL = "data:" + attachment.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(data)
		}
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	system := settings.SystemPrompt

	if _, demo := s.agent.(agent.DemoGenerator); !demo {
		if err := s.checkHistoryCompatibility(ctx, sessionID, model); err != nil {
			return runtime.Snapshot{}, err
		}
	}
	snapshot, history, err := s.store.CreateConfiguredRun(ctx, userID, sessionID, prompt, runID, model, effort, system, attachments, revision...)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	snapshot.ModelID, snapshot.ModelName, snapshot.Effort = model.ID, model.Name, effort
	scope := agent.RunScope{UserID: userID, SessionID: sessionID, RunID: runID, ProjectID: session.ProjectID, WorkspaceID: userID, CWD: session.WorkspacePath}
	scope.ComputeOnly = !session.ComputerEnabled
	if session.ProjectID != "" {
		if project, projectErr := s.store.Project(ctx, userID, session.ProjectID); projectErr == nil {
			scope.ProjectInstructions = project.Instructions
		}
	}
	config := s.modelConfig(ctx, model, provider, effort, settings)
	config.SystemPrompt, config.Tools, config.MaxToolRounds = system, s.tools, settings.MaxToolRounds
	req := agent.Request{RunID: runID, SessionID: sessionID, UserID: userID, Scope: scope, Attachments: attachments, History: history, Messages: []agent.Message{{Role: "user", Content: prompt}}, Config: config, Timezone: clientTimezone(ctx)}
	// Capture the generation before recall. Reading it afterwards could hide a
	// user deletion between the recall's final guard and execution startup.
	memoryState := s.memoryBoundaryState(ctx, req)
	memoryContext, memoryDiagnostics, memoryErr := s.memoryContextWithDiagnostics(agent.WithRunScope(ctx, scope), userID, session.ProjectID, sessionID, prompt)
	for _, diagnostic := range memoryDiagnostics {
		s.recordRunDiagnostic(runID, diagnostic)
	}
	if memoryErr != nil {
		s.recordRunDiagnostic(runID, agent.Diagnostic{Kind: "memory_recall_degraded", Class: "retrieval", Message: "Related memory was unavailable for this turn; no retrieved fact was assumed."})
	} else {
		config.MemoryContext = memoryContext
	}
	req.AtBoundary = func(ctx context.Context) (agent.BoundaryUpdate, error) {
		return s.runBoundaryWithMemory(ctx, req, memoryState)
	}
	req.Compaction, err = s.store.Compaction(ctx, sessionID)
	if err != nil {
		snapshot.Status = runtime.StatusFailed
		snapshot.Error = "读取上下文失败"
		_ = s.store.CompleteRun(ctx, snapshot)
		return runtime.Snapshot{}, err
	}
	run, e := s.runtime.Start(snapshot, func(run *runtime.Run) { s.execute(run, req) })
	if e != nil {
		snapshot.Status, snapshot.Error = runtime.StatusInterrupted, "服务已停止，请重试"
		snapshot.UpdatedAt = time.Now().UTC()
		_ = s.store.CompleteRun(ctx, snapshot)
		return runtime.Snapshot{}, e
	}
	s.asyncTitle(req)
	return run.Snapshot(), nil
}
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 200
	if q.Get("limit") != "" {
		if n, e := strconv.Atoi(q.Get("limit")); e == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	items, err := s.store.MessagesPage(r.Context(), currentUser(r).ID, r.PathValue("id"), q.Get("before"), limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}
func (s *Server) execute(run *runtime.Run, request agent.Request) {
	defer func() {
		if source, ok := s.tools.(interface{ ForgetSkillsIndex(string, string) }); ok {
			source.ForgetSkillsIndex(request.UserID, request.RunID)
		}
		s.scopePreparations.Delete(request.RunID)
		s.preparedScopes.Delete(request.RunID + ":compute")
		s.preparedScopes.Delete(request.RunID + ":computer")
		s.preparedScopes.Delete(request.RunID + ":last-mode")
		s.resources.releaseRun(request.RunID)
		s.launchQueued(request.SessionID)
	}()
	runContext := agent.WithRunScope(run.Context(), request.Scope)
	request.AskUser = func(ctx context.Context, input agent.WaitingInput) (string, error) {
		s.resources.releaseDesktopRun(request.UserID, request.RunID)
		return run.WaitForInput(ctx, input, func(snapshot runtime.Snapshot) error {
			save, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return s.store.Checkpoint(save, snapshot)
		})
	}
	request.ComputerAllowed = func(ctx context.Context) (bool, error) { return s.computerAllowed(ctx, request.Scope) }
	s.configureRunContext(&request)
	runContext = context.WithValue(runContext, frozenRequestKey{}, request)
	lastCheckpoint := time.Now()
	err := s.agent.Generate(runContext, request, func(update agent.Update) error {
		if update.ResetOutput {
			if err := run.ResetOutput(); err != nil {
				return err
			}
		}
		if update.Text != "" || update.TextKind == "progress" {
			var err error
			switch update.TextKind {
			case "pending":
				err = run.AppendText(update.TextID, update.Text, true)
			case "progress":
				err = run.AppendProgress(update.TextID, update.Text)
			default:
				err = run.AppendText(update.TextID, update.Text, false)
			}
			if err != nil {
				return err
			}
		}
		if update.CommitOutput {
			if err := run.CommitOutput(); err != nil {
				return err
			}
		}
		if update.Reasoning != nil {
			if err := run.AppendReasoning(*update.Reasoning); err != nil {
				return err
			}
		}
		if update.Usage != nil {
			run.AddUsage(*update.Usage)
		}
		if update.Step != nil {
			step := update.Step
			if err := run.UpdateStep(runtime.Step{ID: step.ID, Name: step.Name, Status: step.Status, Arguments: step.Arguments, Output: step.Output, Screenshot: step.Screenshot}); err != nil {
				return err
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if update.Canonical != nil {
			if err := s.store.AppendCanonical(ctx, request.SessionID, request.RunID, update.Canonical); err != nil {
				return err
			}
		}
		if update.Compaction != nil {
			if err := s.store.SaveCompaction(ctx, request.SessionID, *update.Compaction); err != nil {
				return err
			}
		}
		if update.Step != nil || update.Canonical != nil || update.Usage != nil || update.ResetOutput || update.CommitOutput ||
			((update.Text != "" || update.Reasoning != nil) && time.Since(lastCheckpoint) >= time.Second) {
			if err := s.store.Checkpoint(ctx, run.Snapshot()); err != nil {
				return err
			}
			lastCheckpoint = time.Now()
		}
		return nil
	})
	{
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		// Only explicit publication creates a deliverable. Research downloads,
		// helper scripts and later source edits are not implicit publications.
		items, e := s.store.ListRunArtifacts(ctx, request.UserID, request.RunID)
		cancel()
		if e == nil {
			run.SetArtifacts(items)
		} else {
			log.Printf("load run %s published artifacts: %v", request.RunID, e)
		}
	}
	status, message := runtime.StatusCompleted, ""
	if err == nil {
		ctx, cancel := context.WithTimeout(runContext, 10*time.Second)
		if _, checkErr := s.verifyCurrentTask(ctx, request.Scope); checkErr != nil {
			request.Config.Observe(agent.Diagnostic{Kind: "task_verification_unavailable", Class: "verification", Message: "Task acceptance could not be verified; task is not certified complete."})
		}
		cancel()
	}
	if err != nil {
		status, message = runtime.StatusFailed, err.Error()
	}
	if saveErr := run.Finalize(status, message, func(snapshot runtime.Snapshot) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.store.CompleteRun(ctx, snapshot)
	}); saveErr != nil {
		log.Printf("save run %s: %v", request.RunID, saveErr)
	} else {
		s.asyncMemory(request, run.Snapshot())
	}
}

// Every run endpoint checks PostgreSQL ownership before using its live view.
func (s *Server) ownedRun(r *http.Request) (*runtime.Run, error) {
	snapshot, err := s.store.GetRun(r.Context(), currentUser(r).ID, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if live, exists := s.runtime.Get(snapshot.RunID); exists {
		return live, nil
	}
	return s.runtime.Restore(snapshot), nil
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.ownedRun(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run.Snapshot())
}

func (s *Server) runEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming is unavailable"))
		return
	}
	run, err := s.ownedRun(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	snapshot, events, unsubscribe := run.Subscribe()
	defer unsubscribe()
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if err := writeSSE(w, "snapshot", snapshot.Seq, snapshot); err != nil {
		return
	}
	flusher.Flush()
	if runtime.IsTerminal(snapshot.Status) {
		return
	}
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if err := writeSSE(w, event.Type, event.Seq, event); err != nil {
				return
			}
			flusher.Flush()
			if event.Type == "status" && runtime.IsTerminal(event.Status) {
				return
			}
		case <-keepAlive.C:
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.ownedRun(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if run.Snapshot().Status == runtime.StatusQueued {
		if err := s.store.CancelPendingRun(r.Context(), currentUser(r).ID, run.Snapshot().SessionID, run.Snapshot().RunID); err != nil {
			writeStoreError(w, err)
			return
		}
		snapshot, _ := s.store.GetRun(r.Context(), currentUser(r).ID, run.Snapshot().RunID)
		s.runtime.ApplySnapshot(snapshot)
		writeJSON(w, http.StatusAccepted, snapshot)
		return
	}
	if run.Cancel() {
		writeJSON(w, http.StatusAccepted, run.Snapshot())
		return
	}
	writeJSON(w, http.StatusOK, run.Snapshot())
}

func writeSSE(w io.Writer, eventType string, id uint64, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, eventType, data)
	return err
}

func decodeRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, errors.New("expected application/json"))
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid JSON request"))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	if errors.Is(err, storage.ErrActiveRun) {
		writeError(w, http.StatusConflict, storage.ErrActiveRun)
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		writeError(w, http.StatusBadRequest, errors.New("invalid session or run ID"))
		return
	}
	log.Printf("database request failed: %v", err)
	writeError(w, http.StatusInternalServerError, errors.New("could not read or save conversation"))
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	value := hex.EncodeToString(b[:])
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:], nil
}

func (s *Server) resumeRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.ownedRun(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var req struct {
		Answer string `json:"answer"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Answer) == "" {
		writeError(w, http.StatusBadRequest, errors.New("请输入回复"))
		return
	}
	s.permissionMu.Lock()
	defer s.permissionMu.Unlock()
	answer := strings.TrimSpace(req.Answer)
	var grant *bool
	pending := run.Snapshot().WaitingInput
	if pending != nil && pending.Kind == "computer_permission" {
		if answer != "allow_once" && answer != "allow_session" && answer != "deny" {
			writeError(w, http.StatusBadRequest, errors.New("请选择权限选项"))
			return
		}
		allowed := answer != "deny"
		grant = &allowed
		if answer == "allow_session" {
			if _, err = s.store.SetSessionComputer(r.Context(), currentUser(r).ID, run.Snapshot().SessionID, true, false); err != nil {
				writeStoreError(w, err)
				return
			}
		}
	}
	resumed, err := run.ResumeWithGrant(answer, grant, func(snapshot runtime.Snapshot) error { return s.store.Checkpoint(r.Context(), snapshot) })
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !resumed {
		writeError(w, http.StatusConflict, errors.New("当前任务不在等待输入"))
		return
	}
	writeJSON(w, http.StatusAccepted, run.Snapshot())
}

func (s *Server) selectedModel(ctx context.Context, id, effort string) (storage.Model, storage.Provider, error) {
	var model storage.Model
	var err error
	if id != "" {
		model, err = s.store.Model(ctx, id)
	} else {
		var models []storage.Model
		models, err = s.store.Models(ctx, true)
		if len(models) > 0 {
			model = models[0]
		}
	}
	if err != nil {
		return model, storage.Provider{}, err
	}
	if model.ID == "" || !model.Enabled || model.Kind == "embedding" || (model.Source == "remote" && !model.Available) {
		return model, storage.Provider{}, errors.New("请选择可用的模型")
	}
	validEffort := effort == "" || effort == "default"
	if model.EffortParameter != "" && effort != "" {
		validEffort = slices.Contains(model.Efforts, effort)
		if model.ReasoningKind == "budget" && strings.HasPrefix(effort, "budget:") {
			n, e := strconv.Atoi(strings.TrimPrefix(effort, "budget:"))
			validEffort = e == nil && n >= model.ReasoningBudgetMin && (model.ReasoningBudgetMax == 0 || n <= model.ReasoningBudgetMax)
		}
	}
	if !validEffort {
		return model, storage.Provider{}, errors.New("当前模型不支持该思考程度")
	}
	provider, err := s.store.Provider(ctx, model.ProviderID)
	if err != nil {
		return model, provider, err
	}
	if !provider.Enabled || (provider.APIKey == "" && !provider.AllowNoKey) {
		return model, provider, errors.New("当前模型的服务尚未启用")
	}
	return model, provider, nil
}

func (s *Server) startRunForUser(ctx context.Context, userID, sessionID, prompt string) (runtime.Snapshot, error) {
	return s.startRun(ctx, userID, sessionID, prompt, "", "", nil)
}
func writeStartError(w http.ResponseWriter, err error) {
	if errors.Is(err, errComputerPermission) {
		writeError(w, http.StatusForbidden, err)
		return
	}
	if errors.Is(err, storage.ErrActiveRun) || errors.Is(err, pgx.ErrNoRows) {
		writeStoreError(w, err)
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		writeStoreError(w, err)
		return
	}
	writeError(w, http.StatusBadRequest, err)
}

func (s *Server) checkHistoryCompatibility(ctx context.Context, sessionID string, model storage.Model) error {
	if !model.SupportsVision && model.MetadataKnown["supports_vision"] {
		hasImages, err := s.store.HasImages(ctx, sessionID)
		if err != nil {
			return err
		}
		if hasImages {
			return errors.New("此对话包含图像，请选择支持图像的模型，或新建对话")
		}
	}
	if !model.SupportsTools && model.MetadataKnown["supports_tools"] {
		hasTools, err := s.store.HasToolHistory(ctx, sessionID)
		if err != nil {
			return err
		}
		if hasTools {
			return errors.New("此对话包含工具操作，请选择支持工具的模型，或新建对话")
		}
	}
	return nil
}
