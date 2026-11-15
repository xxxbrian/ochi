package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

type sessionMemoryInstalledTools struct{ pluginFixtureTools }

func (tools *sessionMemoryInstalledTools) Definitions(ctx context.Context, userID string) ([]agent.ToolDefinition, error) {
	definitions, err := tools.pluginFixtureTools.Definitions(ctx, userID)
	access, _ := agent.ExtensionAccessFromContext(ctx)
	for _, id := range access.Skills {
		if id == "alpha" {
			definitions = append(definitions, agent.ToolDefinition{Name: "skills_read", Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)})
		}
	}
	return definitions, err
}

func (tools *sessionMemoryInstalledTools) Call(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
	if name == "skills_read" {
		access, _ := agent.ExtensionAccessFromContext(ctx)
		for _, id := range access.Skills {
			if id == "alpha" && string(args) == `{"id":"alpha"}` {
				return agent.ToolResult{Output: "Installed fixture instructions"}, nil
			}
		}
		return agent.ToolResult{}, errors.New("installed skill unavailable")
	}
	return tools.pluginFixtureTools.Call(ctx, userID, name, args)
}

func sessionMemoryRun(t *testing.T, f coreHTTPFixture, enabled bool, runID string) (storage.Session, runtime.Snapshot, context.Context) {
	t.Helper()
	ctx := context.Background()
	session, err := f.server.store.CreateSessionWithMemory(ctx, f.owner, "", enabled)
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := f.server.store.CreateConfiguredRun(ctx, f.owner, session.ID, "Create the requested report", runID, storage.Model{ID: f.run.ModelID, Name: f.run.ModelName}, "", agent.SystemPrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: session.ID, RunID: run.RunID, CWD: session.WorkspacePath}
	return session, run, agent.WithRunScope(ctx, scope)
}

func TestSessionMemoryCreateContractAndImmutableCommands(t *testing.T) {
	f := newCoreHTTPFixture(t)
	for _, tc := range []struct {
		body string
		want bool
	}{{`{}`, true}, {`{"memory_enabled":true}`, true}, {`{"memory_enabled":false}`, false}} {
		raw := f.request(t, f.token, http.MethodPost, "/api/sessions", tc.body, http.StatusCreated)
		var session storage.Session
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &session) != nil || json.Unmarshal(raw, &fields) != nil || fields["memory_enabled"] == nil || session.MemoryEnabled != tc.want {
			t.Fatalf("creation did not return the required memory choice: %s", raw)
		}
		for _, value := range []string{"true", "false", "null"} {
			f.request(t, f.token, http.MethodPatch, "/api/sessions/"+session.ID, `{"title":"Must not be applied","memory_enabled":`+value+`}`, http.StatusBadRequest)
			f.request(t, f.token, http.MethodPost, "/api/sessions/"+session.ID+"/runs", `{"message":"Rejected override","memory_enabled":`+value+`}`, http.StatusBadRequest)
		}
		current, err := f.server.store.GetSession(context.Background(), f.owner, session.ID)
		if err != nil || current.MemoryEnabled != tc.want || current.Title != "" {
			t.Fatal("rejected mutation changed the session")
		}
		f.request(t, f.token, http.MethodPatch, "/api/sessions/"+session.ID, `{"title":"Saved conversation","computer_enabled":true,"remember_computer_default":false}`, http.StatusOK)
		current, err = f.server.store.GetSession(context.Background(), f.owner, session.ID)
		if err != nil || current.MemoryEnabled != tc.want || !current.ComputerEnabled || current.Title != "Saved conversation" {
			t.Fatal("ordinary title/Computer patch changed the fixed memory choice")
		}
		head := f.request(t, f.token, http.MethodGet, "/api/sessions/"+session.ID+"/head", "", http.StatusOK)
		if !strings.Contains(string(head), fmt.Sprintf(`"memory_enabled":%t`, tc.want)) {
			t.Fatal("session head omitted its memory choice")
		}
	}
	for _, body := range []string{`{"memory_enabled":"false"}`, `{"memory_enabled":0}`, `{"memory_enabled":{}}`, `{"memory_enabled":null}`} {
		f.request(t, f.token, http.MethodPost, "/api/sessions", body, http.StatusBadRequest)
	}
	// Streaming JSON bodies must not silently become a default-on conversation.
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(`{"memory_enabled":false}`))
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+f.token)
	response := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(response, req)
	var streamed storage.Session
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &streamed) != nil || streamed.MemoryEnabled {
		t.Fatal("streaming create body ignored the explicit memory-off choice")
	}
}

func TestSessionMemoryOffToolsAndInstalledPluginsStayIndependent(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	source := &sessionMemoryInstalledTools{}
	f.server.SetTools(source)
	if _, err := f.server.store.SavePlugin(ctx, storage.Plugin{ID: "memory-fixture", Name: "Installed fixture", Enabled: true, DefaultEnabled: true, SkillIDs: []string{"alpha"}, MCPIDs: []string{"docs"}}, true); err != nil {
		t.Fatal(err)
	}
	session, run, scoped := sessionMemoryRun(t, f, false, "88888888-abcd-4888-8888-888888888881")
	if _, err := f.server.store.SetSessionComputer(ctx, f.owner, session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	tools := f.server.tools.(*personalTools)
	definitions, err := tools.Definitions(scoped, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, definition := range definitions {
		seen[definition.Name] = true
		if personalMemoryTool(definition.Name) {
			t.Fatalf("memory-off discovery exposed %s", definition.Name)
		}
	}
	for _, required := range []string{"task_read", "task_update", "task_verify", "isolated_research", "mcp_docs_ping"} {
		if !seen[required] {
			t.Fatalf("memory-off discovery removed independent tool %s", required)
		}
	}
	for _, call := range []struct{ name, args string }{
		{"memory_search", `{"query":"personal facts"}`},
		{"memory_save", `{"content":"Personal fact","excerpt":"Create the requested report"}`},
		{"memory_delete", `{"id":"known-personal-memory"}`},
		{"history_search", `{"query":"older chat"}`},
		{"history_read", fmt.Sprintf(`{"session_id":%q}`, f.session.ID)},
		{"skills_promote", `{"name":"method","description":"Checked","body":"Steps"}`},
		{"skills_read", `{"id":"private:known-method"}`},
	} {
		if _, err := tools.Call(scoped, f.owner, call.name, json.RawMessage(call.args)); !errors.Is(err, errSessionMemoryDisabled) {
			t.Fatalf("forced %s bypassed memory-off dispatch: %v", call.name, err)
		}
	}
	if _, err := f.server.memoryTool(scoped, f.owner, "memory_delete", json.RawMessage(`{"id":"known"}`)); !errors.Is(err, errSessionMemoryDisabled) {
		t.Fatal("direct memory tool bypassed conversation policy")
	}
	if _, err := f.server.historyTool(scoped, f.owner, "history_read", json.RawMessage(fmt.Sprintf(`{"session_id":%q}`, f.session.ID))); !errors.Is(err, errSessionMemoryDisabled) {
		t.Fatal("direct history tool bypassed conversation policy")
	}
	tools.skillIndexes.Store(f.owner+"\x00"+run.RunID, &skillIndexCache{loaded: true, value: `{"skills":[{"id":"private:secret-method","name":"Private secret","description":"Private learned metadata"}],"total":1}`})
	index, err := tools.SkillsIndex(scoped, f.owner)
	if err != nil || strings.Contains(index, "secret-method") || !strings.Contains(index, `"id":"alpha"`) {
		t.Fatalf("memory-off private index leaked or installed metadata disappeared: %s %v", index, err)
	}
	withoutRun, _ := agent.ScopeFromContext(scoped)
	withoutRun.RunID = ""
	installedScope := agent.WithRunScope(ctx, withoutRun)
	if result, err := tools.Call(installedScope, f.owner, "mcp_docs_ping", json.RawMessage(`{}`)); err != nil || result.Output != "pong" {
		t.Fatal("memory-off disabled an installed MCP permitted by plugin/Computer policy", err)
	}
	if result, err := tools.Call(installedScope, f.owner, "skills_read", json.RawMessage(`{"id":"alpha"}`)); err != nil || result.Output != "Installed fixture instructions" {
		t.Fatal("memory-off disabled installed Skill instructions permitted by plugin/Computer policy", err)
	}
	taskArgs := json.RawMessage(`{"objective":"Create the requested report","constraints":[{"text":"Produce only the requested report","source_excerpt":"Create the requested report"}],"done":[],"remaining":["Write the report"],"acceptance":[],"expected_revision":0}`)
	if _, err := tools.Call(scoped, f.owner, "task_update", taskArgs); err != nil {
		t.Fatal("memory-off blocked current-conversation task constraints", err)
	}
	if result, err := tools.Call(scoped, f.owner, "task_read", json.RawMessage(`{}`)); err != nil || !strings.Contains(result.Output, "Produce only the requested report") {
		t.Fatal("memory-off lost TaskState", err)
	}
	onSession, onRun, onScope := sessionMemoryRun(t, f, true, "88888888-abcd-4888-8888-888888888885")
	if _, err := f.server.store.SetSessionComputer(ctx, f.owner, onSession.ID, true, false); err != nil {
		t.Fatal(err)
	}
	tools.skillIndexes.Store(f.owner+"\x00"+onRun.RunID, &skillIndexCache{loaded: true, value: `{"skills":[{"id":"private:cached-method","name":"Cached private method","description":"Private learned metadata"}],"total":1}`})
	if index, err := tools.SkillsIndex(onScope, f.owner); err != nil || !strings.Contains(index, "cached-method") {
		t.Fatal("on-session cached private metadata regressed", err)
	}
	off := false
	if _, err := f.server.store.PatchPreferences(ctx, f.owner, storage.PreferencesPatch{MemoryEnabled: &off}); err != nil {
		t.Fatal(err)
	}
	definitions, err = tools.Definitions(onScope, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, definition := range definitions {
		if personalMemoryTool(definition.Name) {
			t.Fatalf("account upper bound advertised %s in an on conversation", definition.Name)
		}
	}
	if index, err := tools.SkillsIndex(onScope, f.owner); err != nil || strings.Contains(index, "cached-method") || !strings.Contains(index, `"id":"alpha"`) {
		t.Fatal("account upper bound retained private cache or hid installed metadata", err)
	}
	if _, err := tools.Call(onScope, f.owner, "memory_delete", json.RawMessage(`{"id":"known"}`)); !errors.Is(err, errSessionMemoryDisabled) {
		t.Fatal("account upper bound allowed forced personal memory dispatch")
	}
}

func TestSessionMemoryOffQueuedTurnSteeringWorkerAndRetry(t *testing.T) {
	f := newCoreHTTPFixture(t)
	model, calls := coreMemoryEmbeddingFixture(t, f)
	ctx := context.Background()
	if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "Private preference must stay out", Kind: "preference", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	session, err := f.server.store.CreateSessionWithMemory(ctx, f.owner, "", false)
	if err != nil {
		t.Fatal(err)
	}
	captured := make(chan agent.Request, 2)
	release := make(chan struct{})
	f.server.agent = artifactPolicyGenerator(func(call context.Context, request agent.Request, emit func(agent.Update) error) error {
		captured <- request
		select {
		case <-release:
		case <-call.Done():
			return call.Err()
		}
		return emit(agent.Update{RoundID: "fixture", TextID: "fixture", Text: "Saved ordinary answer", TextKind: "final"})
	})
	const firstID = "88888888-abcd-4888-8888-888888888882"
	if _, err := f.server.startQueuedRun(ctx, f.owner, session.ID, firstID, "Create the requested report", model.ID, "", nil); err != nil {
		t.Fatal(err)
	}
	var first agent.Request
	select {
	case first = <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("memory-off queued run did not execute")
	}
	scopeCtx := agent.WithRunScope(ctx, first.Scope)
	if first.Config.MemoryContext != "" || calls.Load() != 0 || !first.Scope.ComputeOnly {
		t.Fatal("memory-off startup injected recall, embedded a query or changed Computer")
	}
	if err := first.BeforeCompaction(scopeCtx); err != nil {
		t.Fatal("memory-off preservation blocked ordinary compaction", err)
	}
	if _, err := f.server.store.AcceptInstruction(ctx, f.owner, firstID, "memory-off-steering-key", "Keep this instruction in this report"); err != nil {
		t.Fatal(err)
	}
	update, err := first.AtBoundary(scopeCtx)
	if err != nil || len(update.Messages) != 1 || update.MemoryContext == nil || *update.MemoryContext != "" || calls.Load() != 0 {
		t.Fatal("memory-off steering lost accepted input or recalled personal evidence", err)
	}
	for _, enabled := range []bool{false, true} {
		if _, err := f.server.store.PatchPreferences(ctx, f.owner, storage.PreferencesPatch{MemoryEnabled: &enabled}); err != nil {
			t.Fatal(err)
		}
		update, err = first.AtBoundary(scopeCtx)
		if err != nil || update.MemoryContext == nil || *update.MemoryContext != "" || calls.Load() != 0 {
			t.Fatal("account toggle enabled a fixed memory-off conversation", err)
		}
	}
	close(release)
	completed := waitSessionMemoryRun(t, f, firstID)
	if completed.Status != runtime.StatusCompleted {
		t.Fatalf("ordinary memory-off run did not complete: %s", completed.Status)
	}
	messages, err := f.server.store.Messages(ctx, f.owner, session.ID)
	if err != nil || len(messages) < 2 || messages[len(messages)-1].Content != "Saved ordinary answer" {
		t.Fatal("memory-off run was not retained in ordinary chat history")
	}
	pref, _ := f.server.store.Preferences(ctx, f.owner)
	job := storage.MemoryJob{UserID: f.owner, SessionID: session.ID, RunID: firstID, Revision: pref.MemoryRevision}
	if err := f.server.extractMemoryJob(ctx, job); !errors.Is(err, storage.ErrMemoryChanged) || calls.Load() != 0 {
		t.Fatal("forged worker job processed an excluded source", err)
	}
	f.server.asyncMemory(first, completed)
	jobs, err := f.server.store.MemoryJobs(ctx, f.owner)
	if err != nil || len(jobs) != 0 {
		t.Fatal("memory-off completion or preservation queued extraction")
	}
	const retryID = "88888888-abcd-4888-8888-888888888883"
	if _, err := f.server.startQueuedRun(ctx, f.owner, session.ID, retryID, "", model.ID, "", nil, storage.Revision{RetryRunID: firstID}); err != nil {
		t.Fatal("ordinary memory-off retry was rejected", err)
	}
	select {
	case retry := <-captured:
		if retry.SessionID != session.ID || retry.Config.MemoryContext != "" || len(retry.Messages) != 1 || retry.Messages[0].Content != "Create the requested report" || calls.Load() != 0 {
			t.Fatal("retry replaced fixed memory policy or original input")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("memory-off retry did not execute")
	}
	if retried := waitSessionMemoryRun(t, f, retryID); retried.Status != runtime.StatusCompleted {
		t.Fatal("memory-off retry did not complete")
	}
	drain, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := f.server.runtime.Drain(drain); err != nil {
		t.Fatal("fixture execution did not drain", err)
	}
}

func waitSessionMemoryRun(t *testing.T, f coreHTTPFixture, runID string) runtime.Snapshot {
	t.Helper()
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		snapshot, err := f.server.store.GetRun(context.Background(), f.owner, runID)
		if err != nil {
			t.Fatal(err)
		}
		if runtime.IsTerminal(snapshot.Status) {
			return snapshot
		}
		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatal("memory fixture run did not finish")
		}
	}
}

func TestSessionMemoryOffIsolatedResearchInheritsToolPolicy(t *testing.T) {
	f := newCoreHTTPFixture(t)
	session, run, scoped := sessionMemoryRun(t, f, false, "88888888-abcd-4888-8888-888888888884")
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools    json.RawMessage `json:"tools"`
			Messages []agent.Message `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid child provider request")
		}
		for _, name := range []string{"memory_search", "history_search", "history_read"} {
			if strings.Contains(string(body.Tools), name) {
				t.Errorf("research child was offered disabled %s", name)
			}
		}
		for _, message := range body.Messages {
			if strings.Contains(message.Content, "must not reach child") {
				t.Error("memory-off research inherited parent memory context")
			}
		}
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"forced-memory\",\"type\":\"function\",\"function\":{\"name\":\"memory_search\",\"arguments\":\"{\\\"query\\\":\\\"private preference\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"No personal evidence was available.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	scope, _ := agent.ScopeFromContext(scoped)
	scope.ComputeOnly = true
	config := &agent.Config{BaseURL: provider.URL, Model: "fixture", AllowNoKey: true, SupportsTools: true, Tools: f.server.tools, MemoryContext: "must not reach child"}
	request := agent.Request{UserID: f.owner, SessionID: session.ID, RunID: run.RunID, Scope: scope, Config: config, Budget: agent.NewExecutionBudget(10), Messages: []agent.Message{{Role: "user", Content: "Review current report"}}}
	scoped = context.WithValue(agent.WithRunScope(scoped, scope), frozenRequestKey{}, request)
	result, err := f.server.isolatedResearchTool(scoped, scope, json.RawMessage(`{"task":"Review only supplied material"}`))
	var value researchResult
	if err != nil || json.Unmarshal([]byte(result.Output), &value) != nil || value.Status != "completed" || !strings.Contains(value.Findings, "No personal evidence") || requests.Load() != 2 {
		t.Fatalf("memory-off child policy failed: %s %v", result.Output, err)
	}
}
