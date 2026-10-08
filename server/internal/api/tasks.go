package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func taskToolDefinitions() []agent.ToolDefinition {
	return []agent.ToolDefinition{
		{Name: "task_read", Description: "Read the task record spanning this conversation's turns: objective, constraints, progress, acceptance and actual check evidence. Use for long tasks when needed, not as a mandatory opening.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`), Execution: &agent.ToolExecution{ReadOnly: true, ParallelSafe: true, RetrySafe: true}},
		{Name: "task_update", Description: "Persist a complex user-requested task's objective, constraints, done, remaining and deterministic acceptance checks across context compaction. Read before updating; expected_revision is 0 for a new record. Only use new_task when the user actually starts a different task. Never invent extra deliverables. Cannot self-assert verification or completion. command/test targets are exact exec command strings; artifact target is a published ID for that exact version or a filename for the latest version in this run; file target is an in-scope path.", Parameters: json.RawMessage(`{"type":"object","properties":{"objective":{"type":"string","minLength":1,"maxLength":3000},"constraints":{"type":"array","maxItems":24,"items":{"type":"string","maxLength":1000}},"done":{"type":"array","maxItems":24,"items":{"type":"string","maxLength":1000}},"remaining":{"type":"array","maxItems":24,"items":{"type":"string","maxLength":1000}},"acceptance":{"type":"array","maxItems":16,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":80},"kind":{"type":"string","enum":["artifact_exists","file_exists","command_success","test_success"]},"target":{"type":"string","minLength":1,"maxLength":3000}},"required":["id","kind","target"],"additionalProperties":false}},"expected_revision":{"type":"integer","minimum":0},"new_task":{"type":"boolean"}},"required":["objective","constraints","done","remaining","acceptance","expected_revision"],"additionalProperties":false}`)},
		{Name: "task_verify", Description: "Check declared task acceptance against real published bytes, in-scope files and recorded successful command/test results. It never executes a command just to check a claim. Task completion requires no remaining items and all declared checks passed. Evidence checks do not replace semantic or visual quality review.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
	}
}

func (s *Server) taskTool(ctx context.Context, userID, name string, raw json.RawMessage) (agent.ToolResult, error) {
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.UserID != userID || scope.SessionID == "" || scope.RunID == "" {
		return agent.ToolResult{}, errors.New("task tools require an owned active conversation")
	}
	var v any
	var err error
	switch name {
	case "task_read":
		v, err = s.store.Task(ctx, userID, scope.SessionID)
	case "task_update":
		var input struct {
			Objective        string                  `json:"objective"`
			Constraints      []string                `json:"constraints"`
			Done             []string                `json:"done"`
			Remaining        []string                `json:"remaining"`
			Acceptance       []storage.TaskCriterion `json:"acceptance"`
			ExpectedRevision int64                   `json:"expected_revision"`
			NewTask          bool                    `json:"new_task"`
		}
		if err = json.Unmarshal(raw, &input); err == nil {
			v, err = s.store.SaveTask(ctx, userID, scope.SessionID, scope.RunID, storage.TaskState{Objective: input.Objective, Constraints: input.Constraints, Done: input.Done, Remaining: input.Remaining, Acceptance: input.Acceptance}, input.ExpectedRevision, input.NewTask)
		}
	case "task_verify":
		v, err = s.verifyCurrentTask(ctx, scope)
	default:
		return agent.ToolResult{}, errors.New("unknown task tool")
	}
	if err != nil {
		return agent.ToolResult{}, err
	}
	data, err := json.Marshal(v)
	return agent.ToolResult{Output: string(data)}, err
}

func commandEvidence(criterion storage.TaskCriterion, snapshot runtime.Snapshot) storage.TaskEvidence {
	v := storage.TaskEvidence{ID: criterion.ID, Source: "recorded_exec", RunID: snapshot.RunID, CheckedAt: time.Now().UTC(), Detail: "No matching command was observed in this run."}
	for _, step := range snapshot.Steps {
		var args struct {
			Command string `json:"command"`
		}
		var output struct {
			ExitCode *int   `json:"exit_code"`
			TimedOut bool   `json:"timed_out"`
			IsError  bool   `json:"isError"`
			Error    string `json:"error"`
		}
		if step.Name != "exec" || json.Unmarshal(step.Arguments, &args) != nil || args.Command != criterion.Target {
			continue
		}
		// Steps retain dispatch order. A later failed or unfinished recheck must
		// invalidate earlier success rather than certify outdated work.
		v.Passed, v.Detail = false, "Latest matching tool call "+step.ID+" has no recorded successful exit."
		if json.Unmarshal([]byte(step.Output), &output) == nil && step.Status == "completed" && output.ExitCode != nil && *output.ExitCode == 0 && !output.TimedOut && !output.IsError && output.Error == "" {
			v.Passed, v.Detail = true, "Latest matching tool call "+step.ID+" exited successfully."
		}
	}
	return v
}

func (s *Server) verifyCurrentTask(ctx context.Context, scope agent.RunScope) (*storage.TaskState, error) {
	task, err := s.store.Task(ctx, scope.UserID, scope.SessionID)
	if err != nil || task == nil {
		return task, err
	}
	snapshot, err := s.store.GetRun(ctx, scope.UserID, scope.RunID)
	if err != nil {
		return nil, err
	}
	if snapshot.SessionID != scope.SessionID {
		return nil, errors.New("task evidence must belong to the current conversation")
	}
	if live, ok := s.runtime.Get(scope.RunID); ok {
		snapshot = live.Snapshot()
	}
	artifacts, err := s.store.ListRunArtifacts(ctx, scope.UserID, scope.RunID)
	if err != nil {
		return nil, err
	}
	proof := make([]storage.TaskEvidence, 0, len(task.Acceptance))
	for _, c := range task.Acceptance {
		v := storage.TaskEvidence{ID: c.ID, RunID: scope.RunID, CheckedAt: time.Now().UTC(), Detail: "Required evidence is unavailable."}
		switch c.Kind {
		case "command_success", "test_success":
			v = commandEvidence(c, snapshot)
		case "artifact_exists":
			v.Source = "immutable_artifact_store"
			selected := -1
			for index, file := range artifacts {
				if file.ID == c.Target {
					selected = index
					break
				}
				if file.Name == c.Target {
					// The store lists versions oldest first. A filename means the
					// latest deliverable; an ID deliberately checks that version.
					selected = index
				}
			}
			if selected < 0 {
				break
			}
			stored, readErr := s.store.GetArtifact(ctx, scope.UserID, artifacts[selected].ID)
			if readErr != nil || stored.StorageKey == "" {
				break
			}
			clean := filepath.Clean(stored.StorageKey)
			if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
				break
			}
			info, statErr := os.Stat(filepath.Join(artifactsRoot(), clean))
			if statErr == nil && info.Mode().IsRegular() && info.Size() == stored.Size {
				v.Passed, v.Detail = true, "Published file "+stored.ID+" exists with its recorded byte size."
			}
		case "file_exists":
			v.Source = "scoped_files_list"
			target := path.Clean(c.Target)
			if !path.IsAbs(target) {
				target = path.Join(scope.CWD, target)
			}
			if target == scope.CWD || !strings.HasPrefix(target, strings.TrimRight(scope.CWD, "/")+"/") {
				v.Detail = "File check is outside this conversation's working directory."
				break
			}
			args, _ := json.Marshal(map[string]any{"path": path.Dir(target), "max_entries": 500})
			result, readErr := s.tools.Call(ctx, scope.UserID, "files_list", args)
			if readErr != nil {
				break
			}
			var listing struct {
				IsError bool   `json:"isError"`
				Error   string `json:"error"`
				Entries []struct {
					Path string `json:"path"`
					Type string `json:"type"`
				} `json:"entries"`
			}
			if json.Unmarshal([]byte(result.Output), &listing) == nil && !listing.IsError && listing.Error == "" {
				for _, file := range listing.Entries {
					if path.Clean(file.Path) == target && file.Type == "file" {
						v.Passed, v.Detail = true, "A regular file was observed at "+target+"."
					}
				}
			}
		}
		proof = append(proof, v)
	}
	return s.store.VerifyTask(ctx, scope.UserID, scope.SessionID, task.Revision, proof)
}

func taskContext(v *storage.TaskState) string {
	if v == nil {
		return ""
	}
	data, _ := json.Marshal(v)
	return string(data)
}

func (s *Server) runBoundary(ctx context.Context, request agent.Request) (agent.BoundaryUpdate, error) {
	return s.runBoundaryWithMemory(ctx, request, nil)
}

func (s *Server) runBoundaryWithMemory(ctx context.Context, request agent.Request, state *memoryBoundaryState) (agent.BoundaryUpdate, error) {
	if err := ctx.Err(); err != nil {
		return agent.BoundaryUpdate{}, err
	}
	messages, err := s.store.ConsumeInstructions(ctx, request.UserID, request.SessionID, request.RunID)
	if err != nil {
		return agent.BoundaryUpdate{}, err
	}
	task, err := s.store.Task(ctx, request.UserID, request.SessionID)
	if err != nil {
		return agent.BoundaryUpdate{}, err
	}
	update := agent.BoundaryUpdate{Messages: messages, TaskContext: taskContext(task)}
	if index, ok := s.tools.(interface {
		SkillsIndex(context.Context, string) (string, error)
	}); ok {
		update.SkillsIndex, err = index.SkillsIndex(ctx, request.UserID)
		if err != nil {
			if request.Config != nil && request.Config.Observe != nil {
				request.Config.Observe(agent.Diagnostic{Kind: "skills_index_unavailable", Class: "metadata", Message: "Some skill metadata was unavailable; no inference about installed skills was made."})
			}
		}
	}
	if len(messages) > 0 {
		var prompt strings.Builder
		for _, m := range messages {
			var v agent.Message
			_ = json.Unmarshal(m.Payload, &v)
			prompt.WriteString(v.Content + "\n")
		}
		if state != nil {
			*state = *s.memoryBoundaryState(ctx, request)
		}
		memory, diagnostics, e := s.memoryContextWithDiagnostics(ctx, request.UserID, request.Scope.ProjectID, request.SessionID, prompt.String())
		if request.Config != nil && request.Config.Observe != nil {
			for _, diagnostic := range diagnostics {
				request.Config.Observe(diagnostic)
			}
		}
		if e == nil {
			update.MemoryContext = &memory
		} else {
			empty := ""
			update.MemoryContext = &empty
			if request.Config != nil && request.Config.Observe != nil {
				request.Config.Observe(agent.Diagnostic{Kind: "memory_recall_degraded", Class: "retrieval", Message: "Supplemental input could not refresh related memory."})
			}
		}
	} else if state != nil {
		update.MemoryContext = s.refreshBoundaryMemory(ctx, request, state)
	}
	return update, nil
}

func (s *Server) registerTaskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{id}/task", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Task(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}))
	mux.HandleFunc("GET /api/runs/{id}/instructions", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Instructions(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}))
	mux.HandleFunc("POST /api/runs/{id}/instructions", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Content   string `json:"content"`
			ClientKey string `json:"client_key"`
		}
		if !decodeRequest(w, r, &input) {
			return
		}
		v, err := s.store.AcceptInstruction(r.Context(), currentUser(r).ID, r.PathValue("id"), input.ClientKey, input.Content)
		if errors.Is(err, storage.ErrInstructionInvalid) {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if errors.Is(err, storage.ErrRunNotSteerable) || errors.Is(err, storage.ErrInstructionConflict) || errors.Is(err, storage.ErrInstructionLimit) {
			writeError(w, http.StatusConflict, err)
			return
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, v)
	}))
}
