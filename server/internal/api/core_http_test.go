package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

type coreHTTPFixture struct {
	server  *Server
	session storage.Session
	run     runtime.Snapshot
	owner   string
	token   string
	foreign string
}

func newCoreHTTPFixture(t *testing.T) coreHTTPFixture {
	t.Helper()
	store := searchIntegrationStore(t)
	ctx := context.Background()
	for _, user := range []storage.User{{ID: "core-http-owner", Username: "core-http-owner", DisplayName: "Fixture", Role: "user"}, {ID: "core-http-admin", Username: "core-http-admin", DisplayName: "Other", Role: "admin"}} {
		if err := store.BootstrapUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	s, err := NewServer(store, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	s.SetTools(nil)
	f := coreHTTPFixture{server: s, owner: "core-http-owner", token: "fixture-owner-token", foreign: "fixture-admin-token"}
	for token, user := range map[string]string{f.token: f.owner, f.foreign: "core-http-admin"} {
		if err := store.CreateLogin(ctx, tokenHash(token), user, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.BootstrapProvider(ctx, "http://127.0.0.1", "fixture-not-sent", "fixture-model"); err != nil {
		t.Fatal(err)
	}
	models, err := store.Models(ctx, false)
	if err != nil || len(models) != 1 {
		t.Fatal("could not prepare owned model fixture")
	}
	f.session, err = store.CreateSession(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	f.run, _, err = store.CreateConfiguredRun(ctx, f.owner, f.session.ID, "Create a report", "11111111-cccc-4111-8111-111111111111", models[0], "high", agent.SystemPrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.runtime.Restore(f.run)
	return f
}

func (f coreHTTPFixture) request(t *testing.T, token, method, path, body string, want int) []byte {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("%s %s: status %d, want %d", method, path, w.Code, want)
	}
	return w.Body.Bytes()
}

func TestCoreRoutesInstructionLifecycleAndOwnerIsolation(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	path := "/api/runs/" + f.run.RunID + "/instructions"
	for _, body := range []string{`{`, `{"content":"x","client_key":"short"}`, `{"content":" ","client_key":"valid-client-key"}`, `{"content":"x","client_key":"valid-client-key","unexpected":true}`} {
		f.request(t, f.token, http.MethodPost, path, body, http.StatusBadRequest)
	}
	f.request(t, f.token, http.MethodPost, path, fmt.Sprintf(`{"content":%q,"client_key":"valid-client-key"}`, strings.Repeat("x", 32001)), http.StatusBadRequest)
	f.request(t, "", http.MethodGet, path, "", http.StatusUnauthorized)
	f.request(t, f.foreign, http.MethodPost, path, `{"content":"Private","client_key":"valid-client-key"}`, http.StatusNotFound)
	const body = `{"content":"Keep the original scope.","client_key":"durable-client-key"}`
	var initial, repeated storage.RunInstruction
	if json.Unmarshal(f.request(t, f.token, http.MethodPost, path, body, http.StatusAccepted), &initial) != nil || initial.Status != "pending" || initial.ID == "" {
		t.Fatal("accepted input did not expose its durable state")
	}
	_ = json.Unmarshal(f.request(t, f.token, http.MethodPost, path, body, http.StatusAccepted), &repeated)
	if initial.ID != repeated.ID {
		t.Fatal("network retry created a second instruction")
	}
	f.request(t, f.token, http.MethodPost, path, `{"content":"Different","client_key":"durable-client-key"}`, http.StatusConflict)
	if consumed, err := f.server.store.ConsumeInstructions(ctx, f.owner, f.session.ID, f.run.RunID); err != nil || len(consumed) != 1 {
		t.Fatal("safe boundary did not consume exactly once")
	}
	_ = json.Unmarshal(f.request(t, f.token, http.MethodPost, path, body, http.StatusAccepted), &repeated)
	if repeated.Status != "applied" || repeated.CanonicalSeq == nil {
		t.Fatal("idempotent request did not return applied state")
	}
	f.request(t, f.token, http.MethodPost, path, `{"content":"Not applied after cancel.","client_key":"late-client-key"}`, http.StatusAccepted)
	f.run.Status, f.run.Seq, f.run.UpdatedAt = runtime.StatusCancelled, f.run.Seq+1, time.Now().UTC()
	if err := f.server.store.CompleteRun(ctx, f.run); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.token, http.MethodPost, path, `{"content":"New input","client_key":"terminal-client-key"}`, http.StatusConflict)
	var instructions []storage.RunInstruction
	_ = json.Unmarshal(f.request(t, f.token, http.MethodGet, path, "", http.StatusOK), &instructions)
	if len(instructions) != 2 || instructions[0].Status != "applied" || instructions[1].Status != "not_applied" {
		t.Fatal("terminal disposition is dishonest")
	}
	for _, p := range []string{path, "/api/sessions/" + f.session.ID + "/task", "/api/runs/" + f.run.RunID + "/contexts", "/api/runs/" + f.run.RunID + "/contexts/round-1", "/api/runs/" + f.run.RunID + "/diagnostics"} {
		f.request(t, f.foreign, http.MethodGet, p, "", http.StatusNotFound)
	}
}

func TestCoreContextRoutesExposeOnlyOwnedChosenPrompt(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	input := json.RawMessage(`{"model":"fixture","messages":[{"role":"user","content":"owned input"}]}`)
	inspection := boundedInspection(agent.ContextInspection{Round: "round-1", Request: input, SHA256: "original-body-hash", PromptVersion: agent.PromptVersion})
	if err := f.server.store.SaveContextInspection(ctx, f.run.RunID, inspection); err != nil {
		t.Fatal(err)
	}
	base := "/api/runs/" + f.run.RunID
	index := f.request(t, f.token, http.MethodGet, base+"/contexts", "", http.StatusOK)
	var metadata []agent.ContextInspection
	if json.Unmarshal(index, &metadata) != nil || len(metadata) != 1 || string(metadata[0].Request) != "null" || strings.Contains(string(index), "owned input") {
		t.Fatal("context index exposed prompt bytes")
	}
	selected := f.request(t, f.token, http.MethodGet, base+"/contexts/round-1", "", http.StatusOK)
	if !strings.Contains(string(selected), "owned input") || !strings.Contains(string(selected), "original-body-hash") {
		t.Fatal("chosen owned input was not inspectable")
	}
	if err := f.server.store.SaveDiagnostic(ctx, f.run.RunID, agent.Diagnostic{Kind: "fixture", Class: "transient", Message: "Bounded diagnostic."}); err != nil {
		t.Fatal(err)
	}
	if data := f.request(t, f.token, http.MethodGet, base+"/diagnostics", "", http.StatusOK); !strings.Contains(string(data), "Bounded diagnostic.") {
		t.Fatal("owned diagnostic unavailable")
	}
}

func TestParallelComputerRevocationDrainsEveryCallBeforeRelease(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	if _, err := f.server.store.SetSessionComputer(ctx, f.owner, f.session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, CWD: f.session.WorkspacePath}
	a, doneA, err := f.server.computerCallContext(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	b, doneB, err := f.server.computerCallContext(ctx, scope)
	if err != nil {
		doneA()
		t.Fatal(err)
	}
	defer doneA()
	defer doneB()
	owner := resourceOwner{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID}
	if err := f.server.resources.acquire(ctx, "desktop:"+f.owner, owner, nil); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.token, http.MethodPatch, "/api/sessions/"+f.session.ID, `{"computer_enabled":false,"remember_computer_default":false}`, http.StatusOK)
	if !errors.Is(context.Cause(a), errComputerModeChanged) || !errors.Is(context.Cause(b), errComputerModeChanged) {
		t.Fatal("permission revocation missed a parallel call")
	}
	doneA()
	if f.server.resources.DesktopState(f.owner)["busy"] != true {
		t.Fatal("resource released while a dispatched sibling had not drained")
	}
	doneB()
	if f.server.resources.DesktopState(f.owner)["busy"] != false {
		t.Fatal("resource not released after all interrupted calls drained")
	}
	if _, _, err = f.server.computerCallContext(ctx, scope); !errors.Is(err, errComputerModeChanged) {
		t.Fatal("new privileged call entered after revocation")
	}
	live, ok := f.server.runtime.Get(scope.RunID)
	if !ok || !runtime.IsActive(live.Snapshot().Status) {
		t.Fatal("revocation cancelled the entire ordinary run")
	}
}

func TestTaskVerificationUsesActualOwnedBytesAndConversation(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	ctx := context.Background()
	path := "/data/published/fixture/report.txt"
	key, err := storeArtifactBytes(f.owner, path, []byte("actual report bytes"))
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.server.store.SaveArtifact(ctx, storage.Artifact{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, Name: "report.txt", Path: path, MIMEType: "text/plain", Size: int64(len("actual report bytes")), StorageKey: key})
	if err != nil {
		t.Fatal(err)
	}
	state := storage.TaskState{Objective: "Create report", Constraints: []string{"No external send"}, Acceptance: []storage.TaskCriterion{{ID: "file", Kind: "artifact_exists", Target: file.ID}}}
	if _, err = f.server.store.SaveTask(ctx, f.owner, f.session.ID, f.run.RunID, state, 0, false); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID}
	verified, err := f.server.verifyCurrentTask(ctx, scope)
	if err != nil || verified.Status != "complete" || len(verified.Verification) != 1 || !verified.Verification[0].Passed {
		t.Fatal("real published bytes did not satisfy declared existence")
	}
	if err := os.Remove(filepath.Join(artifactsRoot(), key)); err != nil {
		t.Fatal(err)
	}
	verified, err = f.server.verifyCurrentTask(ctx, scope)
	if err != nil || verified.Status != "active" || verified.Verification[0].Passed {
		t.Fatal("metadata without actual bytes certified a task")
	}
	other, err := f.server.store.CreateSession(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	otherRun, _, err := f.server.store.CreateConfiguredRun(ctx, f.owner, other.ID, "Separate task", "22222222-cccc-4222-8222-222222222222", storage.Model{ID: f.run.ModelID, Name: f.run.ModelName}, "", agent.SystemPrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	scope.RunID = otherRun.RunID
	if _, err := f.server.verifyCurrentTask(ctx, scope); err == nil {
		t.Fatal("another conversation's run supplied task evidence")
	}
}

func TestTaskArtifactFilenameChecksLatestVersionNotOlderSuccess(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	ctx := context.Background()
	versions := make([]storage.Artifact, 0, 2)
	for _, version := range []string{"first", "latest"} {
		path := "/data/published/fixture/" + version + "/report.txt"
		key, err := storeArtifactBytes(f.owner, path, []byte(version))
		if err != nil {
			t.Fatal(err)
		}
		file, err := f.server.store.SaveArtifact(ctx, storage.Artifact{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, Name: "report.txt", Path: path, MIMEType: "text/plain", Size: int64(len(version)), StorageKey: key})
		if err != nil {
			t.Fatal(err)
		}
		versions = append(versions, file)
	}
	state := storage.TaskState{Objective: "Create report", Acceptance: []storage.TaskCriterion{{ID: "latest", Kind: "artifact_exists", Target: "report.txt"}, {ID: "specific", Kind: "artifact_exists", Target: versions[0].ID}}}
	if _, err := f.server.store.SaveTask(ctx, f.owner, f.session.ID, f.run.RunID, state, 0, false); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID}
	verified, err := f.server.verifyCurrentTask(ctx, scope)
	if err != nil || !verified.Verification[0].Passed || !strings.Contains(verified.Verification[0].Detail, versions[1].ID) || !verified.Verification[1].Passed {
		t.Fatal("filename did not select latest immutable version or exact ID was lost")
	}
	if err := os.Remove(filepath.Join(artifactsRoot(), versions[1].StorageKey)); err != nil {
		t.Fatal(err)
	}
	verified, err = f.server.verifyCurrentTask(ctx, scope)
	if err != nil || verified.Status != "active" || verified.Verification[0].Passed || !verified.Verification[1].Passed {
		t.Fatal("old immutable bytes hid the missing latest deliverable")
	}
}
