package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"ochi/server/internal/agent"
)

func TestControlTransportSeparatesSecretMountAndPreservesCallerPolicy(t *testing.T) {
	d := NewDocker(Config{})
	controlName := userContainer("__admin__")
	var generatedToken string
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		switch r.Method + " " + r.URL.RequestURI() {
		case "GET /v1.44/containers/" + controlName + "/json":
			return workspaceResponse(http.StatusNotFound, `{}`), nil
		case "POST /v1.44/containers/create?name=" + controlName:
			var input struct {
				User       string
				Env        []string
				HostConfig struct {
					Mounts []struct {
						Source, Target string
						ReadOnly       bool
					}
				}
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.User != "root" || len(input.HostConfig.Mounts) != 3 {
				t.Fatalf("invalid control identity/mounts: %+v", input.HostConfig)
			}
			for _, env := range input.Env {
				if value, ok := strings.CutPrefix(env, "OCHI_BRIDGE_TOKEN="); ok {
					generatedToken = value
				}
			}
			if len(generatedToken) != 64 {
				t.Fatal("missing high-entropy private RPC token")
			}
			private := input.HostConfig.Mounts[2]
			if private.Source != "ochi-plugin-control" || private.Target != "/var/lib/ochi-control" {
				t.Fatal("private configuration not isolated")
			}
			return workspaceResponse(http.StatusCreated, `{}`), nil
		case "POST /v1.44/containers/" + controlName + "/start":
			return workspaceResponse(http.StatusOK, `{}`), nil
		default:
			t.Fatalf("unexpected Docker request: %s %s", r.Method, r.URL.Path)
			return nil, nil
		}
	})
	ctx := agent.WithExtensionAccess(scopedCatalog("alice", "run-a", false), agent.ExtensionAccess{MCP: []string{"fixture"}})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != controlName+":8080" {
			t.Fatal("MCP execution used the user workspace")
		}
		if r.URL.Path == "/health" {
			return workspaceResponse(http.StatusOK, fixtureHealth("control")), nil
		}
		if r.URL.Path != "/tools/tool_search" || r.Header.Get("Authorization") != "Bearer "+generatedToken {
			t.Fatal("control dispatch missing authentication")
		}
		var scope agent.RunScope
		if err := json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &scope); err != nil || scope.UserID != "alice" {
			t.Fatal("control dispatch lost caller identity")
		}
		if r.Header.Get("X-Ochi-Extensions") != `{"skills":[],"mcp":["fixture"]}` {
			t.Fatal("control dispatch lost effective plugin policy")
		}
		return workspaceResponse(http.StatusOK, `{"ok":true,"result":{"tools":[],"matched":0,"truncated":false}}`), nil
	})
	if _, err := d.Call(ctx, "alice", "tool_search", json.RawMessage(`{"query":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceContractMismatchFailsWithoutReadinessRetry(t *testing.T) {
	d := NewDocker(Config{})
	d.urls["alice"] = "http://" + userContainer("alice") + ":8080"
	calls := 0
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls++
		return workspaceResponse(http.StatusOK, `{"status":"ok"}`), nil
	})
	d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Fatal("contract mismatch must not provision or restart")
		return nil, nil
	})
	started := time.Now()
	_, err := d.ensure(context.Background(), "alice")
	if !errors.Is(err, ErrContractMismatch) || calls != 1 || time.Since(started) > time.Second {
		t.Fatalf("mismatch was retried: calls=%d err=%v", calls, err)
	}
}

func TestPrivateBridgeTokenIsRestoredOnlyThroughDockerControl(t *testing.T) {
	d := NewDocker(Config{})
	if err := d.rememberBridgeToken("alice", []string{"OCHI_BRIDGE_TOKEN=" + fixtureToken}); err != nil {
		t.Fatal(err)
	}
	if err := d.rememberBridgeToken("bob", []string{"OTHER=value"}); !errors.Is(err, ErrContractMismatch) {
		t.Fatal("existing unauthenticated bridge was accepted")
	}
	request, _ := http.NewRequest(http.MethodPost, "http://bridge/tools/exec", io.NopCloser(strings.NewReader("{}")))
	d.setBridgeAuth(request, "alice")
	if request.Header.Get("Authorization") != "Bearer "+fixtureToken {
		t.Fatal("Alice token missing")
	}
	d.setBridgeAuth(request, "bob")
	if request.Header.Get("Authorization") == "Bearer "+fixtureToken {
		t.Fatal("workspace token crossed user boundary")
	}
}
