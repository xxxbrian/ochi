package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/workspace"
)

type scopedComputerFixture struct {
	jobFixtureTools
	mu       sync.Mutex
	calls    []string
	scopes   []agent.RunScope
	files    map[string][]byte
	bridges  []string
	readFail bool
}

func (f *scopedComputerFixture) ToolResources(name string) []string {
	if strings.HasPrefix(name, "computer_") || strings.HasPrefix(name, "browser_") || name == "exec" {
		return []string{"desktop", "project"}
	}
	if name == "files_write" {
		return []string{"project"}
	}
	return nil
}

func (f *scopedComputerFixture) Call(ctx context.Context, _ string, name string, _ json.RawMessage) (agent.ToolResult, error) {
	scope, _ := agent.ScopeFromContext(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.scopes = append(f.scopes, scope)
	return agent.ToolResult{Output: `{"ok":true,"fresh":"fixture"}`}, nil
}

func (f *scopedComputerFixture) Bridge(ctx context.Context, _ string, method, route string, data []byte) (int, http.Header, []byte, error) {
	scope, _ := agent.ScopeFromContext(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bridges = append(f.bridges, route)
	if route == "/desktop/activate" {
		return http.StatusOK, nil, []byte(`{"activated":true}`), nil
	}
	parsed, _ := url.Parse(route)
	if parsed.Path != "/file" {
		return http.StatusNotFound, nil, nil, nil
	}
	key := scope.ExecutionEnvironment + ":" + parsed.Query().Get("path")
	if method == http.MethodGet {
		if f.readFail {
			return http.StatusBadGateway, nil, []byte(`{"error":"fixture read failed"}`), nil
		}
		data, ok := f.files[key]
		if !ok {
			return http.StatusNotFound, nil, []byte(`{"error":"file not found"}`), nil
		}
		return http.StatusOK, nil, bytes.Clone(data), nil
	}
	if method != http.MethodPut {
		return http.StatusMethodNotAllowed, nil, nil, nil
	}
	_, exists := f.files[key]
	written := !exists || parsed.Query().Get("if_missing") != "1"
	if written {
		f.files[key] = bytes.Clone(data)
	}
	body, _ := json.Marshal(map[string]any{"path": parsed.Query().Get("path"), "written": written})
	return http.StatusCreated, nil, body, nil
}

func setupComputerToolFixture(t *testing.T) (coreHTTPFixture, *scopedComputerFixture, context.Context, agent.RunScope) {
	t.Helper()
	f := newCoreHTTPFixture(t)
	if _, err := f.server.store.SetSessionComputer(context.Background(), f.owner, f.session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	source := &scopedComputerFixture{files: map[string][]byte{}}
	f.server.SetTools(source)
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, CWD: f.session.WorkspacePath, OperationID: "operation"}
	for _, suffix := range []string{":computer", ":compute"} {
		f.server.preparedScopes.Store(scope.RunID+suffix, true)
	}
	return f, source, agent.WithRunScope(context.Background(), scope), scope
}

func TestComputerEnabledOrdinaryToolsUseComputeWithoutDesktopQueue(t *testing.T) {
	f, source, ctx, scope := setupComputerToolFixture(t)
	holder := resourceOwner{UserID: f.owner, SessionID: "other", RunID: "other"}
	if err := f.server.resources.acquire(ctx, "desktop:"+f.owner, holder, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"exec", "job", "files_list", "files_read", "files_write", "web_fetch"} {
		if _, err := f.server.tools.Call(ctx, f.owner, name, json.RawMessage(`{}`)); err != nil {
			t.Fatal(name, err)
		}
	}
	for _, actual := range source.scopes {
		if actual.UserID != scope.UserID || actual.SessionID != scope.SessionID || !actual.ComputeOnly || actual.ExecutionEnvironment != "compute" {
			t.Fatal("ordinary operation used the desktop", actual)
		}
	}
	if state := f.server.resources.DesktopState(f.owner); state["run_id"] != "other" {
		t.Fatal("compute changed another run's desktop lease")
	}
	f.server.resources.releaseRun("other")
}

func TestComputerFreshLeaseDoesNotReplayStaleAction(t *testing.T) {
	for _, name := range []string{"computer_click", "browser_click"} {
		t.Run(name, func(t *testing.T) {
			f, source, ctx, _ := setupComputerToolFixture(t)
			result, err := f.server.tools.Call(ctx, f.owner, name, json.RawMessage(`{"ref":"stale"}`))
			if err != nil || !result.Replan || !strings.Contains(result.Output, `"executed":false`) || !strings.Contains(result.Output, `"status":"acquired"`) {
				t.Fatal(result, err)
			}
			want := strings.Replace(name, "click", "observe", 1)
			if len(source.calls) != 1 || source.calls[0] != want {
				t.Fatalf("old action was dispatched instead of a fresh observation: %v", source.calls)
			}
			// The next model response owns the continuous lease and can act using
			// the observation just returned. No hidden replay is performed.
			result, err = f.server.tools.Call(ctx, f.owner, name, json.RawMessage(`{"ref":"fresh"}`))
			if err != nil || result.Replan || len(source.calls) != 2 || source.calls[1] != name {
				t.Fatal("freshly planned action did not dispatch", result, err)
			}
		})
	}
}

func parkComputerRequest(t *testing.T, s *Server, scope agent.RunScope) *resourceQueueCheckpoint {
	t.Helper()
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	key := "desktop:" + scope.UserID
	checkpoint := make(chan time.Time, 1)
	result := queuedResourceWait(t, s.resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{key}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	paused := resourceResult(t, result)
	if paused.err != nil || paused.admission.Checkpoint == nil {
		t.Fatal(paused)
	}
	return paused.admission.Checkpoint
}

func TestComputerContinueIsNewBlockingWaitWithFreshObservation(t *testing.T) {
	f, source, ctx, scope := setupComputerToolFixture(t)
	if err := f.server.resources.acquire(ctx, "desktop:"+scope.UserID, resourceOwner{UserID: scope.UserID, SessionID: "holder", RunID: "holder"}, nil); err != nil {
		t.Fatal(err)
	}
	paused := parkComputerRequest(t, f.server, scope)
	// Independent computation does not cancel the paused request or acquire it.
	if _, err := f.server.tools.Call(ctx, f.owner, "exec", json.RawMessage(`{"command":"printf fixture"}`)); err != nil {
		t.Fatal(err)
	}
	f.server.resources.releaseRun("holder")
	args, _ := json.Marshal(map[string]any{"action": "wait", "request_id": paused.RequestID})
	result, err := f.server.tools.Call(ctx, f.owner, "computer_queue", args)
	if err != nil || !result.Replan || !strings.Contains(result.Output, `"executed":false`) {
		t.Fatal(result, err)
	}
	if len(source.calls) != 2 || source.calls[0] != "exec" || source.calls[1] != "computer_observe" {
		t.Fatal("continuation replayed the old operation", source.calls)
	}
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	if _, err := f.server.resources.requestKeys(owner, paused.RequestID); !errors.Is(err, errResourceTicketMissing) {
		t.Fatal("granted priority was not consumed")
	}
}

func TestProjectContinuationNeverObservesDesktopWithoutLease(t *testing.T) {
	f, source, ctx, scope := setupComputerToolFixture(t)
	key := "project:/data/projects/fixture"
	if err := f.server.resources.acquire(ctx, key, resourceOwner{UserID: scope.UserID, SessionID: "holder", RunID: "holder"}, nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, f.server.resources, resourceTestContext(t), resourceRequest{
		Owner: resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID},
		Keys:  []string{key}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	paused := resourceResult(t, wait).admission.Checkpoint
	f.server.resources.releaseRun("holder")
	args, _ := json.Marshal(map[string]any{"action": "wait", "request_id": paused.RequestID})
	result, err := f.server.tools.Call(ctx, f.owner, "computer_queue", args)
	if err != nil || !result.Replan || !strings.Contains(result.Output, `"resource":"project"`) {
		t.Fatal(result, err)
	}
	if len(source.calls) != 0 || len(source.bridges) != 0 || f.server.resources.DesktopState(f.owner)["busy"] != false {
		t.Fatal("project-only admission touched the desktop")
	}
}

func TestComputerQueueOwnershipAndPermissionRevocation(t *testing.T) {
	f, _, ctx, scope := setupComputerToolFixture(t)
	if err := f.server.resources.acquire(ctx, "desktop:"+scope.UserID, resourceOwner{UserID: scope.UserID, SessionID: "holder", RunID: "holder"}, nil); err != nil {
		t.Fatal(err)
	}
	paused := parkComputerRequest(t, f.server, scope)
	foreign := scope
	foreign.RunID = "another-run"
	args, _ := json.Marshal(map[string]any{"action": "cancel", "request_id": paused.RequestID})
	if _, err := f.server.tools.Call(agent.WithRunScope(ctx, foreign), f.owner, "computer_queue", args); !errors.Is(err, errResourceTicketOwner) {
		t.Fatal("foreign run cancelled the request", err)
	}
	f.request(t, f.token, http.MethodPatch, "/api/sessions/"+scope.SessionID, `{"computer_enabled":false,"remember_computer_default":false}`, http.StatusOK)
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	if _, err := f.server.resources.requestKeys(owner, paused.RequestID); !errors.Is(err, errResourceTicketMissing) {
		t.Fatal("revocation retained a queued operation")
	}
	if state := f.server.resources.DesktopState(f.owner); state["run_id"] != "holder" {
		t.Fatal("revoking the waiter released the holder")
	}
	if _, err := f.server.tools.Call(ctx, f.owner, "exec", json.RawMessage(`{"environment":"desktop"}`)); !errors.Is(err, errComputerPermission) {
		t.Fatal("revoked desktop access was accepted", err)
	}
	if _, err := f.server.tools.Call(ctx, f.owner, "exec", json.RawMessage(`{}`)); err != nil {
		t.Fatal("revocation disabled independent compute", err)
	}
}

func TestComputerReleaseWaitsForActualDesktopJobs(t *testing.T) {
	f, source, ctx, scope := setupComputerToolFixture(t)
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	if err := f.server.resources.acquire(ctx, "desktop:"+scope.UserID, owner, nil); err != nil {
		t.Fatal(err)
	}
	source.jobs = []workspace.Job{{ID: "active-desktop", UserID: scope.UserID, SessionID: scope.SessionID, ResourceClaims: []string{"desktop"}}}
	result, err := f.server.tools.Call(ctx, f.owner, "computer_release", json.RawMessage(`{}`))
	if err != nil || !strings.Contains(result.Output, `"status":"jobs_running"`) || f.server.resources.DesktopState(f.owner)["busy"] != true {
		t.Fatal("active desktop Job was reported as released", result, err)
	}
	source.jobs = []workspace.Job{{ID: "independent-compute", UserID: scope.UserID, SessionID: scope.SessionID, ResourceClaims: []string{}}}
	result, err = f.server.tools.Call(ctx, f.owner, "computer_release", json.RawMessage(`{}`))
	if err != nil || !result.NotExecuted || !strings.Contains(result.Output, `"status":"released"`) || f.server.resources.DesktopState(f.owner)["busy"] != false {
		t.Fatal("compute Job prevented desktop release", result, err)
	}
}

func TestExplicitFileTransferPreservesTargetsAndExistingDestination(t *testing.T) {
	f, source, ctx, scope := setupComputerToolFixture(t)
	const file = "/data/work/selected.txt"
	source.files["compute:"+file] = []byte("selected compute bytes")
	source.files["desktop:"+file] = []byte("existing desktop bytes")
	for _, overwrite := range []bool{false, true} {
		args := json.RawMessage(fmt.Sprintf(`{"source_environment":"compute","source_path":%q,"destination_environment":"desktop","destination_path":%q,"overwrite":%t}`, file, file, overwrite))
		result, err := f.server.tools.Call(ctx, f.owner, "files_copy", args)
		if err != nil || !strings.Contains(result.Output, fmt.Sprintf(`"written":%t`, overwrite)) {
			t.Fatal(result, err)
		}
		want := "existing desktop bytes"
		if overwrite {
			want = "selected compute bytes"
		}
		if string(source.files["desktop:"+file]) != want || string(source.files["compute:"+file]) != "selected compute bytes" {
			t.Fatal("transfer mixed environments or overwrote an unrequested file")
		}
	}
	for _, route := range source.bridges {
		if !strings.HasPrefix(route, "/file?") {
			t.Fatal("single-file transfer copied a directory or published an artifact", route)
		}
	}
	source.readFail = true
	if _, err := f.server.tools.Call(ctx, f.owner, "files_copy", json.RawMessage(`{"source_environment":"desktop","source_path":"a","destination_environment":"compute","destination_path":"b"}`)); err == nil || source.files["compute:b"] != nil {
		t.Fatal("failed source read wrote the destination")
	}
	if _, err := f.server.store.SetSessionComputer(ctx, scope.UserID, scope.SessionID, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.tools.Call(ctx, f.owner, "files_copy", json.RawMessage(`{"source_environment":"desktop","source_path":"a","destination_environment":"compute","destination_path":"b"}`)); !errors.Is(err, errComputerPermission) {
		t.Fatal("transfer bypassed desktop permission", err)
	}
}
