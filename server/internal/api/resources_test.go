package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/workspace"
)

func TestResourceWaitCancellationAndRunRelease(t *testing.T) {
	resources := newResourceManager()
	first := resourceOwner{RunID: "first", UserID: "user", SessionID: "a"}
	second := resourceOwner{RunID: "second", UserID: "user", SessionID: "b"}
	key := "project:/data/projects/shared"
	if err := resources.acquire(context.Background(), key, first, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	waited := false
	if err := resources.acquire(ctx, key, second, func(waiting bool) { waited = waiting }); !errors.Is(err, context.DeadlineExceeded) || !waited {
		t.Fatalf("waiting cancellation: %v %v", err, waited)
	}
	if err := resources.acquire(context.Background(), "project:/data/projects/other", second, nil); err != nil {
		t.Fatal(err)
	}
	resources.releaseRun(first.RunID)
	if err := resources.acquire(context.Background(), key, second, nil); err != nil {
		t.Fatal(err)
	}
	resources.releaseRun(second.RunID)
	if err := resources.AcquireDesktopControl(context.Background(), "user", "a"); err != nil {
		t.Fatal(err)
	}
	if state := resources.DesktopState("user"); state["control"] != true || state["session_id"] != "a" {
		t.Fatal(state)
	}
	resources.releaseRun(first.RunID)
	if state := resources.DesktopState("user"); state["control"] != true {
		t.Fatal("run cleanup released manual control")
	}
	resources.ReleaseDesktopControl("user", "a")
	if state := resources.DesktopState("user"); state["busy"] != false {
		t.Fatal(state)
	}
}

type jobFixtureTools struct {
	jobs           []workspace.Job
	finished       []agent.RunScope
	cancelServices []bool
	cancelled      []agent.RunScope
}

func (*jobFixtureTools) Definitions(context.Context, string) ([]agent.ToolDefinition, error) {
	return nil, nil
}
func (*jobFixtureTools) Call(context.Context, string, string, json.RawMessage) (agent.ToolResult, error) {
	return agent.ToolResult{}, nil
}
func (f *jobFixtureTools) ActiveJobs(context.Context, string) ([]workspace.Job, error) {
	return f.jobs, nil
}
func (f *jobFixtureTools) FinishRun(ctx context.Context, scope agent.RunScope, services bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.finished = append(f.finished, scope)
	f.cancelServices = append(f.cancelServices, services)
	return nil
}
func (f *jobFixtureTools) CancelSessionJobs(ctx context.Context, userID, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.cancelled = append(f.cancelled, agent.RunScope{UserID: userID, SessionID: sessionID})
	return nil
}

func TestRunJobCleanupPreservesOnlyExplicitCompletedServices(t *testing.T) {
	tools := &jobFixtureTools{}
	s := &Server{tools: tools}
	scope := agent.RunScope{UserID: "owner", SessionID: "session", RunID: "run"}
	statuses := []string{runtime.StatusCompleted, runtime.StatusFailed, runtime.StatusCancelled, runtime.StatusInterrupted, runtime.StatusRunning}
	for _, status := range statuses {
		s.finishWorkspaceRun(scope, status)
	}
	for i, actual := range tools.finished {
		if actual != scope || tools.cancelServices[i] != (statuses[i] != runtime.StatusCompleted) {
			t.Fatalf("incorrect cleanup scope or service lifetime for %s", statuses[i])
		}
	}
}

func TestJobRoutesRevokeAndDeleteClearPersistentSessionServices(t *testing.T) {
	f := newCoreHTTPFixture(t)
	tools := &jobFixtureTools{}
	f.server.SetTools(tools)
	path := "/api/sessions/" + f.session.ID
	f.request(t, f.foreign, http.MethodPatch, path, `{"computer_enabled":false}`, http.StatusNotFound)
	if len(tools.cancelled) != 0 {
		t.Fatal("foreign account cancelled workspace services")
	}
	f.request(t, f.token, http.MethodPatch, path, `{"computer_enabled":false,"remember_computer_default":false}`, http.StatusOK)
	if len(tools.cancelled) != 1 || tools.cancelled[0].UserID != f.owner || tools.cancelled[0].SessionID != f.session.ID {
		t.Fatal("permission revoke left prior-turn services running")
	}
	f.request(t, f.token, http.MethodDelete, path, "", http.StatusConflict)
	if len(tools.cancelled) != 1 {
		t.Fatal("rejected active-session deletion mutated jobs")
	}
	f.run.Status = runtime.StatusCompleted
	if err := f.server.store.CompleteRun(context.Background(), f.run); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.token, http.MethodDelete, path, "", http.StatusNoContent)
	if len(tools.cancelled) != 2 || tools.cancelled[1] != tools.cancelled[0] {
		t.Fatal("conversation deletion did not clear its service scope")
	}
}

func TestJobClaimsOutliveRunAndRespectScope(t *testing.T) {
	service := workspace.Job{ID: "service", UserID: "owner", SessionID: "origin", RunID: "completed-run", CWD: "/data/projects/shared", ResourceClaims: []string{"desktop", "project"}}
	for _, test := range []struct {
		name   string
		scope  agent.RunScope
		claims []string
		manual bool
		want   bool
	}{
		{"other conversation desktop", agent.RunScope{UserID: "owner", SessionID: "other"}, []string{"desktop"}, false, true},
		{"new turn in owner conversation", agent.RunScope{UserID: "owner", SessionID: "origin", RunID: "new"}, []string{"desktop"}, false, false},
		{"manual takeover still conflicts", agent.RunScope{UserID: "owner", SessionID: "origin"}, []string{"desktop"}, true, true},
		{"same project", agent.RunScope{UserID: "owner", SessionID: "other", CWD: "/data/projects/shared"}, []string{"project"}, false, true},
		{"project child directory", agent.RunScope{UserID: "owner", SessionID: "other", CWD: "/data/projects/shared/src/nested"}, []string{"project"}, false, true},
		{"unrelated project", agent.RunScope{UserID: "owner", SessionID: "other", CWD: "/data/projects/different"}, []string{"project"}, false, false},
		{"job observation has no claims", agent.RunScope{UserID: "owner", SessionID: "other"}, nil, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := jobConflicts(service, test.scope, test.claims, test.manual); got != test.want {
				t.Fatalf("conflict=%v want %v", got, test.want)
			}
		})
	}
}
