package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"

	"github.com/jackc/pgx/v5"
)

func TestEmbeddingBatchHasOneFiniteDimensionAndExactCount(t *testing.T) {
	for _, test := range []struct {
		vectors [][]float32
		count   int
	}{
		{nil, 1}, {[][]float32{{1, 2}}, 2}, {[][]float32{{1, 2}, {3}}, 2}, {[][]float32{{0, 0}}, 1}, {[][]float32{{float32(math.NaN())}}, 1}, {[][]float32{{float32(math.Inf(-1))}}, 1},
	} {
		if _, err := validateEmbeddingBatch(test.vectors, test.count); err == nil {
			t.Fatal("accepted invalid batch")
		}
	}
	if dims, err := validateEmbeddingBatch([][]float32{{1, 2}, {2, 1}}, 2); err != nil || dims != 2 {
		t.Fatal("valid embedding batch rejected")
	}
}

func TestMemoryExtractionDoesNotPromoteToolClaimsOrUnsupportedCorrections(t *testing.T) {
	if !errors.Is(memorySourceError(pgx.ErrNoRows), storage.ErrMemorySource) || !errors.Is(memorySourceError(context.DeadlineExceeded), context.DeadlineExceeded) {
		t.Fatal("transient source lookup errors were made permanently unextractable")
	}
	prompt := "I prefer concise responses. This is a one-off test."
	result := memoryExtraction{Facts: []extractedFact{
		{Kind: "preference", Content: "prefers concise replies", Excerpt: "I prefer concise responses.", Scope: "user"},
		{Kind: "fact", Content: "has a daughter", Excerpt: "assistant guessed this", Scope: "user"},
		{ID: "foreign-id", Kind: "preference", Content: "likes verbosity", Excerpt: "This is a one-off test.", Scope: "user"},
		{Kind: "preference", Content: "project-only", Excerpt: "I prefer concise responses.", Scope: "project"},
		{Kind: "fact", Content: "API_KEY=sk-private123456789012", Excerpt: "This is a one-off test.", Scope: "user"},
	}, Summary: "verified answer", Methods: []extractedMethod{{Content: "unverified fix", EvidenceStepIDs: []string{"not-a-check"}}, {Content: "masked failure", EvidenceStepIDs: []string{"masked-check"}}, {Content: "tested workflow", EvidenceStepIDs: []string{"real-check"}}}}
	steps := []runtime.Step{
		{ID: "not-a-check", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"echo test success"}`), Output: `{"exit_code":0,"stdout":"test success"}`},
		{ID: "real-check", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./..."}`), Output: `{"exit_code":0,"stdout":"ok fixture"}`},
		{ID: "failed-check", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./..."}`), Output: `{"exit_code":1,"stdout":"FAIL"}`},
		{ID: "masked-check", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./...; echo success"}`), Output: `{"exit_code":0,"stdout":"FAIL\nsuccess"}`},
	}
	for i, command := range []string{"go test -help", "pytest --version", "pytest -V", "cargo test --help", "go test -list=.", "pytest --collect-only", "cargo test --no-run", "pnpm test --dry-run", "go test '--help'", "pnpm test --listTests"} {
		args, _ := json.Marshal(map[string]string{"command": command})
		id := fmt.Sprintf("informational-%d", i)
		steps = append(steps, runtime.Step{ID: id, Name: "exec", Status: "completed", Arguments: args, Output: `{"exit_code":0,"stdout":"usage or metadata only"}`})
		result.Methods = append(result.Methods, extractedMethod{Content: "not an actual successful check", EvidenceStepIDs: []string{id}})
	}
	for i, output := range []string{`{"exit_code":0,"stdout":"ok","isError":true}`, `{"exit_code":0,"stdout":"ok","error":"structured failure"}`, `{"exit_code":0,"stdout":"no test files"}`} {
		id := fmt.Sprintf("non-proof-%d", i)
		steps = append(steps, runtime.Step{ID: id, Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./..."}`), Output: output})
		result.Methods = append(result.Methods, extractedMethod{Content: "not successful check evidence", EvidenceStepIDs: []string{id}})
	}
	bounded := boundedMemoryExtraction(result, prompt, "", nil, steps)
	if len(bounded.Facts) != 1 || len(bounded.Methods) != 1 || bounded.Methods[0].Content != "tested workflow" {
		t.Fatalf("unsupported memory promoted: %+v", bounded)
	}
	forgotten := boundedMemoryExtraction(result, "Please forget this preference", "", nil, steps)
	if len(forgotten.Facts) > 0 || forgotten.Summary != "" || len(forgotten.Methods) > 0 {
		t.Fatal("forget request was automatically re-summarized")
	}
}

func TestCoreMemoryEmbeddingRecallAndDurableWorkerIntegration(t *testing.T) {
	store := searchIntegrationStore(t)
	s, err := NewServer(store, nil, []Account{{Username: "memory-api-qa", Password: "fixture-only-memory-password", Role: "admin"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	user, err := store.GetUser(ctx, "memory-api-qa")
	if err != nil {
		t.Fatal(err)
	}
	var embeddingCalls, extractionCalls, maximumBatch atomic.Int32
	var embeddingFailure atomic.Bool
	var dimensions atomic.Int32
	dimensions.Store(2)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/embeddings" {
			embeddingCalls.Add(1)
			if embeddingFailure.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":"PRIVATE_PROVIDER_ERROR_BODY"}`))
				return
			}
			var request struct {
				Input []string `json:"input"`
				Model string   `json:"model"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.Model != "fixture-embedding" {
				t.Error("embedding kind did not reach configured provider")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for old := maximumBatch.Load(); int32(len(request.Input)) > old; old = maximumBatch.Load() {
				if maximumBatch.CompareAndSwap(old, int32(len(request.Input))) {
					break
				}
			}
			rows := []map[string]any{}
			for i := len(request.Input) - 1; i >= 0; i-- {
				v := make([]float32, int(dimensions.Load()))
				for j := range v {
					v[j] = float32(j + 1)
				}
				rows = append(rows, map[string]any{"index": i, "embedding": v})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
			return
		}
		if r.URL.Path == "/chat/completions" {
			extractionCalls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"facts":[{"kind":"preference","content":"Prefers precise replies","excerpt":"I prefer precise replies.","scope":"user"}],"summary":"Remembered an explicitly stated response preference","project_summary":"","methods":[]}`}}}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(provider.Close)
	p, err := store.SaveProvider(ctx, storage.Provider{Name: "Memory controlled fixture", Protocol: "openai", BaseURL: provider.URL, Enabled: true, AllowNoKey: true})
	if err != nil {
		t.Fatal(err)
	}
	embedding, err := store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Embedding", Model: "fixture-embedding", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Chat", Model: "fixture-chat", Kind: "chat", Enabled: true, Available: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, err := store.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings.EmbeddingModelID, settings.MemoryModelID = embedding.ID, chat.ID
	if err = store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	vectors, identity, err := s.embeddingVectors(ctx, embedding.ID, []string{"first", "second"})
	if err != nil || identity != embedding.ID || len(vectors) != 2 || len(vectors[0]) != 2 {
		t.Fatalf("external embedding configuration remains broken: %v", err)
	}
	if _, _, err = s.embeddingVectors(ctx, chat.ID, []string{"wrong slot"}); err == nil {
		t.Fatal("chat kind accepted as embedding")
	}
	dimensions.Store(3)
	if _, _, err = s.embeddingVectors(ctx, embedding.ID, []string{"changed dimensions"}); err == nil {
		t.Fatal("external provider changed dimensions silently")
	}
	dimensions.Store(2)
	for _, m := range []storage.Memory{{Content: "Keep answers concise", Kind: "preference", Source: "user"}, {Content: "alpha-only coding plan", Kind: "session_summary", Source: "user"}, {Content: "beta-only travel plan", Kind: "session_summary", Source: "user"}} {
		if _, err = store.SaveMemoryRecord(ctx, user.ID, m); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 83; i++ {
		if _, err = store.SaveMemoryRecord(ctx, user.ID, storage.Memory{Content: fmt.Sprintf("Backlog indexing fixture %d", i), Kind: "session_summary", Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	session, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	embeddingFailure.Store(true)
	first, diagnostics, err := s.memoryContextWithDiagnostics(ctx, user.ID, "", session.ID, "alpha coding")
	if err != nil || !strings.Contains(first, "alpha-only coding plan") {
		t.Fatalf("first turn recall failed: %v", err)
	}
	if len(diagnostics) != 2 || diagnostics[0].Kind != "embedding_unavailable" || diagnostics[1].Kind != "lexical_fallback" {
		t.Fatal("embedding degradation remained invisible before run admission")
	}
	second, err := s.memoryContext(ctx, user.ID, "", session.ID, "beta travel")
	if err != nil || !strings.Contains(second, "beta-only travel plan") || strings.Contains(second, "alpha-only coding plan") || !strings.Contains(second, "Keep answers concise") {
		t.Fatalf("dynamic recall remained frozen on first query: %v", err)
	}
	embeddingFailure.Store(false)
	const runID = "55555555-aaaa-4555-8555-555555555555"
	snapshot, _, err := store.CreateConfiguredRun(ctx, user.ID, session.ID, "I prefer precise replies.", runID, chat, "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	embeddingFailure.Store(true)
	searchCtx := agent.WithRunScope(ctx, agent.RunScope{UserID: user.ID, SessionID: session.ID, RunID: runID})
	searchResult, err := s.memoryTool(searchCtx, user.ID, "memory_search", json.RawMessage(`{"query":"beta travel"}`))
	var recalled storage.MemoryRecallResult
	if err != nil || json.Unmarshal([]byte(searchResult.Output), &recalled) != nil || !recalled.Status.Degraded || !slices.Contains(recalled.Status.Events, "embedding_unavailable") || !slices.Contains(recalled.Status.Events, "lexical_fallback") {
		t.Fatalf("memory tool hid embedding degradation: %v", err)
	}
	ownedDiagnostics, err := store.Diagnostics(ctx, user.ID, runID)
	if err != nil || len(ownedDiagnostics) != 2 {
		t.Fatalf("owned run did not persist recall categories: %v", err)
	}
	encodedDiagnostics, _ := json.Marshal(ownedDiagnostics)
	if strings.Contains(string(encodedDiagnostics), "PRIVATE_PROVIDER_ERROR_BODY") {
		t.Fatal("provider error body leaked to run diagnostics")
	}
	embeddingFailure.Store(false)
	snapshot.Status, snapshot.Output = runtime.StatusCompleted, "Noted."
	if err = store.CompleteRun(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if err = store.EnqueueMemoryJob(ctx, runID); err != nil {
		t.Fatal(err)
	}
	s.StartMemoryWorker(context.Background())
	s.StartMemoryWorker(context.Background())
	deadline := time.Now().Add(8 * time.Second)
	for {
		jobs, err := store.MemoryJobs(ctx, user.ID)
		if err != nil {
			t.Fatal(err)
		}
		indexJob, indexErr := store.MemoryIndexJobStatus(ctx, user.ID)
		if len(jobs) > 0 && jobs[0].Status == "completed" && indexErr == nil && indexJob != nil && indexJob.Status == "completed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("durable worker did not finish: %+v", jobs)
		}
		time.Sleep(30 * time.Millisecond)
	}
	items, err := store.ScopedMemories(ctx, user.ID, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range items {
		if m.Content == "Prefers precise replies" {
			found = m.Trust == "user_statement" && m.SourceRunID == runID && m.HasEmbedding
		}
	}
	if !found || extractionCalls.Load() != 1 || embeddingCalls.Load() < 3 {
		t.Fatal("durable extraction lost user evidence, indexing, or exactly-once cached model output")
	}
	if len(items) != 88 || maximumBatch.Load() != 40 {
		t.Fatalf("fixture worker did not process more than two bounded batches: records=%d max=%d", len(items), maximumBatch.Load())
	}
	for _, m := range items {
		if !m.HasEmbedding {
			t.Fatal("worker completed extraction but abandoned the indexing backlog")
		}
	}
	if _, exists, err := store.FrozenMemoryContext(ctx, user.ID, session.ID); err != nil || exists {
		t.Fatal("new authoritative user preference left the stable profile permanently stale")
	}
	var preferenceID string
	for _, m := range items {
		if m.Content == "Keep answers concise" {
			preferenceID = m.ID
		}
	}
	const correctionRun = "66666666-aaaa-4666-8666-666666666666"
	const correction = "Actually I now prefer detailed replies."
	if _, _, err = store.CreateConfiguredRun(ctx, user.ID, session.ID, correction, correctionRun, chat, "", "", nil); err != nil {
		t.Fatal(err)
	}
	scopeCtx := agent.WithRunScope(ctx, agent.RunScope{UserID: user.ID, SessionID: session.ID, RunID: correctionRun})
	args, _ := json.Marshal(map[string]string{"id": preferenceID, "content": "Prefers detailed replies", "excerpt": correction})
	if _, err = s.memoryTool(scopeCtx, user.ID, "memory_save", args); err != nil {
		t.Fatalf("agent could not correct a preference lifecycle: %v", err)
	}
	items, err = store.ScopedMemories(ctx, user.ID, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, m := range items {
		if m.ID == preferenceID {
			t.Fatal("superseded preference remained active")
		}
		if m.Content == "Prefers detailed replies" {
			found = m.Kind == "preference" && m.Trust == "user_statement"
		}
	}
	if !found {
		t.Fatal("correction did not preserve preference lifecycle and user provenance")
	}
}
