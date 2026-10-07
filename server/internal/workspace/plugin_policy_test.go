package workspace

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"ochi/server/internal/agent"
)

func TestPluginPolicyPropagatesToMetadataAndRevokesCachedMCP(t *testing.T) {
	d := NewDocker(Config{})
	d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Fatal("revoked plugin provisioned a workspace")
		return nil, nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet {
			t.Fatal("revoked plugin was dispatched")
		}
		var access agent.ExtensionAccess
		if err := json.Unmarshal([]byte(r.Header.Get("X-Ochi-Extensions")), &access); err != nil {
			t.Fatalf("plugin policy missing from metadata request: %v", err)
		}
		body := `[]`
		if reflect.DeepEqual(access.MCP, []string{"fixture"}) {
			body = `[{"name":"mcp_fixture_1","parameters":{}}]`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})
	ctx := scopedCatalog("alice", "run-a", false)
	if _, err := d.recordDiscovery(ctx, "alice", discoveredFixture(1, 1)); err != nil {
		t.Fatal(err)
	}
	ctx = agent.WithExtensionAccess(ctx, agent.ExtensionAccess{MCP: []string{"fixture"}})
	allowed := d.extensionDefinitions(ctx, "alice")
	if len(allowed) != 1 {
		t.Fatal("enabled plugin not returned")
	}
	ctx = agent.WithExtensionAccess(ctx, agent.ExtensionAccess{})
	if len(d.extensionDefinitions(ctx, "alice")) != 0 {
		t.Fatal("cached tool survived plugin revocation")
	}
	if _, err := d.Call(ctx, "alice", "mcp_fixture_1", json.RawMessage(`{}`)); err == nil {
		t.Fatal("known disabled tool could still be called")
	}
	if _, err := d.Call(ctx, "alice", "skills_read", json.RawMessage(`{"id":"secret"}`)); err == nil {
		t.Fatal("disabled skill could be read")
	}
	if _, err := d.Call(scopedCatalog("alice", "run-a", false), "alice", "tool_search", json.RawMessage(`{"query":"search"}`)); err == nil {
		t.Fatal("unresolved policy admitted an extension call")
	}
}

func TestPluginPolicyEmptyAccessIsExplicit(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "http://bridge/tools", nil)
	ctx := agent.WithExtensionAccess(scopedCatalog("alice", "run-a", false), agent.ExtensionAccess{})
	setScopeHeaders(req, ctx)
	if req.Header.Get("X-Ochi-Extensions") != `{"skills":[],"mcp":[]}` {
		t.Fatalf("empty policy omitted or ambiguous: %s", req.Header.Get("X-Ochi-Extensions"))
	}
}
