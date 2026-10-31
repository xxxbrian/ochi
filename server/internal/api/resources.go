package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"path"
	"strings"
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

var errComputerModeChanged = errors.New("computer permission changed while waiting")

func (r *resourceManager) releaseRun(runID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := false
	for _, ticket := range r.tickets {
		if !ticket.owner.Manual && ticket.owner.RunID == runID {
			delete(r.tickets, ticket.id)
			ticket.ready = false
			changed = true
		}
	}
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

func (r *resourceManager) releaseRunLeases(runID string) {
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
	scope := agent.RunScope{UserID: userID, SessionID: sessionID}
	_, err := s.resources.wait(ctx, resourceRequest{
		Owner: resourceOwner{UserID: userID, SessionID: sessionID, ControlID: desktopControlID(sessionID), Manual: true},
		Keys:  []string{"desktop:" + userID}, NoCheckpoint: true,
		Available: func(ctx context.Context) (bool, error) {
			return s.jobClaimsAvailable(ctx, scope, []string{"desktop"}, true)
		},
	}, nil)
	return err
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
	// An active process can still mutate the desktop, including within its own
	// conversation. Job observation and cancellation do not claim the desktop.
	if hasClaim(claims, "desktop") && hasClaim(job.ResourceClaims, "desktop") {
		return true
	}
	// Project services remain usable by later turns in their own conversation.
	if !manual && job.SessionID == scope.SessionID && job.UserID == scope.UserID {
		return false
	}
	project := projectResource(scope.CWD)
	return hasClaim(claims, "project") && project != "" &&
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

func (s *Server) cancelComputerJobs(ctx context.Context, userID, sessionID string) error {
	source, ok := s.workspaceJobs().(interface {
		CancelComputerJobs(context.Context, string, string) error
	})
	if !ok {
		return nil
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return source.CancelComputerJobs(cleanup, userID, sessionID)
}

func (s *Server) jobClaimsAvailable(ctx context.Context, scope agent.RunScope, claims []string, manual bool) (bool, error) {
	source := s.workspaceJobs()
	if source == nil || len(claims) == 0 || scope.ComputeOnly {
		return true, nil
	}
	query, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	jobs, err := source.ActiveJobs(query, scope.UserID)
	if err != nil {
		return false, err
	}
	for _, job := range jobs {
		if jobConflicts(job, scope, claims, manual) {
			return false, nil
		}
	}
	return true, nil
}

func (s *Server) acquireToolResources(ctx context.Context, scope agent.RunScope, name string, args json.RawMessage) (resourceAdmission, error) {
	claims := s.toolClaims(name)
	if scope.ComputeOnly {
		return resourceAdmission{}, nil
	}
	keys := []string{}
	if project := projectResource(scope.CWD); project != "" && hasClaim(claims, "project") {
		keys = append(keys, "project:"+project)
	}
	if hasClaim(claims, "desktop") {
		keys = append(keys, "desktop:"+scope.UserID)
	}
	if len(keys) == 0 {
		return resourceAdmission{}, nil
	}
	return s.waitToolResources(ctx, scope, resourceRequest{Keys: keys})
}

func (s *Server) continueToolResources(ctx context.Context, scope agent.RunScope, requestID string, waitDuration time.Duration) (resourceAdmission, error) {
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	keys, err := s.resources.requestKeys(owner, requestID)
	if err != nil {
		return resourceAdmission{}, err
	}
	return s.waitToolResources(ctx, scope, resourceRequest{Keys: keys, RequestID: requestID, CheckpointDuration: waitDuration})
}

func (s *Server) waitToolResources(ctx context.Context, scope agent.RunScope, request resourceRequest) (resourceAdmission, error) {
	request.Owner = resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
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
	claims := []string{}
	for _, key := range request.Keys {
		if strings.HasPrefix(key, "desktop:") {
			claims = append(claims, "desktop")
		} else if strings.HasPrefix(key, "project:") {
			claims = append(claims, "project")
		}
	}
	request.Guard = guard
	request.Available = func(ctx context.Context) (bool, error) {
		return s.jobClaimsAvailable(ctx, scope, claims, false)
	}
	request.OnState = func(state resourceQueueCheckpoint) { s.resourceQueueProgress(scope, state) }
	wait := func(waiting bool) {
		if run, ok := s.runtime.Get(scope.RunID); ok {
			if waiting {
				run.SetResource(strings.Join(request.Keys, ","))
			} else {
				run.SetResource("")
			}
			save, cancel := context.WithTimeout(context.Background(), checkpointTimeout)
			defer cancel()
			_ = s.store.Checkpoint(save, run.Snapshot())
		}
	}
	admission, err := s.resources.wait(ctx, request, wait)
	admission.Fresh = hasClaim(admission.Acquired, "desktop:"+scope.UserID)
	return admission, err
}
