package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

type deletingWorkspaceFixture struct {
	pluginFixtureTools
	mu       sync.Mutex
	calls    int
	userID   string
	sessions []string
	err      error
	entered  chan struct{}
	release  chan struct{}
}

func (f *deletingWorkspaceFixture) RemoveUser(ctx context.Context, userID string, sessionIDs []string) error {
	f.mu.Lock()
	f.calls++
	f.userID, f.sessions = userID, slices.Clone(sessionIDs)
	err := f.err
	f.mu.Unlock()
	if f.entered != nil {
		close(f.entered)
		select {
		case <-f.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}

func finishDeletionFixtureRun(t *testing.T, f coreHTTPFixture) {
	t.Helper()
	f.run.Status, f.run.Seq, f.run.UpdatedAt = runtime.StatusCompleted, f.run.Seq+1, time.Now().UTC()
	if err := f.server.store.CompleteRun(context.Background(), f.run); err != nil {
		t.Fatal(err)
	}
}

func TestAdminDeleteUserIsPermanentAndCleanupFailureIsRetryable(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	finishDeletionFixtureRun(t, f)
	key, err := storeArtifactBytes(f.owner, "/data/files/owned.txt", []byte("owned artifact"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.store.SaveArtifact(context.Background(), storage.Artifact{UserID: f.owner, SessionID: f.session.ID, Name: "Owned", Path: "/data/files/owned.txt", StorageKey: key}); err != nil {
		t.Fatal(err)
	}
	foreign, err := storeArtifactBytes("core-http-admin", "/data/files/foreign.txt", []byte("foreign artifact"))
	if err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(artifactsRoot(), artifactUserKey(f.owner), ".incomplete-upload")
	if err = os.WriteFile(residue, []byte("unindexed bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	cleaner := &deletingWorkspaceFixture{err: errors.New("fixture container cleanup failure")}
	f.server.SetTools(cleaner)
	path := "/api/admin/users/" + f.owner
	f.request(t, "", http.MethodDelete, path, "", http.StatusUnauthorized)
	f.request(t, f.token, http.MethodDelete, path, "", http.StatusForbidden)
	f.request(t, f.foreign, http.MethodDelete, "/api/admin/users/core-http-admin", "", http.StatusBadRequest)
	f.request(t, f.foreign, http.MethodDelete, path, "", http.StatusBadGateway)
	if _, err = f.server.store.UserByID(context.Background(), f.owner); err != nil {
		t.Fatal("failed external cleanup removed the retryable account")
	}
	if _, err = os.Stat(residue); err != nil {
		t.Fatal("failed workspace preflight removed artifact files")
	}
	f.request(t, f.token, http.MethodGet, "/api/auth/me", "", http.StatusOK)
	cleaner.err = nil
	f.request(t, f.foreign, http.MethodDelete, path, "", http.StatusNoContent)
	if cleaner.calls != 2 || cleaner.userID != f.owner || !slices.Contains(cleaner.sessions, f.session.ID) {
		t.Fatal("cleanup did not target the deleted account's full resource mapping")
	}
	if _, err = f.server.store.UserByID(context.Background(), f.owner); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("DELETE merely disabled the account")
	}
	if _, err = os.Stat(filepath.Join(artifactsRoot(), artifactUserKey(f.owner))); !os.IsNotExist(err) {
		t.Fatal("owned artifact tree or incomplete upload residue remains")
	}
	if _, err = os.Stat(filepath.Join(artifactsRoot(), foreign)); err != nil {
		t.Fatal("account deletion removed another account's artifact")
	}
	if _, ok := f.server.runtime.Get(f.run.RunID); ok {
		t.Fatal("deleted account's runtime projection remains")
	}
	f.request(t, f.token, http.MethodGet, "/api/auth/me", "", http.StatusUnauthorized)
	f.request(t, f.foreign, http.MethodDelete, path, "", http.StatusNotFound)
}

func TestAdminWorkspaceDeletionPreservesAccountConversationAndPublishedFiles(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	finishDeletionFixtureRun(t, f)
	key, err := storeArtifactBytes(f.owner, "/data/files/report.txt", []byte("published"))
	if err != nil {
		t.Fatal(err)
	}
	cleaner := &deletingWorkspaceFixture{}
	f.server.SetTools(cleaner)
	f.request(t, f.foreign, http.MethodDelete, "/api/admin/workspaces/__admin__", "", http.StatusBadRequest)
	if cleaner.calls != 0 {
		t.Fatal("shared plugin control reached destructive cleanup")
	}
	f.request(t, f.foreign, http.MethodDelete, "/api/admin/workspaces/"+f.owner, "", http.StatusNoContent)
	if cleaner.calls != 1 {
		t.Fatal("workspace deletion did not invoke cleanup")
	}
	f.request(t, f.token, http.MethodGet, "/api/auth/me", "", http.StatusOK)
	f.request(t, f.token, http.MethodGet, "/api/sessions/"+f.session.ID, "", http.StatusOK)
	if _, err = os.Stat(filepath.Join(artifactsRoot(), key)); err != nil {
		t.Fatal("workspace reset removed immutable published files")
	}
}

func TestAccountDeletionBlocksNewHTTPExecutionAndMaintenanceAdmissions(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	finishDeletionFixtureRun(t, f)
	cleaner := &deletingWorkspaceFixture{entered: make(chan struct{}), release: make(chan struct{})}
	f.server.SetTools(cleaner)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.request(t, f.foreign, http.MethodDelete, "/api/admin/users/"+f.owner, "", http.StatusNoContent)
	}()
	select {
	case <-cleaner.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("deletion did not enter the controlled cleanup")
	}
	defer func() {
		close(cleaner.release)
		<-done
	}()
	f.request(t, f.token, http.MethodPost, "/api/sessions", `{}`, http.StatusConflict)
	f.request(t, f.foreign, http.MethodPatch, "/api/admin/users/"+f.owner, `{"display_name":"Changed"}`, http.StatusConflict)
	f.request(t, f.foreign, http.MethodPost, "/api/admin/workspaces/"+f.owner+"/start", "", http.StatusConflict)
	f.request(t, "", http.MethodPost, "/api/auth/login", `{"username":"core-http-owner","password":"fixture"}`, http.StatusConflict)
	if _, err := f.server.startRun(context.Background(), f.owner, f.session.ID, "new", "", "", nil); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("new run bypassed account maintenance")
	}
	if _, err := f.server.launchSchedule(context.Background(), f.owner, storage.Schedule{}); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("scheduler bypassed account maintenance")
	}
	if err := f.server.extractMemoryJob(context.Background(), storage.MemoryJob{UserID: f.owner}); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("memory extraction bypassed account maintenance")
	}
	if err := f.server.indexMemoryBatch(context.Background(), storage.MemoryIndexJob{UserID: f.owner}); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("memory indexing bypassed account maintenance")
	}
}

func TestBootstrapDoesNotResurrectDeletedConfiguredAccount(t *testing.T) {
	store := searchIntegrationStore(t)
	ctx := context.Background()
	accounts := []Account{
		{Username: "bootstrap-admin", DisplayName: "Admin", Password: "fixture-admin-password", Role: "admin"},
		{Username: "bootstrap-mistake", DisplayName: "Mistake", Password: "fixture-user-password", Role: "user"},
	}
	if _, err := newAuthentication(store, accounts, false); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteUser(ctx, "bootstrap-admin", "bootstrap-mistake", func(context.Context, []string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	before, err := store.UserByID(ctx, "bootstrap-admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newAuthentication(store, accounts, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UserByID(ctx, "bootstrap-mistake"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("restart resurrected a deleted configured account")
	}
	after, err := store.UserByID(ctx, "bootstrap-admin")
	if err != nil || after.PasswordHash != before.PasswordHash || after.Role != before.Role {
		t.Fatal("restart overwrote an established administrator")
	}
}

func TestWorkspaceMaintenanceDoesNotConsumeDueOnceSchedule(t *testing.T) {
	f := newCoreHTTPFixture(t)
	finishDeletionFixtureRun(t, f)
	at := time.Now().Add(-time.Minute)
	item, err := f.server.newSchedule(context.Background(), f.owner, storage.Schedule{
		Name: "Due once", Prompt: "Fixture only", Enabled: true, Recurrence: "once",
		Timezone: "UTC", OnceAt: &at, NextRunAt: at, ContextMode: "session", SessionID: f.session.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	finish, err := f.server.accounts.maintain(context.Background(), f.owner)
	if err != nil {
		t.Fatal(err)
	}
	f.server.launchDueSchedules(context.Background())
	finish()
	current, err := f.server.store.Schedule(context.Background(), f.owner, item.ID)
	if err != nil || !current.Enabled {
		t.Fatal("maintenance consumed a due once schedule")
	}
	executions, err := f.server.store.ScheduleExecutions(context.Background(), f.owner, item.ID)
	if err != nil || len(executions) != 0 {
		t.Fatal("maintenance left an unowned schedule reservation")
	}
	// With maintenance over, claim normally. A missing runner is recorded as a
	// failed execution instead of leaving a queued reservation until restart.
	f.server.launchDueSchedules(context.Background())
	executions, err = f.server.store.ScheduleExecutions(context.Background(), f.owner, item.ID)
	if err != nil || len(executions) != 1 || executions[0].Status != "failed" {
		t.Fatal("due schedule did not resume normal reservation/failure handling")
	}
}

var _ agent.ToolSource = (*deletingWorkspaceFixture)(nil)
