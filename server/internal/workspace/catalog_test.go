package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"ochi/server/internal/agent"
)

type catalogRoundTripper func(*http.Request) (*http.Response, error)

func (f catalogRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func scopedCatalog(user, run string, compute bool) context.Context {
	return agent.WithRunScope(context.Background(), agent.RunScope{UserID: user, RunID: run, SessionID: "session", ComputeOnly: compute})
}

func discoveredFixture(start, count int) json.RawMessage {
	values := []map[string]any{}
	for i := start; i < start+count; i++ {
		values = append(values, map[string]any{"name": fmt.Sprintf("mcp_fixture_%d", i), "parameters": map[string]any{"type": "object"}, "execution": map[string]bool{"read_only": true, "parallel_safe": true}})
	}
	data, _ := json.Marshal(map[string]any{"tools": values})
	return data
}

func TestCatalogDiscoveryRunScopeAndAtomicAdmission(t *testing.T) {
	d := NewDocker(Config{})
	ctx := scopedCatalog("user", "run", false)
	for _, offset := range []int{0, 6, 12} {
		if _, err := d.recordDiscovery(ctx, "user", discoveredFixture(offset, 6)); err != nil {
			t.Fatal(err)
		}
	}
	if len(d.discovered(ctx, "user")) != 16 || len(d.discovered(scopedCatalog("user", "other-run", false), "user")) != 0 || len(d.discovered(ctx, "other-user")) != 0 || len(d.discovered(scopedCatalog("user", "run", true), "user")) != 0 {
		t.Fatal("catalog limit or run/user/compute scope boundary failed")
	}
	for _, def := range d.discovered(ctx, "user") {
		if def.Execution != nil {
			t.Fatal("untrusted MCP annotations acquired scheduler safety")
		}
	}
	newScope := scopedCatalog("user", "new-run", false)
	bad := json.RawMessage(`{"tools":[{"name":"mcp_valid","parameters":{}},{"name":"exec","parameters":{}}]}`)
	if _, err := d.recordDiscovery(newScope, "user", bad); err == nil || len(d.discovered(newScope, "user")) != 0 {
		t.Fatal("invalid catalog partially admitted tools")
	}
	for i := 0; i < maxRunCatalogs+1; i++ {
		if _, err := d.recordDiscovery(scopedCatalog("user", fmt.Sprintf("many-%d", i), false), "user", discoveredFixture(1, 1)); err != nil {
			t.Fatal(err)
		}
	}
	if len(d.discoveries) > maxRunCatalogs {
		t.Fatal("catalog cache exceeded its run bound")
	}
}

func TestCatalogMetadataNeverProvisionsAndRevocationIsLive(t *testing.T) {
	d := NewDocker(Config{})
	d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Fatal("metadata provisioned a Docker workspace")
		return nil, nil
	})
	available := true
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet {
			t.Fatal("metadata made a non-read request")
		}
		body := `{"skills":[],"total":0,"truncated":false}`
		if strings.HasPrefix(r.URL.Path, "/tools") {
			body = `[]`
			if available {
				body = `[{"name":"mcp_fixture_1","parameters":{}}]`
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})
	ctx := scopedCatalog("user", "run", false)
	base, err := decodeDefinitions(intrinsicTools, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.SkillsIndex(ctx, "user"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.recordDiscovery(ctx, "user", discoveredFixture(1, 1)); err != nil {
		t.Fatal(err)
	}
	defs, err := d.Definitions(ctx, "user")
	if err != nil || len(defs) != len(base)+1 {
		t.Fatalf("intrinsic plus discovered catalog: %d %v", len(defs), err)
	}
	available = false
	defs, err = d.Definitions(ctx, "user")
	if err != nil || len(defs) != len(base) {
		t.Fatal("disabled extension remained in the catalog")
	}
	d.bridge.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) { return nil, errors.New("unavailable") })
	if _, err := d.SkillsIndex(ctx, "user"); err == nil {
		t.Fatal("unavailable metadata was reported as an empty skill list")
	}
	if _, err := d.SkillsIndex(scopedCatalog("user", "run", true), "user"); err == nil {
		t.Fatal("compute read privileged skill metadata")
	}
}

func TestInvalidToolArgsDoNotProvision(t *testing.T) {
	d := NewDocker(Config{})
	d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid arguments provisioned Docker")
		return nil, nil
	})
	_, err := d.Call(scopedCatalog("user", "run", true), "user", "exec", json.RawMessage(`{"command":42}`))
	var classified *agent.ToolArgumentError
	if !errors.As(err, &classified) || classified.Code != "invalid_arguments" {
		t.Fatal("invalid arguments were not classified before dispatch")
	}
	if _, err := d.Call(scopedCatalog("user", "run", true), "user", "skills_read", json.RawMessage(`{"id":"one"}`)); err == nil {
		t.Fatal("compute scope admitted skills")
	}
}

func TestRegistryExecutionAttributesStayPrivateAndConservative(t *testing.T) {
	definitions, err := decodeDefinitions(intrinsicTools, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, def := range definitions {
		if def.Execution == nil {
			t.Fatalf("intrinsic %s has no explicit attributes", def.Name)
		}
		wire, _ := json.Marshal(def)
		if strings.Contains(string(wire), "read_only") || strings.Contains(string(wire), "execution") {
			t.Fatal("scheduler metadata leaked to provider tools JSON")
		}
		if (strings.HasPrefix(def.Name, "browser_") || strings.HasPrefix(def.Name, "computer_") || def.Name == "exec") && def.Execution.ParallelSafe {
			t.Fatal("shared browser/desktop/unknown exec became parallel-safe")
		}
	}
}
