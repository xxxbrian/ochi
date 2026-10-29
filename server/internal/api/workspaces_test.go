package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ochi/server/internal/runtime"
	"ochi/server/internal/workspace"
)

type managedWorkspaceFixture struct {
	pluginFixtureTools
	actions []string
}

func (f *managedWorkspaceFixture) Inspect(_ context.Context, userID string) (workspace.State, error) {
	kind := "workspace"
	if userID == "__admin__" {
		kind = "control"
	}
	return workspace.State{UserID: userID, Kind: kind, State: "not_created"}, nil
}

func (f *managedWorkspaceFixture) Manage(ctx context.Context, userID, action string) (workspace.State, error) {
	f.actions = append(f.actions, userID+":"+action)
	return f.Inspect(ctx, userID)
}

func TestSystemWorkspaceHasAdminMaintenanceAndGlobalRunGuard(t *testing.T) {
	f := newCoreHTTPFixture(t)
	manager := &managedWorkspaceFixture{}
	f.server.SetTools(manager)
	path := "/api/admin/workspaces"
	f.request(t, "", http.MethodGet, path, "", http.StatusUnauthorized)
	f.request(t, f.token, http.MethodGet, path, "", http.StatusForbidden)
	f.request(t, f.token, http.MethodPost, path+"/__admin__/rebuild", "", http.StatusForbidden)
	raw := f.request(t, f.foreign, http.MethodGet, path, "", http.StatusOK)
	var items []workspace.State
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 || items[0].UserID != "__admin__" || items[0].Kind != "control" {
		t.Fatalf("shared plugin executor absent from maintenance: %s", raw)
	}
	if len(manager.actions) != 0 || manager.bridgeReads != 0 {
		t.Fatal("listing workspaces provisioned or modified a container")
	}
	for _, action := range []string{"stop", "rebuild"} {
		f.request(t, f.foreign, http.MethodPost, path+"/__admin__/"+action, "", http.StatusConflict)
	}
	if len(manager.actions) != 0 {
		t.Fatal("control workspace was modified during another user's active run")
	}
	f.run.Status, f.run.Seq, f.run.UpdatedAt = runtime.StatusCompleted, f.run.Seq+1, time.Now().UTC()
	if err := f.server.store.CompleteRun(context.Background(), f.run); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.foreign, http.MethodPost, path+"/__admin__/rebuild", "", http.StatusOK)
	if len(manager.actions) != 1 || manager.actions[0] != "__admin__:rebuild" {
		t.Fatal("administrator could not maintain the idle control workspace")
	}
}
