package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

type pluginFixtureTools struct {
	mu          sync.Mutex
	unavailable bool
	bridgeReads int
}

func (p *pluginFixtureTools) metadata(kind string) (json.RawMessage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.unavailable {
		return nil, errors.New("controlled metadata failure")
	}
	if kind == "skills" {
		return json.RawMessage(`[{"id":"alpha","name":"Alpha skill","description":"Fixture method","enabled":true,"content":"SECRET_SKILL_BODY"}]`), nil
	}
	return json.RawMessage(`[{"id":"docs","name":"Docs MCP","enabled":true,"env":{"KEY":"SECRET_MCP_KEY"}}]`), nil
}

func (p *pluginFixtureTools) Bridge(_ context.Context, userID, method, path string, _ []byte) (int, http.Header, []byte, error) {
	p.mu.Lock()
	p.bridgeReads++
	p.mu.Unlock()
	if userID != "__admin__" || method != http.MethodGet || !strings.HasPrefix(path, "/extensions/") {
		return http.StatusBadRequest, nil, nil, errors.New("unexpected fixture bridge operation")
	}
	kind := strings.TrimPrefix(path, "/extensions/")
	raw, err := p.metadata(kind)
	if err != nil {
		return http.StatusServiceUnavailable, nil, nil, err
	}
	return http.StatusOK, nil, append(append([]byte(`{"`+kind+`":`), raw...), '}'), nil
}

func (p *pluginFixtureTools) Definitions(ctx context.Context, _ string) ([]agent.ToolDefinition, error) {
	access, _ := agent.ExtensionAccessFromContext(ctx)
	values := []agent.ToolDefinition{}
	if slices.Contains(access.MCP, "docs") {
		values = append(values, agent.ToolDefinition{Name: "mcp_docs_ping", Parameters: json.RawMessage(`{"type":"object","properties":{}}`)})
	}
	return values, nil
}

func (p *pluginFixtureTools) SkillsIndex(ctx context.Context, _ string) (string, error) {
	access, _ := agent.ExtensionAccessFromContext(ctx)
	if slices.Contains(access.Skills, "alpha") {
		return `{"skills":[{"id":"alpha","name":"Alpha skill","description":"Fixture method"}],"total":1,"truncated":false}`, nil
	}
	return `{"skills":[],"total":0,"truncated":false}`, nil
}

func (p *pluginFixtureTools) Call(ctx context.Context, _, name string, _ json.RawMessage) (agent.ToolResult, error) {
	access, ok := agent.ExtensionAccessFromContext(ctx)
	if !ok || name != "mcp_docs_ping" || !slices.Contains(access.MCP, "docs") {
		return agent.ToolResult{}, errors.New("plugin is unavailable")
	}
	return agent.ToolResult{Output: "pong"}, nil
}

func TestPluginsHTTPPolicyAndLiveRuntime(t *testing.T) {
	store := searchIntegrationStore(t)
	s, err := NewServer(store, nil, []Account{
		{Username: "plugins-admin", Password: "fixture-admin-password", Role: "admin"},
		{Username: "plugins-one", Password: "fixture-user-password", Role: "user"},
		{Username: "plugins-two", Password: "fixture-user-password", Role: "user"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	source := &pluginFixtureTools{unavailable: true}
	s.SetTools(source)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	api := httptest.NewServer(s.Handler())
	t.Cleanup(api.Close)
	request := func(token, method, path string, body any, want int) []byte {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, api.URL+path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := api.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		if response.StatusCode != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, response.StatusCode, want, data)
		}
		for _, secret := range []string{"SECRET_MCP_KEY", "SECRET_SKILL_BODY"} {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatal("public plugin response exposed component secrets")
			}
		}
		return data
	}
	login := func(username, password string) (string, string) {
		t.Helper()
		raw := request("", http.MethodPost, "/api/auth/login", map[string]any{"username": username, "password": password, "native": true}, http.StatusOK)
		var response struct {
			storage.User
			AccessToken string `json:"access_token"`
		}
		if json.Unmarshal(raw, &response) != nil || response.AccessToken == "" || response.User.ID == "" {
			t.Fatal("fixture login failed")
		}
		return response.AccessToken, response.User.ID
	}
	admin, _ := login("plugins-admin", "fixture-admin-password")
	one, userID := login("plugins-one", "fixture-user-password")
	two, _ := login("plugins-two", "fixture-user-password")
	request("", http.MethodGet, "/api/plugins", nil, http.StatusUnauthorized)
	request(one, http.MethodGet, "/api/admin/plugins", nil, http.StatusForbidden)
	request(one, http.MethodGet, "/api/admin/plugins/components", nil, http.StatusForbidden)
	for _, token := range []string{one, admin} {
		raw := request(token, http.MethodGet, "/api/plugins", nil, http.StatusOK)
		if strings.TrimSpace(string(raw)) != "[]" {
			t.Fatal("new catalog unexpectedly exposed configured components")
		}
	}
	request(admin, http.MethodGet, "/api/admin/plugins", nil, http.StatusOK)
	request(admin, http.MethodGet, "/api/admin/plugins/components", nil, http.StatusServiceUnavailable)
	session, err := store.CreateSession(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetSessionComputer(context.Background(), userID, session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	ctx := agent.WithRunScope(context.Background(), agent.RunScope{UserID: userID, SessionID: session.ID})
	tools := s.tools.(*personalTools)
	if _, err := tools.Definitions(ctx, userID); err != nil {
		t.Fatal("offline metadata broke intrinsic tool definitions", err)
	}
	source.mu.Lock()
	if source.bridgeReads != 1 {
		t.Fatal("listing plugins or resolving runtime policy provisioned the workspace")
	}
	source.unavailable = false
	source.mu.Unlock()
	raw := request(admin, http.MethodGet, "/api/admin/plugins", nil, http.StatusOK)
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatal("configured components appeared without an administrator creating plugins")
	}
	request(admin, http.MethodGet, "/api/admin/plugins/components", nil, http.StatusOK)
	for _, p := range []storage.Plugin{
		{ID: "required-alpha", Name: "Required Alpha", Enabled: true, DefaultEnabled: true, SkillIDs: []string{"alpha"}, MCPIDs: []string{}},
		{ID: "required-docs", Name: "Required Docs", Enabled: true, DefaultEnabled: true, SkillIDs: []string{}, MCPIDs: []string{"docs"}},
	} {
		request(admin, http.MethodPost, "/api/admin/plugins", map[string]any{"id": p.ID, "name": p.Name, "enabled": p.Enabled, "default_enabled": p.DefaultEnabled, "skill_ids": p.SkillIDs, "mcp_ids": p.MCPIDs}, http.StatusCreated)
		request(one, http.MethodPatch, "/api/plugins/"+p.ID, map[string]bool{"enabled": false}, http.StatusConflict)
	}
	request(admin, http.MethodDelete, "/api/admin/skills/alpha", nil, http.StatusConflict)
	for _, id := range []string{"required-alpha", "required-docs"} {
		request(admin, http.MethodDelete, "/api/admin/plugins/"+id, nil, http.StatusNoContent)
	}
	plugin := map[string]any{"id": "research", "name": "Research", "description": "Fixture plugin", "enabled": true, "default_enabled": false, "skill_ids": []string{"alpha"}, "mcp_ids": []string{"docs"}}
	request(one, http.MethodPost, "/api/admin/plugins", plugin, http.StatusForbidden)
	request(admin, http.MethodPost, "/api/admin/plugins", plugin, http.StatusCreated)
	request(admin, http.MethodPost, "/api/admin/plugins", map[string]any{"id": "collision", "name": "Collision", "skill_ids": []string{"alpha"}}, http.StatusConflict)
	request(admin, http.MethodPost, "/api/admin/plugins", map[string]any{"id": "missing", "name": "Missing", "skill_ids": []string{"unknown"}}, http.StatusBadRequest)
	readUser := func(token string, want bool) {
		t.Helper()
		raw := request(token, http.MethodGet, "/api/plugins", nil, http.StatusOK)
		var values []storage.UserPlugin
		if json.Unmarshal(raw, &values) != nil || len(values) != 1 || values[0].EffectiveEnabled != want {
			t.Fatalf("unexpected user plugin state: %s", raw)
		}
	}
	readUser(one, false)
	request(one, http.MethodPatch, "/api/plugins/research", map[string]bool{"enabled": true}, http.StatusOK)
	readUser(one, true)
	readUser(two, false)
	if result, err := tools.Call(ctx, userID, "mcp_docs_ping", json.RawMessage(`{}`)); err != nil || result.Output != "pong" {
		t.Fatal("enabled plugin was not dispatched", err)
	}
	indexCtx := agent.WithRunScope(ctx, agent.RunScope{UserID: userID, SessionID: session.ID, RunID: "plugin-fixture-run"})
	tools.skillIndexes.Store(userID+"\x00plugin-fixture-run", &skillIndexCache{loaded: true, value: `{"skills":[{"id":"private:verified","name":"Verified method","description":"Owner-private fixture"}],"total":1}`})
	first, err := tools.SkillsIndex(indexCtx, userID)
	if err != nil || !strings.Contains(first, `"id":"alpha"`) {
		t.Fatal("enabled installed metadata was missing", err)
	}
	request(one, http.MethodPatch, "/api/plugins/research", map[string]bool{"enabled": false}, http.StatusOK)
	if _, err := tools.Call(ctx, userID, "mcp_docs_ping", json.RawMessage(`{}`)); err == nil {
		t.Fatal("disabled known/cached MCP tool was dispatched")
	}
	second, err := tools.SkillsIndex(indexCtx, userID)
	if err != nil || strings.Contains(second, `"id":"alpha"`) {
		t.Fatal("installed index cache ignored the live toggle", err)
	}
	if !strings.Contains(second, `"id":"private:verified"`) {
		t.Fatal("plugin disable hid the independent private-method index")
	}
	request(admin, http.MethodPatch, "/api/admin/plugins/research", map[string]bool{"default_enabled": true}, http.StatusOK)
	readUser(one, true)
	readUser(two, true)
	request(one, http.MethodPatch, "/api/plugins/research", map[string]bool{"enabled": false}, http.StatusConflict)
	if _, err := store.SetSessionComputer(context.Background(), userID, session.ID, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := tools.Call(ctx, userID, "mcp_docs_ping", json.RawMessage(`{}`)); err == nil {
		t.Fatal("mandatory plugin bypassed the existing Computer gate")
	}
	if _, err := store.SetSessionComputer(context.Background(), userID, session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	source.unavailable = true
	source.mu.Unlock()
	request(admin, http.MethodPatch, "/api/admin/plugins/research", map[string]bool{"enabled": false}, http.StatusOK)
	if _, err := tools.Call(ctx, userID, "mcp_docs_ping", json.RawMessage(`{}`)); err == nil {
		t.Fatal("globally disabled MCP tool was dispatched")
	}
	raw = request(one, http.MethodGet, "/api/plugins", nil, http.StatusOK)
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatal("globally disabled plugin remained available")
	}
}
