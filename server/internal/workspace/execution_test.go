package workspace

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"ochi/server/internal/agent"
)

func TestOrdinaryToolsChooseExplicitContainers(t *testing.T) {
	for _, tool := range []struct {
		name string
		args string
	}{
		{"exec", `{"command":"printf fixture"}`},
		{"job", `{"job_id":"0123456789abcdef0123456789abcdef","action":"status"}`},
		{"files_list", `{}`},
		{"files_read", `{"path":"result.txt"}`},
		{"files_write", `{"path":"result.txt","content":"fixture"}`},
		{"web_fetch", `{"url":"https://example.invalid/"}`},
	} {
		for _, environment := range []string{"", "compute", "desktop"} {
			t.Run(tool.name+"/"+environment, func(t *testing.T) {
				d := NewDocker(Config{})
				wantEnv, mode := environment, "compute"
				if wantEnv == "" {
					wantEnv = "compute"
				}
				target := computeContainer("owner", "session")
				if wantEnv == "desktop" {
					target, mode = userContainer("owner"), "workspace"
				}
				args := tool.args
				if environment != "" {
					var input map[string]any
					_ = json.Unmarshal([]byte(args), &input)
					input["environment"] = environment
					raw, _ := json.Marshal(input)
					args = string(raw)
				}
				d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
					if r.Method != http.MethodGet || r.URL.Path != "/v1.44/containers/"+target+"/json" {
						t.Fatalf("wrong execution target or unexpected provisioning: %s %s", r.Method, r.URL.Path)
					}
					return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
				})
				d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
					if r.URL.Host != target+":8080" {
						t.Fatalf("execution crossed container boundary: %s", r.URL.Host)
					}
					if r.URL.Path == "/health" {
						return workspaceResponse(http.StatusOK, fixtureHealth(mode)), nil
					}
					if r.URL.Path != "/tools/"+tool.name || r.Header.Get("Authorization") != "Bearer "+fixtureToken {
						t.Fatalf("incorrect tool dispatch: %s", r.URL.Path)
					}
					var scope agent.RunScope
					if err := json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &scope); err != nil {
						t.Fatal(err)
					}
					if scope.ExecutionEnvironment != wantEnv || scope.ComputeOnly != (wantEnv == "compute") ||
						scope.UserID != "owner" || scope.SessionID != "session" || scope.CWD != "/data/work/session" {
						t.Fatalf("target scope drifted: %+v", scope)
					}
					return workspaceResponse(http.StatusOK, `{"ok":true,"result":{"status":"completed"}}`), nil
				})
				// Computer permission is enabled, but ordinary commands still default
				// to isolated compute. Opening the desktop is always explicit.
				ctx := agent.WithRunScope(context.Background(), agent.RunScope{
					UserID: "owner", SessionID: "session", RunID: "run", CWD: "/data/work/session",
				})
				if _, err := d.Call(ctx, "owner", tool.name, json.RawMessage(args)); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestExecutionTargetRejectsPermissionAndPreparedScopeDrift(t *testing.T) {
	for _, test := range []struct {
		name        string
		scope       agent.RunScope
		environment string
		error       string
	}{
		{"computer off", agent.RunScope{SessionID: "session", ComputeOnly: true}, "desktop", "permission"},
		{"prepared compute", agent.RunScope{SessionID: "session", ComputeOnly: true, ExecutionEnvironment: "compute"}, "desktop", "prepared scope"},
		{"prepared desktop", agent.RunScope{SessionID: "session", ExecutionEnvironment: "desktop"}, "", "prepared scope"},
		{"missing session", agent.RunScope{}, "", "conversation scope"},
	} {
		t.Run(test.name, func(t *testing.T) {
			args, _ := json.Marshal(map[string]any{"environment": test.environment})
			ctx := agent.WithRunScope(context.Background(), test.scope)
			if _, err := executionContext(ctx, "exec", args); err == nil || !strings.Contains(err.Error(), test.error) {
				t.Fatalf("expected %s: %v", test.error, err)
			}
		})
	}
	ctx := agent.WithRunScope(context.Background(), agent.RunScope{SessionID: "session"})
	got, err := executionContext(ctx, "browser_observe", json.RawMessage(`{}`))
	if err != nil || got != ctx {
		t.Fatal("non-computation tools changed their existing workspace routing")
	}
}
