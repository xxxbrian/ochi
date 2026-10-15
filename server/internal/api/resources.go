package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"ochi/server/internal/agent"
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

func (s *Server) DesktopState(userID string) map[string]any { return s.resources.DesktopState(userID) }
func (s *Server) AcquireDesktopControl(ctx context.Context, userID, sessionID string) error {
	return s.resources.AcquireDesktopControl(ctx, userID, sessionID)
}
func (s *Server) ReleaseDesktopControl(userID, sessionID string) {
	s.resources.ReleaseDesktopControl(userID, sessionID)
}

func projectSideEffect(name string, args json.RawMessage) bool {
	switch name {
	case "files_read", "files_list", "skills_list", "skills_read", "browser_observe", "browser_screenshot", "browser_tabs", "computer_screenshot", "memory_search", "schedule_list", "publish_file":
		return false
	case "web_fetch":
		var v struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(args, &v)
		return v.Path != ""
	}
	// Arbitrary shell and MCP operations cannot be reliably classified as read-only.
	return name == "exec" || name == "files_write" || len(name) >= 8 && name[:8] == "browser_" || len(name) >= 4 && name[:4] == "mcp_"
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
	headed := strings.HasPrefix(name, "browser_") || strings.HasPrefix(name, "computer_")
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
	if !scope.ComputeOnly && (scope.ProjectID != "" || strings.HasPrefix(scope.CWD, "/data/projects/")) && (projectSideEffect(name, args) || headed) {
		key := "project:" + scope.CWD
		if err := s.resources.acquire(ctx, key, owner, wait(key), guard); err != nil {
			return err
		}
	}
	if headed {
		key := "desktop:" + scope.UserID
		state := s.resources.DesktopState(scope.UserID)
		wasOwned := state["run_id"] == scope.RunID && !state["manual"].(bool)
		if err := s.resources.acquire(ctx, key, owner, wait(key), guard); err != nil {
			return err
		}
		if !wasOwned && strings.HasPrefix(name, "computer_") {
			if err := s.activateDesktop(ctx, scope); err != nil {
				return err
			}
		}
	}
	return nil
}
