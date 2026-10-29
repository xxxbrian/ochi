package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"path"
	"strings"
	"sync"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/workspace"
)

type resourceOwner struct {
	RunID     string `json:"run_id,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	UserID    string `json:"user_id,omitempty"`
	ControlID string `json:"-"`
	Manual    bool   `json:"control"`
}

type resourceManager struct {
	mu      sync.Mutex
	owners  map[string]resourceOwner
	changed chan struct{}
}

func newResourceManager() *resourceManager {
	return &resourceManager{owners: map[string]resourceOwner{}, changed: make(chan struct{})}
}
func (r *resourceManager) notify() { close(r.changed); r.changed = make(chan struct{}) }

var errComputerModeChanged = errors.New("computer permission changed while waiting")

func (r *resourceManager) wake() { r.mu.Lock(); r.notify(); r.mu.Unlock() }

func (r *resourceManager) acquire(ctx context.Context, key string, owner resourceOwner, onWait func(bool), guards ...func() error) error {
	waiting := false
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(guards) > 0 {
			if err := guards[0](); err != nil {
				if waiting && onWait != nil {
					onWait(false)
				}
				return err
			}
		}
		r.mu.Lock()
		current, busy := r.owners[key]
		if !busy || (!owner.Manual && !current.Manual && current.RunID == owner.RunID) {
			r.owners[key] = owner
			r.mu.Unlock()
			if waiting && onWait != nil {
				onWait(false)
			}
			return nil
		}
		if current.Manual && owner.Manual && current.ControlID == owner.ControlID {
			r.mu.Unlock()
			return nil
		}
		changed := r.changed
		r.mu.Unlock()
		if len(guards) > 0 {
			if err := guards[0](); err != nil {
				if waiting && onWait != nil {
					onWait(false)
				}
				return err
			}
		}
		if !waiting && onWait != nil {
			onWait(true)
		}
		waiting = true
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

func (r *resourceManager) releaseRun(runID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := false
	for key, owner := range r.owners {
		if !owner.Manual && owner.RunID == runID {
			delete(r.owners, key)
			changed = true
		}
	}
	if changed {
		r.notify()
	}
}
func (r *resourceManager) releaseDesktopRun(userID, runID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := "desktop:" + userID
	if owner, ok := r.owners[key]; ok && !owner.Manual && owner.RunID == runID {
		delete(r.owners, key)
		r.notify()
	}
}

func (r *resourceManager) DesktopState(userID string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	owner, busy := r.owners["desktop:"+userID]
	return map[string]any{"busy": busy, "run_id": owner.RunID, "session_id": owner.SessionID, "control": owner.Manual, "manual": owner.Manual, "owner_run_id": owner.RunID, "owner_session_id": owner.SessionID}
}
func (r *resourceManager) AcquireDesktopControl(ctx context.Context, userID, sessionID string) error {
	return r.acquire(ctx, "desktop:"+userID, resourceOwner{UserID: userID, SessionID: sessionID, ControlID: desktopControlID(sessionID), Manual: true}, nil)
}
func (r *resourceManager) ReleaseDesktopControl(userID, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := "desktop:" + userID
	if owner, ok := r.owners[key]; ok && owner.Manual && owner.ControlID == desktopControlID(sessionID) {
		delete(r.owners, key)
		r.notify()
	}
}

func desktopControlID(sessionID string) string {
	if sessionID == "" {
		return "global"
	}
	return "session:" + sessionID
}

func (s *Server) DesktopState(userID string) map[string]any {
	state := s.resources.DesktopState(userID)
	if state["busy"] == true {
		return state
	}
	if source := s.workspaceJobs(); source != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		jobs, err := source.ActiveJobs(ctx, userID)
		if err != nil {
			state["busy"], state["unavailable"] = true, true
		} else {
			for _, job := range jobs {
				if hasClaim(job.ResourceClaims, "desktop") {
					state["busy"], state["job_id"] = true, job.ID
					state["run_id"], state["session_id"] = job.RunID, job.SessionID
					state["owner_run_id"], state["owner_session_id"] = job.RunID, job.SessionID
					break
				}
			}
		}
	}
	return state
}
func (s *Server) AcquireDesktopControl(ctx context.Context, userID, sessionID string) error {
	if err := s.resources.AcquireDesktopControl(ctx, userID, sessionID); err != nil {
		return err
	}
	scope := agent.RunScope{UserID: userID, SessionID: sessionID}
	if err := s.waitForJobClaims(ctx, scope, []string{"desktop"}, true, nil); err != nil {
		s.resources.ReleaseDesktopControl(userID, sessionID)
		return err
	}
	return nil
}
func (s *Server) ReleaseDesktopControl(userID, sessionID string) {
	s.resources.ReleaseDesktopControl(userID, sessionID)
}

func hasClaim(claims []string, claim string) bool {
	for _, value := range claims {
		if value == claim {
			return true
		}
	}
	return false
}

type workspaceJobSource interface {
	ActiveJobs(context.Context, string) ([]workspace.Job, error)
	FinishRun(context.Context, agent.RunScope, bool) error
	CancelSessionJobs(context.Context, string, string) error
}

func (s *Server) workspaceJobs() workspaceJobSource {
	source := s.tools
	if wrapped, ok := source.(*personalTools); ok {
		source = wrapped.source
	}
	jobs, _ := source.(workspaceJobSource)
	return jobs
}

func (s *Server) toolClaims(name string) []string {
	source := s.tools
	if wrapped, ok := source.(*personalTools); ok {
		source = wrapped.source
	}
	if source, ok := source.(interface{ ToolResources(string) []string }); ok {
		return source.ToolResources(name)
	}
	return nil
}

func jobConflicts(job workspace.Job, scope agent.RunScope, claims []string, manual bool) bool {
	// Services remain owned by their conversation; a later turn can inspect,
	// cancel or work alongside its own service. Other conversations and manual
	// desktop takeover must wait for the actual process, not just its old run.
	if !manual && job.SessionID == scope.SessionID && job.UserID == scope.UserID {
		return false
	}
	project := projectResource(scope.CWD)
	return hasClaim(claims, "desktop") && hasClaim(job.ResourceClaims, "desktop") ||
		hasClaim(claims, "project") && project != "" &&
			projectResource(job.CWD) == project && hasClaim(job.ResourceClaims, "project")
}

func projectResource(cwd string) string {
	const prefix = "/data/projects/"
	clean := path.Clean(cwd)
	if !strings.HasPrefix(clean, prefix) {
		return ""
	}
	return prefix + strings.SplitN(strings.TrimPrefix(clean, prefix), "/", 2)[0]
}

func (s *Server) finishWorkspaceRun(scope agent.RunScope, status string) {
	if source := s.workspaceJobs(); source != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := source.FinishRun(ctx, scope, status != runtime.StatusCompleted); err != nil {
			log.Printf("finish workspace run %s: %v", scope.RunID, err)
		}
	}
}

func (s *Server) cancelSessionJobs(ctx context.Context, userID, sessionID string) error {
	if source := s.workspaceJobs(); source != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		return source.CancelSessionJobs(cleanup, userID, sessionID)
	}
	return nil
}

func (s *Server) waitForJobClaims(ctx context.Context, scope agent.RunScope, claims []string, manual bool, onWait func(bool)) error {
	source := s.workspaceJobs()
	if source == nil || len(claims) == 0 || scope.ComputeOnly {
		return nil
	}
	waiting := false
	defer func() {
		if waiting && onWait != nil {
			onWait(false)
		}
	}()
	for {
		query, cancel := context.WithTimeout(ctx, 2*time.Second)
		jobs, err := source.ActiveJobs(query, scope.UserID)
		cancel()
		if err != nil {
			return err
		}
		busy := false
		for _, job := range jobs {
			busy = busy || jobConflicts(job, scope, claims, manual)
		}
		if !busy {
			return nil
		}
		if !waiting && onWait != nil {
			onWait(true)
		}
		waiting = true
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *Server) acquireToolResources(ctx context.Context, scope agent.RunScope, name string, args json.RawMessage) error {
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	wait := func(key string) func(bool) {
		return func(waiting bool) {
			if run, ok := s.runtime.Get(scope.RunID); ok {
				if waiting {
					run.SetResource(key)
				} else {
					run.SetResource("")
				}
				save, cancel := context.WithTimeout(context.Background(), checkpointTimeout)
				defer cancel()
				_ = s.store.Checkpoint(save, run.Snapshot())
			}
		}
	}
	claims := s.toolClaims(name)
	if scope.ComputeOnly {
		return nil
	}
	headed := hasClaim(claims, "desktop")
	guard := func() error {
		allowed, err := s.computerAllowed(ctx, scope)
		if err != nil {
			return err
		}
		if !allowed {
			return errComputerModeChanged
		}
		return nil
	}
	if project := projectResource(scope.CWD); project != "" && hasClaim(claims, "project") {
		key := "project:" + project
		if err := s.resources.acquire(ctx, key, owner, wait(key), guard); err != nil {
			return err
		}
	}
	activate := false
	if headed {
		key := "desktop:" + scope.UserID
		state := s.resources.DesktopState(scope.UserID)
		wasOwned := state["run_id"] == scope.RunID && !state["manual"].(bool)
		if err := s.resources.acquire(ctx, key, owner, wait(key), guard); err != nil {
			return err
		}
		activate = !wasOwned && strings.HasPrefix(name, "computer_")
	}
	if err := s.waitForJobClaims(ctx, scope, claims, false, wait("workspace_job")); err != nil {
		return err
	}
	if activate {
		return s.activateDesktop(ctx, scope)
	}
	return nil
}
