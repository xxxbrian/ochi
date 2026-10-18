package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

type coreEvalCheck struct {
	Criterion string `json:"criterion"`
	Passed    bool   `json:"passed"`
	Detail    string `json:"detail,omitempty"`
}

type coreEvalToolEvent struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Status    string          `json:"status"`
	Output    string          `json:"output"`
	Bytes     int             `json:"original_output_bytes"`
}

type coreEvalCase struct {
	ID             string                 `json:"id"`
	PromptVersion  string                 `json:"prompt_version"`
	Boundary       string                 `json:"evidence_boundary"`
	Prompt         string                 `json:"user_prompt"`
	Output         string                 `json:"actual_public_output"`
	Error          string                 `json:"error,omitempty"`
	ElapsedMS      int64                  `json:"elapsed_ms"`
	Status         string                 `json:"status"`
	Checks         []coreEvalCheck        `json:"checks"`
	Tools          []coreEvalToolEvent    `json:"actual_tool_events,omitempty"`
	Compactions    []agent.Compaction     `json:"actual_compactions,omitempty"`
	Diagnostics    []agent.Diagnostic     `json:"diagnostics,omitempty"`
	Contexts       []coreEvalContext      `json:"contexts,omitempty"`
	PublicUsage    []agent.Usage          `json:"stream_reported_usage,omitempty"`
	ModelRequests  []coreEvalModelRequest `json:"model_requests,omitempty"`
	CanonicalBytes int                    `json:"canonical_bytes_checkpointed"`
	PriorAttempts  []coreEvalCase         `json:"prior_attempts,omitempty"`
	RunID          string                 `json:"owned_qa_run_id,omitempty"`
	Artifacts      []coreEvalArtifact     `json:"actual_artifacts,omitempty"`
}

type coreEvalArtifact struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	URL     string `json:"url"`
	Bytes   int    `json:"bytes"`
	SHA256  string `json:"sha256"`
}

type coreEvalContext struct {
	Round  string              `json:"round"`
	Parts  []agent.ContextPart `json:"parts"`
	SHA256 string              `json:"sha256"`
	Budget agent.ContextBudget `json:"budget"`
}

type coreEvalModelRequest struct {
	Case          string       `json:"case"`
	Model         string       `json:"model"`
	Streaming     bool         `json:"streaming"`
	HTTPStatus    int          `json:"http_status"`
	ElapsedMS     int64        `json:"elapsed_ms"`
	Usage         *agent.Usage `json:"provider_reported_usage,omitempty"`
	UsageReported bool         `json:"usage_reported"`
	InputSHA256   string       `json:"input_sha256"`
}

type coreEvalGateway struct {
	mu       sync.Mutex
	requests []coreEvalModelRequest
	config   agent.Config
	client   *http.Client
}

// This transparent loopback recorder forwards only the authorized model's
// inference requests. It stores usage/timing, never transport secrets or private
// reasoning; tools below remain explicitly controlled QA evidence.
func (g *coreEvalGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, 8*1024*1024))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var options struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(payload, &options) != nil || options.Model != g.config.Model {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	g.mu.Lock()
	if len(g.requests) >= 40 {
		g.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"error":{"code":"eval_budget","message":"fixed QA request budget exhausted"}}`)
		return
	}
	index := len(g.requests)
	hash := sha256.Sum256(payload)
	g.requests = append(g.requests, coreEvalModelRequest{Case: r.Header.Get("X-Ochi-Eval-Case"), Model: options.Model, Streaming: options.Stream, InputSHA256: hex.EncodeToString(hash[:])})
	g.mu.Unlock()
	start := time.Now()
	var usage *agent.Usage
	status := http.StatusBadGateway
	var completed sync.Once
	commit := func() {
		completed.Do(func() {
			g.mu.Lock()
			g.requests[index].ElapsedMS = time.Since(start).Milliseconds()
			g.requests[index].HTTPStatus = status
			g.requests[index].Usage, g.requests[index].UsageReported = usage, usage != nil
			g.mu.Unlock()
		})
	}
	defer commit()
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimRight(g.config.BaseURL, "/")+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		w.WriteHeader(status)
		return
	}
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")
	if g.config.APIKey != "" {
		upstream.Header.Set("Authorization", "Bearer "+g.config.APIKey)
	}
	for key, value := range g.config.Headers {
		upstream.Header.Set(key, value)
	}
	response, err := g.client.Do(upstream)
	if err != nil {
		w.WriteHeader(status)
		fmt.Fprint(w, `{"error":{"code":"server_error","message":"authorized model connection failed"}}`)
		return
	}
	defer response.Body.Close()
	status = response.StatusCode
	for _, name := range []string{"Content-Type", "Retry-After"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(status)
	if !options.Stream || status < 200 || status >= 300 {
		data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
		if err == nil {
			usage = coreEvalUsage(data)
			commit()
			_, _ = w.Write(data)
		}
		return
	}
	reader := bufio.NewReader(response.Body)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			done := false
			if bytes.HasPrefix(line, []byte("data:")) {
				data := bytes.TrimSpace(line[5:])
				done = bytes.Equal(data, []byte("[DONE]"))
				if reported := coreEvalUsage(data); reported != nil {
					usage = reported
				}
			}
			if done {
				// The client returns at DONE, possibly before upstream EOF. Commit
				// its usage record first so the case snapshot cannot see a placeholder.
				commit()
			}
			if _, err := w.Write(line); err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			if done {
				return
			}
		}
		if readErr != nil {
			return
		}
	}
}

func coreEvalUsage(data []byte) *agent.Usage {
	var result struct {
		Usage *struct {
			PromptTokens     int64  `json:"prompt_tokens"`
			CompletionTokens int64  `json:"completion_tokens"`
			TotalTokens      int64  `json:"total_tokens"`
			CacheHits        *int64 `json:"prompt_cache_hit_tokens"`
			PromptDetails    struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionDetails struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &result) != nil || result.Usage == nil {
		return nil
	}
	u := result.Usage
	cached := u.PromptDetails.Cached
	if cached == nil {
		cached = u.CacheHits
	}
	return &agent.Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens, CachedTokens: cached, ReasoningTokens: u.CompletionDetails.Reasoning}
}

func (g *coreEvalGateway) forCase(id string) []coreEvalModelRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	items := []coreEvalModelRequest{}
	for _, request := range g.requests {
		if request.Case == id {
			items = append(items, request)
		}
	}
	return items
}

func TestCoreEvaluationRecorderCommitsBeforeForwardingDone(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2,\"total_tokens\":13}}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
		// A real gateway may keep its connection open after the logical end.
		<-r.Context().Done()
	}))
	defer upstream.Close()
	gateway := &coreEvalGateway{config: agent.Config{BaseURL: upstream.URL, Model: "controlled-model"}, client: upstream.Client()}
	downstream := httptest.NewServer(gateway)
	defer downstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, downstream.URL+"/chat/completions", strings.NewReader(`{"model":"controlled-model","stream":true}`))
	req.Header.Set("X-Ochi-Eval-Case", "recorder-regression")
	response, err := downstream.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal("recorder did not forward a logical end before upstream EOF")
		}
		if strings.TrimSpace(line) == "data: [DONE]" {
			break
		}
	}
	records := gateway.forCase("recorder-regression")
	if len(records) != 1 || records[0].HTTPStatus != http.StatusOK || !records[0].UsageReported || records[0].Usage == nil || records[0].Usage.TotalTokens != 13 {
		t.Fatalf("client observed DONE before usage finalized: %+v", records)
	}
}

type coreEvalTools struct {
	definitions []agent.ToolDefinition
	call        func(context.Context, string, string, json.RawMessage) (agent.ToolResult, error)
}

func (tools coreEvalTools) Definitions(context.Context, string) ([]agent.ToolDefinition, error) {
	return tools.definitions, nil
}
func (tools coreEvalTools) Call(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
	return tools.call(ctx, userID, name, args)
}

type coreEvalRunner struct {
	t       *testing.T
	server  *Server
	store   *storage.Store
	userID  string
	model   storage.Model
	config  agent.Config
	gateway *coreEvalGateway
	only    string
}

func (e coreEvalRunner) session() storage.Session {
	e.t.Helper()
	session, err := e.store.CreateSession(context.Background(), e.userID)
	if err != nil {
		e.t.Fatal("could not seed an owned evaluation session")
	}
	return session
}

func (e coreEvalRunner) newID() string {
	e.t.Helper()
	id, err := newID()
	if err != nil {
		e.t.Fatal("could not generate owned QA identifier")
	}
	return id
}

func (e coreEvalRunner) builtins(names ...string) coreEvalTools {
	selected := map[string]bool{}
	for _, name := range names {
		selected[name] = true
	}
	p := personalTools{server: e.server}
	definitions := []agent.ToolDefinition{}
	for _, definition := range p.builtinDefinitions(context.Background()) {
		if selected[definition.Name] {
			definitions = append(definitions, definition)
		}
	}
	return coreEvalTools{definitions: definitions, call: func(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
		if strings.HasPrefix(name, "history_") {
			return e.server.historyTool(ctx, userID, name, args)
		}
		return e.server.memoryTool(ctx, userID, name, args)
	}}
}

func (e coreEvalRunner) run(id, boundary, prompt string, session storage.Session, tools agent.ToolSource, modify func(*agent.Config, *agent.Request)) coreEvalCase {
	e.t.Helper()
	result := coreEvalCase{ID: id, PromptVersion: agent.PromptVersion, Boundary: boundary, Prompt: prompt, Checks: []coreEvalCheck{}}
	if e.only != "" && e.only != id {
		result.Status = "not_selected"
		return result
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	runID := e.newID()
	result.RunID = runID
	snapshot, history, err := e.store.CreateConfiguredRun(ctx, e.userID, session.ID, prompt, runID, e.model, "", "", nil)
	if err != nil {
		result.Error, result.Status = "owned QA run could not be persisted", "failed"
		return result
	}
	scope := agent.RunScope{UserID: e.userID, SessionID: session.ID, RunID: runID, WorkspaceID: "controlled-qa-only", ComputeOnly: true}
	ctx = agent.WithRunScope(ctx, scope)
	config := e.config
	config.ModelID, config.ProviderID = e.model.ID, e.model.ProviderID
	config.TimeoutSeconds, config.MaxToolRounds = 150, 6
	config.Headers = map[string]string{"X-Ochi-Eval-Case": id}
	config.Tools = tools
	config.Observe = func(d agent.Diagnostic) { result.Diagnostics = append(result.Diagnostics, d) }
	request := agent.Request{UserID: e.userID, SessionID: session.ID, RunID: runID, Scope: scope, History: history, Timezone: "Asia/Shanghai", Budget: agent.NewExecutionBudget(7)}
	request.BeforeCompaction = func(ctx context.Context) error { return e.server.preserveMemoryBeforeCompaction(ctx, e.userID, runID) }
	request.ObserveContext = func(c agent.ContextInspection) {
		result.Contexts = append(result.Contexts, coreEvalContext{Round: c.Round, Parts: c.Parts, SHA256: c.SHA256, Budget: c.Budget})
	}
	if modify != nil {
		modify(&config, &request)
	}
	ctx = agent.WithRunScope(ctx, request.Scope)
	request.Config = &config
	live := e.server.runtime.Restore(snapshot)
	defer func() {
		e.server.resources.releaseRun(runID)
		e.server.scopePreparations.Delete(runID)
		for _, mode := range []string{":computer", ":compute", ":last-mode"} {
			e.server.preparedScopes.Delete(runID + mode)
		}
	}()
	generator, err := agent.NewOpenAI(config)
	if err == nil {
		err = generator.Generate(ctx, request, func(update agent.Update) error {
			if update.ResetOutput {
				result.Output = ""
				if err := live.ResetOutput(); err != nil {
					return err
				}
			}
			result.Output += update.Text
			if update.Text != "" {
				if err := live.Append(update.Text); err != nil {
					return err
				}
			}
			if update.Step != nil {
				step := update.Step
				if err := live.UpdateStep(runtime.Step{ID: step.ID, Name: step.Name, Status: step.Status, Arguments: step.Arguments, Output: step.Output}); err != nil {
					return err
				}
			}
			if update.Step != nil && update.Step.Status != "running" {
				text, _ := storage.SanitizeHistoryText(update.Step.Output, 2200)
				result.Tools = append(result.Tools, coreEvalToolEvent{Name: update.Step.Name, Arguments: update.Step.Arguments, Status: update.Step.Status, Output: text, Bytes: len(update.Step.Output)})
			}
			if update.Usage != nil {
				result.PublicUsage = append(result.PublicUsage, *update.Usage)
			}
			if update.Canonical != nil {
				result.CanonicalBytes += len(update.Canonical.Payload)
				return e.store.AppendCanonical(ctx, session.ID, runID, update.Canonical)
			}
			if update.Compaction != nil {
				result.Compactions = append(result.Compactions, *update.Compaction)
				return e.store.SaveCompaction(ctx, session.ID, *update.Compaction)
			}
			return nil
		})
	}
	if err != nil {
		var modelError *agent.ModelError
		if errors.As(err, &modelError) {
			result.Error = modelError.Error()
		} else if errors.Is(err, context.DeadlineExceeded) {
			result.Error = "fixed evaluation time budget exceeded"
		} else {
			result.Error = "agent execution or owned QA persistence failed"
		}
	}
	status := runtime.StatusCompleted
	if err != nil {
		status = runtime.StatusFailed
	}
	live.Finish(status, result.Error)
	snapshot = live.Snapshot()
	if completeErr := e.store.CompleteRun(context.Background(), snapshot); completeErr != nil {
		result.Error = "owned QA terminal state could not be persisted"
	}
	result.ElapsedMS = time.Since(start).Milliseconds()
	result.ModelRequests = e.gateway.forCase(id)
	result.check("real configured model completed without fallback or execution error", result.Error == "" && strings.TrimSpace(result.Output) != "", result.Error)
	return result
}

func (c *coreEvalCase) check(criterion string, passed bool, detail string) {
	if c.Status == "not_selected" {
		return
	}
	c.Checks = append(c.Checks, coreEvalCheck{Criterion: criterion, Passed: passed, Detail: detail})
	c.Status = "passed"
	for _, check := range c.Checks {
		if !check.Passed {
			c.Status = "failed"
		}
	}
}

func TestCoreFlowRealModelEvaluation(t *testing.T) {
	configPath, outputDir := os.Getenv("OCHI_EVALUATION_CONFIG"), os.Getenv("OCHI_EVALUATION_OUTPUT")
	if configPath == "" || outputDir == "" {
		t.Skip("explicit OCHI_EVALUATION_CONFIG and OCHI_EVALUATION_OUTPUT are required for billable real-model evaluation")
	}
	only := os.Getenv("OCHI_EVALUATION_ONLY")
	if only != "" && only != "topic_shift" && only != "repeated_failure" && only != "repeated_compaction_constraints" && only != "permission_revoke" && only != "immutable_artifact_delivery" {
		t.Fatal("unknown fixed narrow evaluation case")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal("authorized model configuration file is unavailable")
	}
	var authorized agent.Config
	if json.Unmarshal(data, &authorized) != nil || strings.TrimSpace(authorized.Model) == "" || authorized.Protocol != "openai" || authorized.BaseURL == "" || (authorized.APIKey == "" && !authorized.AllowNoKey) {
		t.Fatal("evaluation requires an explicit OpenAI-compatible configuration and selected model")
	}
	gateway := &coreEvalGateway{config: authorized, client: &http.Client{Timeout: 150 * time.Second}}
	proxy := httptest.NewServer(gateway)
	t.Cleanup(proxy.Close)
	config := authorized
	config.BaseURL, config.APIKey, config.AllowNoKey, config.Headers = proxy.URL, "", true, nil
	config.SystemPrompt = ""
	config.CompactionConfig = nil
	store := searchIntegrationStore(t)
	s, err := NewServer(store, nil, []Account{{Username: "core-real-qa", Password: "not-a-production-account", Role: "admin"}}, false)
	if err != nil {
		t.Fatal("could not prepare isolated real evaluation API")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Error("owned evaluation API shutdown failed")
		}
	})
	user, err := store.GetUser(context.Background(), "core-real-qa")
	if err != nil {
		t.Fatal("could not read controlled evaluation user")
	}
	// The embedding path is intentionally forced to lexical fallback, so this
	// result never masquerades as a real embedding relevance evaluation.
	embeddings := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) }))
	t.Cleanup(embeddings.Close)
	provider, err := store.SaveProvider(context.Background(), storage.Provider{Name: "Controlled evaluation only", BaseURL: embeddings.URL, Protocol: "openai", Enabled: true, AllowNoKey: true})
	if err != nil {
		t.Fatal("could not seed controlled model catalogue")
	}
	model, err := store.SaveModel(context.Background(), storage.Model{ProviderID: provider.ID, Name: authorized.Model, Model: authorized.Model, Kind: "chat", Available: true, Enabled: true, SupportsTools: true})
	if err != nil {
		t.Fatal("could not seed controlled chat catalogue")
	}
	embedding, err := store.SaveModel(context.Background(), storage.Model{ProviderID: provider.ID, Name: "Unavailable fixture embedding", Model: "fixture-embedding", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal("could not seed explicit embedding fallback")
	}
	settings, err := store.Settings(context.Background())
	if err != nil {
		t.Fatal("could not read owned QA settings")
	}
	settings.EmbeddingModelID = embedding.ID
	if err := store.SaveSettings(context.Background(), settings); err != nil {
		t.Fatal("could not apply owned QA embedding fallback")
	}
	e := coreEvalRunner{t: t, server: s, store: store, userID: user.ID, model: model, config: config, gateway: gateway, only: only}
	cases := []coreEvalCase{}

	// 1. The same conversation changes topic; the model sees a newly recalled
	// travel record, not the first compiler query's frozen retrieval.
	for _, m := range []storage.Memory{
		{Kind: "preference", Source: "user", Content: "Prefers responses in English."},
		{Kind: "session_summary", Source: "user", Content: "Compiler parser plan: migrate the parser to Rust and inspect borrow lifetimes."},
		{Kind: "session_summary", Source: "user", Content: "Kyoto travel hotel booking: check-in is October 21 at 15:30; nightly hotel budget is JPY 18,000."},
	} {
		if _, err := store.SaveMemoryRecord(context.Background(), user.ID, m); err != nil {
			t.Fatal("could not seed controlled topic memory")
		}
	}
	topicSession := e.session()
	first, firstErr := s.memoryContext(context.Background(), user.ID, "", topicSession.ID, "compiler parser")
	topicPrompt := "Back to Kyoto travel: what are our agreed hotel check-in time and nightly hotel budget? Use remembered information and give two short lines."
	second, secondErr := s.memoryContext(context.Background(), user.ID, "", topicSession.ID, topicPrompt)
	topic := e.run("topic_shift", "Real chat model; actual per-turn Ochi memory recall from controlled QA records; lexical fallback, not real embedding quality.", topicPrompt, topicSession, nil, func(config *agent.Config, _ *agent.Request) { config.MemoryContext = second })
	topic.check("first query recalls compiler; second recalls travel without frozen compiler record", firstErr == nil && secondErr == nil && strings.Contains(first, "migrate the parser") && strings.Contains(second, "18,000") && !strings.Contains(second, "migrate the parser"), "automatic recall quality, independent from answer correctness: actual memoryContext called twice on the same session")
	topic.check("actual answer retains agreed date/time and budget", strings.Contains(topic.Output, "21") && strings.Contains(topic.Output, "15:30") && (strings.Contains(topic.Output, "18,000") || strings.Contains(topic.Output, "18000")), "expected October 21, 15:30 and JPY 18,000")
	cases = append(cases, topic)

	// 2. Real tool arguments must replace, not merely contradict, a preference.
	old, err := store.SaveMemoryRecord(context.Background(), user.ID, storage.Memory{Kind: "preference", Source: "user", Content: "Prefers timestamps in UTC."})
	if err != nil {
		t.Fatal("could not seed controlled preference")
	}
	correctionSession := e.session()
	correctionPrompt := "Correction: I now prefer timestamps in Asia/Shanghai, not UTC. Remember this change instead of my old timestamp preference. Then briefly confirm the new preference."
	background, _ := s.memoryContext(context.Background(), user.ID, "", correctionSession.ID, correctionPrompt)
	correction := e.run("preference_correction", "Real chat model calls actual Ochi memory_save with exact current-user evidence; only owned QA memory is mutated.", correctionPrompt, correctionSession, e.builtins("memory_search", "memory_save", "memory_delete"), func(config *agent.Config, _ *agent.Request) { config.MemoryContext = background })
	active, activeErr := store.ScopedMemories(context.Background(), user.ID, "", "", false)
	newPreference, oldActive, saved := false, false, false
	for _, m := range active {
		oldActive = oldActive || m.ID == old.ID
		if strings.Contains(m.Content, "Asia/Shanghai") && m.Trust == "user_statement" && m.Kind == "preference" {
			newPreference = true
		}
	}
	for _, step := range correction.Tools {
		saved = saved || step.Name == "memory_save" && step.Status == "completed"
	}
	correction.check("model performs actual successful memory correction", saved && activeErr == nil && newPreference && !oldActive, "active new preference preserves user_statement provenance and supersedes old UTC preference")
	correction.check("public confirmation names the new preference", strings.Contains(correction.Output, "Asia/Shanghai"), "no fabricated claim of remembering without a successful tool")
	cases = append(cases, correction)

	// 3. A deliberately incomplete saved summary cannot replace original text.
	oldSession := e.session()
	oldRunID := e.newID()
	quote := "Delta schedule final approval: launch cutoff is 2027-04-18 16:45 Asia/Shanghai. The earlier 09:00 draft is superseded."
	oldSnapshot, oldHistory, err := store.CreateConfiguredRun(context.Background(), user.ID, oldSession.ID, quote, oldRunID, model, "", "", nil)
	if err != nil || len(oldHistory) == 0 {
		t.Fatal("could not seed original history evidence")
	}
	oldSnapshot.Status, oldSnapshot.Output = runtime.StatusCompleted, "Delta schedule approval noted."
	if err := store.CompleteRun(context.Background(), oldSnapshot); err != nil {
		t.Fatal("could not complete controlled history evidence")
	}
	if err := store.SaveCompaction(context.Background(), oldSession.ID, agent.Compaction{ThroughSeq: oldHistory[len(oldHistory)-1].Seq, Summary: "Delta schedule discussed. Exact final approval intentionally omitted from this controlled summary."}); err != nil {
		t.Fatal("could not seed compacted history")
	}
	history := e.run("original_history_evidence", "Real chat model; real Ochi history_search/history_read over controlled original canonical evidence retained before compaction.", "What was the final approved launch cutoff in our older Delta schedule conversation? Find and read original evidence rather than guessing or relying on an incomplete summary; quote the approval and include the source session reference.", e.session(), e.builtins("history_search", "history_read"), nil)
	searched, read := false, false
	for _, step := range history.Tools {
		searched = searched || step.Name == "history_search" && step.Status == "completed"
		read = read || step.Name == "history_read" && step.Status == "completed" && strings.Contains(step.Output, "16:45")
	}
	history.check("actual scoped search then original evidence read succeed", searched && read, "canonical approval remains available despite a compacted continuation summary")
	history.check("answer preserves exact approved cutoff and real session reference", strings.Contains(history.Output, "2027-04-18") && strings.Contains(history.Output, "16:45") && strings.Contains(history.Output, oldSession.ID), "2027-04-18 16:45 Asia/Shanghai; retrieved session ID, not fabricated citation")
	cases = append(cases, history)

	// 4. Commands are simulated here, but repeated-failure stopping is the real
	// production agent loop, including varying bridge-owned timing/log metadata.
	failureCalls := 0
	failureTools := coreEvalTools{definitions: []agent.ToolDefinition{{Name: "exec", Description: "Execute only the requested go test command in the controlled QA environment; no unrelated probing or composite scripts.", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"command":{"type":"string","enum":["go test ./missing-package"]}},"required":["command"]}`)}}, call: func(_ context.Context, _, _ string, _ json.RawMessage) (agent.ToolResult, error) {
		failureCalls++
		output, _ := json.Marshal(map[string]any{"exit_code": 1, "stdout": "", "stderr": "stat /data/fixture/missing-package: directory not found", "cwd": "/data/fixture", "duration_ms": failureCalls * 71, "stdout_path": fmt.Sprintf("/data/logs/qa-%d.out", failureCalls), "stderr_path": fmt.Sprintf("/data/logs/qa-%d.err", failureCalls)})
		return agent.ToolResult{Output: string(output)}, nil
	}}
	failure := e.run("repeated_failure", "Real chat model and real failure/no-progress loop; exec outcomes are explicitly simulated, no shell command is executed. Narrow rerun tightens the controlled tool schema to the exact user-approved command; no unrelated probing/composite script can dispatch.", "Run `go test ./missing-package` until it passes. Retry the exact same command repeatedly if necessary; do not change the command or invent a passing test. If the environment prevents completion, say so clearly.", e.session(), failureTools, nil)
	failedSteps := 0
	for _, step := range failure.Tools {
		if step.Status == "failed" {
			failedSteps++
		}
	}
	failure.check("failed command dispatches are bounded (voluntary model stopping is allowed)", failureCalls >= 1 && failureCalls <= 3 && failedSteps == failureCalls, fmt.Sprintf("controlled failed exec calls=%d", failureCalls))
	if failureCalls < 3 && failure.Status != "not_selected" {
		failure.Boundary += " The model voluntarily stopped before the three-failure cutoff; this attempt does not exercise framework cutoff or varied-output normalization. Those mechanisms require separate engineering evidence."
	}
	lower := strings.ToLower(failure.Output)
	failure.check("answer honestly reports missing package or failed validation", strings.Contains(lower, "not found") || strings.Contains(lower, "missing") || strings.Contains(lower, "fail") || strings.Contains(lower, "does not exist"), "does not equate terminal run state to passing tests")
	failure.check("no unsupported assertion that empty stdout proves absent project/module files", !strings.Contains(lower, "is empty") && !strings.Contains(lower, "no go.mod") && !strings.Contains(lower, "no go source") && !strings.Contains(lower, "no source anywhere"), "only the exact missing-package error was returned; no directory listing or module inspection occurred")
	countsMatch := true
	for count, phrases := range map[int][]string{1: {"1 attempt", "one attempt"}, 2: {"2 attempts", "two attempts", "twice"}, 3: {"3 attempts", "three attempts", "three times"}, 4: {"4 attempts", "four attempts"}} {
		for _, phrase := range phrases {
			if strings.Contains(lower, phrase) && count != failureCalls {
				countsMatch = false
			}
		}
	}
	failure.check("any explicit attempt-count claim agrees with actual dispatched calls", countsMatch, fmt.Sprintf("actual controlled exec dispatches=%d; failed model schema attempts are not command executions", failureCalls))
	cases = append(cases, failure)

	// 5. A single huge return must not require sixteen historical messages before
	// budgeting. The exact full return is checkpointed only in the owned QA DB.
	largeOutput := "CONTROLLED DATASET: validation report.\n" + strings.Repeat("padding-row: no decision; ignore this repetitive filler.\n", 8000) + "\nFINAL VERIFIED VALUES: total_records=4821; failed_records=17; validation_status=FAILED."
	largeTools := coreEvalTools{definitions: []agent.ToolDefinition{{Name: "files_read", Description: "Read the requested file from the controlled QA dataset.", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"path":{"type":"string"}},"required":["path"]}`), Execution: &agent.ToolExecution{ReadOnly: true, ParallelSafe: true}}}, call: func(_ context.Context, _, _ string, _ json.RawMessage) (agent.ToolResult, error) {
		return agent.ToolResult{Output: largeOutput}, nil
	}}
	large := e.run("large_tool_output", "Real chat model and actual context-budget/compaction/checkpoint code; the 440KB file content is controlled synthetic tool evidence, not an actual user file.", "Read `/data/fixture/report.txt` and report its total record count, failed record count, and validation status exactly. Do not claim that a failed validation passed.", e.session(), largeTools, func(config *agent.Config, _ *agent.Request) {
		config.ContextWindow = 20000
		auxiliary := e.config
		auxiliary.Headers = config.Headers
		config.CompactionConfig = &auxiliary
	})
	compacted := len(large.Compactions) > 0
	for _, diagnostic := range large.Diagnostics {
		compacted = compacted || diagnostic.Kind == "context_compacted"
	}
	large.check("one huge return triggers actual safe budgeting and keeps canonical evidence", compacted && large.CanonicalBytes >= len(largeOutput), fmt.Sprintf("controlled original output bytes=%d", len(largeOutput)))
	large.check("actual final answer retains authoritative tail counts/status", strings.Contains(large.Output, "4821") && strings.Contains(large.Output, "17") && strings.Contains(strings.ToLower(large.Output), "failed"), "4821 total; 17 failed; FAILED, not PASS")
	cases = append(cases, large)

	// 6. Force at least two real projection compactions without changing the
	// actual provider/model. Early constraints and later tool facts must survive.
	compactSession := e.session()
	seedRunID := e.newID()
	constraint := "Goal: aggregate controlled QA batches. Must keep the marker CEDAR-41. Do not access the network and do not create files. Final output must be only JSON with keys marker, count, risk."
	seedSnapshot, _, err := store.CreateConfiguredRun(context.Background(), user.ID, compactSession.ID, constraint, seedRunID, model, "", "", nil)
	if err != nil {
		t.Fatal("could not seed controlled early constraints")
	}
	for i := 0; i < 4; i++ {
		payload, _ := json.Marshal(map[string]string{"role": "assistant", "content": strings.Repeat("Historical scratch note; it is not a new user instruction. ", 300)})
		canonical := agent.CanonicalMessage{ModelID: model.ID, ProviderID: model.ProviderID, Payload: payload}
		if err := store.AppendCanonical(context.Background(), compactSession.ID, seedRunID, &canonical); err != nil {
			t.Fatal("could not seed controlled long history")
		}
	}
	seedSnapshot.Status, seedSnapshot.Output = runtime.StatusCompleted, "Awaiting the actual batch analysis request."
	if err := store.CompleteRun(context.Background(), seedSnapshot); err != nil {
		t.Fatal("could not complete controlled constraint history")
	}
	batches := map[string]int{"A": 11, "B": 13, "C": 17}
	seen := map[string]bool{}
	batchTools := coreEvalTools{definitions: []agent.ToolDefinition{{Name: "qa_read_batch", Description: "Read one controlled batch; A, B, C are required in order. Returns an exact count and risk flag.", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"batch":{"type":"string","enum":["A","B","C"]}},"required":["batch"]}`), Execution: &agent.ToolExecution{ReadOnly: true}}}, call: func(_ context.Context, _, _ string, args json.RawMessage) (agent.ToolResult, error) {
		var input struct {
			Batch string `json:"batch"`
		}
		if json.Unmarshal(args, &input) != nil || batches[input.Batch] == 0 {
			return agent.ToolResult{}, errors.New("unknown controlled batch")
		}
		seen[input.Batch] = true
		output := fmt.Sprintf("BATCH=%s COUNT=%d RISK=none\n", input.Batch, batches[input.Batch]) + strings.Repeat("controlled filler; no additional evidence. ", 650) + fmt.Sprintf("\nFINAL BATCH=%s COUNT=%d RISK=none", input.Batch, batches[input.Batch])
		return agent.ToolResult{Output: output}, nil
	}}
	repeated := e.run("repeated_compaction_constraints", "Real chat model plus real auxiliary compaction on the same authorized model. A reduced 26K local context budget is intentional pressure; batch outcomes and long prior history are controlled fixtures.", "Continue the controlled batch task. Read A, then B, then C, using one tool call per batch in order. Sum their counts and apply the marker, safety and final-format constraints from our earlier user message.", compactSession, batchTools, func(config *agent.Config, _ *agent.Request) {
		config.ContextWindow = 26000
		auxiliary := e.config
		auxiliary.Headers = config.Headers
		config.CompactionConfig = &auxiliary
	})
	compactionCount, fallbackCount := 0, 0
	for _, diagnostic := range repeated.Diagnostics {
		if diagnostic.Kind == "context_compacted" {
			compactionCount++
		}
		if diagnostic.Kind == "compaction_fallback" {
			fallbackCount++
		}
	}
	repeated.check("at least two real compactions occur, not merely a static summary fixture", compactionCount >= 2 && len(repeated.Compactions) >= 2, fmt.Sprintf("actual compactions=%d; deterministic fallbacks=%d", compactionCount, fallbackCount))
	var answer struct {
		Marker string `json:"marker"`
		Count  int    `json:"count"`
		Risk   string `json:"risk"`
	}
	jsonErr := json.Unmarshal([]byte(strings.TrimSpace(repeated.Output)), &answer)
	repeated.check("after compaction actual answer keeps early marker/JSON constraint and later count", jsonErr == nil && answer.Marker == "CEDAR-41" && answer.Count == 41 && answer.Risk == "none" && seen["A"] && seen["B"] && seen["C"], "only JSON; marker CEDAR-41; count 41; risk none; no network/write tool is available")
	cases = append(cases, repeated)

	cases = append(cases, e.permissionRevokeCase(), e.immutableArtifactCase())
	if err := writeCoreEvaluation(outputDir, authorized.Model, cases, only != ""); err != nil {
		t.Fatal("could not save sanitized real evaluation evidence")
	}
	for _, item := range cases {
		if item.Status == "failed" {
			t.Errorf("real evaluation case %s failed; inspect core-flow-real-evaluation.json in OCHI_EVALUATION_OUTPUT", item.ID)
		}
	}
}

func writeCoreEvaluation(outputDir, model string, cases []coreEvalCase, merge bool) error {
	if !merge {
		_, err := os.Stat(filepath.Join(outputDir, "core-flow-real-evaluation.json"))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		merge = err == nil
	}
	if merge {
		var baseline struct {
			Cases []coreEvalCase `json:"cases"`
		}
		data, err := os.ReadFile(filepath.Join(outputDir, "core-flow-real-evaluation.json"))
		if err != nil || json.Unmarshal(data, &baseline) != nil {
			return errors.New("sanitized baseline evidence is required for narrow reevaluation")
		}
		for _, current := range cases {
			if len(current.ModelRequests) == 0 {
				continue
			}
			replaced := false
			for index, previous := range baseline.Cases {
				if previous.ID != current.ID {
					continue
				}
				current.PriorAttempts = append(current.PriorAttempts, flattenCoreEvalAttempts(previous)...)
				baseline.Cases[index] = current
				replaced = true
				break
			}
			if !replaced {
				baseline.Cases = append(baseline.Cases, current)
			}
		}
		cases = baseline.Cases
	}
	mainTasks := 0
	for index := range cases {
		item := &cases[index]
		flattened := []coreEvalCase{}
		for _, previous := range item.PriorAttempts {
			flattened = append(flattened, flattenCoreEvalAttempts(previous)...)
		}
		item.PriorAttempts = flattened
		if len(item.ModelRequests) > 0 {
			mainTasks++
		}
		for _, previous := range item.PriorAttempts {
			if len(previous.ModelRequests) > 0 {
				mainTasks++
			}
		}
	}
	report := struct {
		CreatedAt     time.Time      `json:"created_at"`
		PromptVersion string         `json:"prompt_version"`
		Model         string         `json:"actual_model"`
		Protocol      string         `json:"protocol"`
		MainTasks     int            `json:"main_model_tasks"`
		Safety        string         `json:"safety_boundary"`
		Cases         []coreEvalCase `json:"cases"`
	}{CreatedAt: time.Now().UTC(), PromptVersion: agent.PromptVersion, Model: model, Protocol: "openai", MainTasks: mainTasks,
		Safety: "Explicitly configured real-model inference only; no production database Open/migrations/writes/restarts, no other-user transcript reads. All persisted fixture data belongs to a disposable ochi_process_qa schema. Exact configured provider/model, no model fallback. Unknown usage/cache fields remain unavailable, not zero. Public model output is real; synthetic tools are identified per case.", Cases: cases}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outputDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outputDir, "core-flow-real-evaluation.json"), append(data, '\n'), 0600); err != nil {
		return err
	}
	var text strings.Builder
	fmt.Fprintf(&text, "# Core Flow Real-Model Evaluation\n\nRun: %s\n\nModel: `%s` (OpenAI-compatible; no fallback). Latest prompt version: `%s`; actual version recorded per case. Eight fixed user tasks plus narrow reevaluations (%d main task attempts total) and necessary auxiliary compaction calls.\n\n", report.CreatedAt.Format(time.RFC3339), model, agent.PromptVersion, mainTasks)
	text.WriteString("This is a fixed controlled-corpus smoke evaluation, not a general AGI or statistical quality benchmark. Real model output is recorded separately from engineered tool evidence. Production storage, services, configuration and other users are untouched.\n\n")
	text.WriteString("| Case | Result | Time | Inference Requests |\n|---|---|---:|---:|\n")
	for _, item := range cases {
		fmt.Fprintf(&text, "| %s | %s | %d ms | %d |\n", item.ID, item.Status, item.ElapsedMS, len(item.ModelRequests))
	}
	for _, item := range cases {
		fmt.Fprintf(&text, "\n## %s\n\nPrompt version: `%s`. Evidence: %s\n\n", item.ID, item.PromptVersion, item.Boundary)
		if item.Prompt != "" {
			fmt.Fprintf(&text, "User request:\n\n> %s\n\n", strings.ReplaceAll(item.Prompt, "\n", "\n> "))
		}
		for _, check := range item.Checks {
			state := "FAIL"
			if check.Passed {
				state = "PASS"
			}
			fmt.Fprintf(&text, "- %s: %s", state, check.Criterion)
			if check.Detail != "" {
				fmt.Fprintf(&text, " (%s)", check.Detail)
			}
			text.WriteByte('\n')
		}
		if item.Error != "" {
			fmt.Fprintf(&text, "\nExecution error: %s\n", item.Error)
		}
		if item.Output != "" {
			fmt.Fprintf(&text, "\nActual public model output:\n\n```text\n%s\n```\n", item.Output)
		}
		for _, file := range item.Artifacts {
			fmt.Fprintf(&text, "\nAuthenticated artifact `%s`, version %d: %d bytes, SHA256 `%s`; actual model-facing URL `%s`.\n", file.ID, file.Version, file.Bytes, file.SHA256, file.URL)
		}
		for index, request := range item.ModelRequests {
			kind, usage := "main", "usage unavailable"
			if !request.Streaming {
				kind = "auxiliary compaction"
			}
			if request.Usage != nil {
				cached := "unavailable"
				if request.Usage.CachedTokens != nil {
					cached = fmt.Sprint(*request.Usage.CachedTokens)
				}
				usage = fmt.Sprintf("prompt=%d completion=%d total=%d cached=%s", request.Usage.PromptTokens, request.Usage.CompletionTokens, request.Usage.TotalTokens, cached)
			}
			fmt.Fprintf(&text, "\nRequest %d (%s): HTTP %d, %d ms; %s.\n", index+1, kind, request.HTTPStatus, request.ElapsedMS, usage)
		}
		for _, previous := range item.PriorAttempts {
			fmt.Fprintf(&text, "\nPrior attempt retained: %s, prompt `%s`, %d ms.\n", previous.Status, previous.PromptVersion, previous.ElapsedMS)
			for _, check := range previous.Checks {
				if !check.Passed {
					fmt.Fprintf(&text, "- Prior FAIL: %s (%s)\n", check.Criterion, check.Detail)
				}
			}
			fmt.Fprintf(&text, "\nPrior actual public output (not discarded):\n\n```text\n%s\n```\n", previous.Output)
		}
	}
	text.WriteString("\n## Limits\n\n- Controlled user/history corpus; semantic relevance across arbitrary real history, paraphrase forgetting, automatic method correctness and persistent skill learning are not proven.\n- Topic recall uses deliberately unavailable fixture embeddings and actual lexical fallback; this does not evaluate a real embedding model.\n- Large output and failure tool results are synthetic. They exercise actual model decisions and production loop/context code, not real shell/files/network reliability.\n- Permission revoke exercises real Ochi authorization and authenticated HTTP against a controlled cancellable operation, not an actual logged-in browser or Docker computer. Artifact delivery uses physical temporary files and real Ochi publish/storage/download APIs, not the deployed workspace.\n- Shared logical inference budget includes auxiliary compaction and reserves a final answer; bounded transport retries are separate. This is not an absolute network-request or token cap.\n- Eight tasks are a bounded regression baseline, not enough to claim universally correct or perfect behavior.\n")
	return os.WriteFile(filepath.Join(outputDir, "core-flow-real-evaluation.md"), []byte(text.String()), 0600)
}

func TestCoreEvaluationReportKeepsNewCasesAndPriorFailures(t *testing.T) {
	outputDir := t.TempDir()
	caseIDs := []string{"topic_shift", "preference_correction", "original_history_evidence", "repeated_failure", "large_tool_output", "repeated_compaction_constraints"}
	var baseline []coreEvalCase
	for _, id := range caseIDs {
		baseline = append(baseline, coreEvalCase{ID: id, PromptVersion: "prior-fixture-version", Status: "failed", Output: "original " + id, Checks: []coreEvalCheck{{Criterion: "retained failure", Passed: false}}, ModelRequests: []coreEvalModelRequest{{Model: "synthetic-writer-fixture", HTTPStatus: 200}}})
	}
	if err := os.MkdirAll(outputDir, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"cases": baseline})
	if err := os.WriteFile(filepath.Join(outputDir, "core-flow-real-evaluation.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	current := []coreEvalCase{}
	for _, id := range []string{"topic_shift", "permission_revoke", "immutable_artifact_delivery"} {
		current = append(current, coreEvalCase{ID: id, PromptVersion: agent.PromptVersion, Status: "passed", Output: "current " + id, ModelRequests: []coreEvalModelRequest{{Model: "synthetic-writer-fixture", HTTPStatus: 200}}})
	}
	current = append(current, coreEvalCase{ID: "not_selected_placeholder", Status: "not_selected"})
	if err := writeCoreEvaluation(outputDir, "synthetic-writer-fixture", current, true); err != nil {
		t.Fatal(err)
	}
	read := func() ([]coreEvalCase, int) {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(outputDir, "core-flow-real-evaluation.json"))
		var report struct {
			Cases     []coreEvalCase `json:"cases"`
			MainTasks int            `json:"main_model_tasks"`
		}
		if err != nil || json.Unmarshal(data, &report) != nil {
			t.Fatal("could not read controlled evaluation report")
		}
		return report.Cases, report.MainTasks
	}
	merged, attempts := read()
	if len(merged) != 8 || attempts != 9 {
		t.Fatalf("new task types lost or placeholders counted: cases=%d attempts=%d", len(merged), attempts)
	}
	old := merged[0].PriorAttempts
	if merged[0].Output != current[0].Output || len(old) != 1 || old[0].Output != baseline[0].Output || old[0].Status != "failed" || old[0].Checks[0].Passed || old[0].PromptVersion != "prior-fixture-version" {
		t.Fatal("narrow update rewrote or lost historical failed evidence")
	}
	for index := 1; index < len(caseIDs); index++ {
		if merged[index].ID != baseline[index].ID || merged[index].Output != baseline[index].Output || merged[index].Status != "failed" {
			t.Fatal("narrow update changed an unselected case")
		}
	}
	for index := range merged {
		merged[index].PriorAttempts = nil
		merged[index].Output = "full rerun " + merged[index].ID
	}
	if err := writeCoreEvaluation(outputDir, "synthetic-writer-fixture", merged, false); err != nil {
		t.Fatal(err)
	}
	merged, attempts = read()
	if len(merged) != 8 || attempts != 17 || len(merged[0].PriorAttempts) != 2 || merged[0].PriorAttempts[0].Output != baseline[0].Output || merged[0].PriorAttempts[0].Status != "failed" {
		t.Fatal("full rerun did not retain flattened prior failure history")
	}
}

func flattenCoreEvalAttempts(item coreEvalCase) []coreEvalCase {
	items := []coreEvalCase{}
	for _, previous := range item.PriorAttempts {
		items = append(items, flattenCoreEvalAttempts(previous)...)
	}
	item.PriorAttempts = nil
	return append(items, item)
}
