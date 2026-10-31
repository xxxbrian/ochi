package workspace

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"ochi/server/internal/agent"
)

func TestIdleComputeKeepsLiveReferencesAndVolumes(t *testing.T) {
	for _, test := range []struct {
		name        string
		activity    string
		localActive int
		lastUse     time.Time
		wantStop    bool
	}{
		{name: "idle", activity: `{"jobs":[],"active_calls":0,"idle_seconds":900}`, wantStop: true},
		{name: "background service", activity: `{"jobs":[{"job_id":"service","kind":"service"}],"active_calls":0,"idle_seconds":900}`},
		{name: "bridge request", activity: `{"jobs":[],"active_calls":1,"idle_seconds":900}`},
		{name: "recent bridge activity", activity: `{"jobs":[],"active_calls":0,"idle_seconds":3}`},
		{name: "attachment gap", localActive: 1},
		{name: "recent local use", lastUse: time.Now()},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := NewDocker(Config{})
			name := computeContainer("owner", "session")
			d.active = map[string]int{name: test.localActive}
			d.lastUse = map[string]time.Time{name: test.lastUse}
			stops := 0
			d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				switch r.Method + " " + r.URL.Path {
				case "GET /v1.44/containers/" + name + "/json":
					return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
				case "POST /v1.44/containers/" + name + "/stop":
					stops++
					return workspaceResponse(http.StatusNoContent, ``), nil
				default:
					t.Errorf("unexpected lifecycle mutation (must preserve container and data): %s %s", r.Method, r.URL.Path)
					return workspaceResponse(http.StatusBadRequest, `{}`), nil
				}
			})
			d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Authorization") != "Bearer "+fixtureToken || r.URL.Path != "/jobs/active" {
					t.Errorf("unexpected or unauthenticated activity probe: %s", r.URL.Path)
				}
				return workspaceResponse(http.StatusOK, `{"ok":true,"result":`+test.activity+`}`), nil
			})
			if err := d.stopIdleContainer(context.Background(), name, 10*time.Minute); err != nil {
				t.Fatal(err)
			}
			if (stops == 1) != test.wantStop {
				t.Fatalf("stop count=%d wantStop=%v", stops, test.wantStop)
			}
		})
	}
}

func TestJobLifecycleRecoversOwnersWithoutProvisioning(t *testing.T) {
	d := NewDocker(Config{})
	workspaceName := userContainer("owner")
	computeName := computeContainer("owner", "session")
	var requests []string
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/json") {
			t.Fatalf("job cleanup must not provision: %s %s", r.Method, r.URL.Path)
		}
		if strings.Contains(r.URL.Path, computeName) {
			return workspaceResponse(http.StatusNotFound, `{}`), nil
		}
		return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer "+fixtureToken || r.URL.Host != workspaceName+":8080" {
			t.Error("missing recovered bridge authentication")
		}
		requests = append(requests, r.URL.Path)
		if r.URL.Path == "/jobs/active" {
			return workspaceResponse(http.StatusOK, `{"ok":true,"result":{"jobs":[{"job_id":"durable-service","user_id":"owner","session_id":"session","run_id":"old-run","resource_claims":["desktop"]}],"active_calls":0,"idle_seconds":0}}`), nil
		}
		var scope agent.RunScope
		if err := json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &scope); err != nil || scope.UserID != "owner" || scope.SessionID != "session" || scope.OperationID != "" {
			t.Errorf("incorrect lifecycle scope: %+v %v", scope, err)
		}
		var body struct {
			CancelServices bool `json:"cancel_services"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if r.URL.Path == "/runs/finish" && !body.CancelServices {
			t.Error("cancellation retained owned services")
		}
		return workspaceResponse(http.StatusOK, `{"ok":true,"result":{}}`), nil
	})
	jobs, err := d.ActiveJobs(context.Background(), "owner")
	if err != nil || len(jobs) != 1 || jobs[0].ID != "durable-service" {
		t.Fatalf("restart recovery: %+v %v", jobs, err)
	}
	if err := d.FinishRun(context.Background(), agent.RunScope{UserID: "owner", SessionID: "session", RunID: "old-run", OperationID: "stale"}, true); err != nil {
		t.Fatal(err)
	}
	if err := d.CancelSessionJobs(context.Background(), "owner", "session"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(requests, ",") != "/jobs/active,/runs/finish,/jobs/cancel-session" {
		t.Fatal(requests)
	}
}

func TestJobActivityRequiresEveryLivenessField(t *testing.T) {
	for _, body := range []string{
		`{"jobs":[],"idle_seconds":900}`,
		`{"jobs":[],"active_calls":0}`,
		`{"active_calls":0,"idle_seconds":900}`,
		`{"jobs":null,"active_calls":0,"idle_seconds":900}`,
	} {
		d := NewDocker(Config{})
		d.bridge.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
			return workspaceResponse(http.StatusOK, `{"ok":true,"result":`+body+`}`), nil
		})
		if _, err := d.jobActivity(context.Background(), "fixture", "http://fixture"); err == nil {
			t.Fatalf("incomplete activity could stop a live workspace: %s", body)
		}
	}
}

func TestSessionCleanupCancelsBothTargetsWithoutStartingContainers(t *testing.T) {
	d := NewDocker(Config{})
	desktop := userContainer("owner")
	compute := computeContainer("owner", "session")
	var targets []string
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || (r.URL.Path != "/v1.44/containers/"+desktop+"/json" &&
			r.URL.Path != "/v1.44/containers/"+compute+"/json") {
			t.Fatalf("cleanup provisioned a container: %s %s", r.Method, r.URL.Path)
		}
		return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		var scope agent.RunScope
		if err := json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &scope); err != nil {
			t.Fatal(err)
		}
		wantEnv := "desktop"
		if r.URL.Host == compute+":8080" {
			wantEnv = "compute"
		}
		if r.URL.Path != "/jobs/cancel-session" || scope.ExecutionEnvironment != wantEnv ||
			scope.ComputeOnly != (wantEnv == "compute") || scope.SessionID != "session" ||
			r.Header.Get("Authorization") != "Bearer "+fixtureToken {
			t.Fatalf("cleanup lost target or ownership: %s %+v", r.URL, scope)
		}
		targets = append(targets, wantEnv)
		return workspaceResponse(http.StatusOK, `{"ok":true,"result":{}}`), nil
	})
	if err := d.CancelSessionJobs(context.Background(), "owner", "session"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(targets, ",") != "desktop,compute" {
		t.Fatal(targets)
	}
	targets = nil
	if err := d.CancelComputerJobs(context.Background(), "owner", "session"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(targets, ",") != "desktop" {
		t.Fatalf("Computer revocation cancelled isolated computation: %v", targets)
	}
}

func TestWorkspaceMaintenanceDoesNotInterruptBorrowedRequests(t *testing.T) {
	d := NewDocker(Config{})
	d.active = map[string]int{"__admin__": 1}
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		t.Fatalf("maintenance reached Docker during an active bridge request: %s", r.URL.Path)
		return nil, nil
	})
	for _, action := range []string{"stop", "rebuild"} {
		if _, err := d.Manage(context.Background(), "__admin__", action); err == nil {
			t.Fatalf("%s allowed during MCP test/Skill install", action)
		}
	}
}
