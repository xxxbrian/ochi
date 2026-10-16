package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func coreMemoryEmbeddingFixture(t *testing.T, f coreHTTPFixture) (storage.Model, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/embeddings" {
			calls.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"PRIVATE_RECALL_PROVIDER_BODY"}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Controlled memory fixture"}}]}`))
	}))
	t.Cleanup(provider.Close)
	ctx := context.Background()
	p, err := f.server.store.SaveProvider(ctx, storage.Provider{Name: "Boundary memory fixture", Protocol: "openai", BaseURL: provider.URL, Enabled: true, AllowNoKey: true})
	if err != nil {
		t.Fatal(err)
	}
	embedding, err := f.server.store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Embedding", Model: "fixture-embedding", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := f.server.store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Chat", Model: "fixture-chat", Kind: "chat", Available: true, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := f.server.store.Settings(ctx)
	settings.EmbeddingModelID = embedding.ID
	if err := f.server.store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	return chat, calls
}

type coreMemoryRequestCapture struct{ requests chan agent.Request }

func (capture coreMemoryRequestCapture) Generate(ctx context.Context, request agent.Request, _ func(agent.Update) error) error {
	select {
	case capture.requests <- request:
	case <-ctx.Done():
		return ctx.Err()
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestCoreMemoryStartQueuedPersistsRecallDiagnostics(t *testing.T) {
	f := newCoreHTTPFixture(t)
	model, calls := coreMemoryEmbeddingFixture(t, f)
	ctx := context.Background()
	session, err := f.server.store.CreateSession(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "alpha-only task evidence", Kind: "session_summary", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	capture := coreMemoryRequestCapture{requests: make(chan agent.Request, 1)}
	f.server.agent = capture
	const runID = "88888888-aaaa-4888-8888-888888888888"
	if _, err := f.server.startQueuedRun(ctx, f.owner, session.ID, runID, "alpha task", model.ID, "", nil); err != nil {
		t.Fatal(err)
	}
	var request agent.Request
	select {
	case request = <-capture.requests:
	case <-time.After(5 * time.Second):
		t.Fatal("actual configured run did not reach the capture generator")
	}
	if request.AtBoundary == nil || !strings.Contains(request.Config.MemoryContext, "alpha-only task evidence") || calls.Load() != 1 {
		t.Fatal("initial queued-run recall or boundary callback missing")
	}
	data := f.request(t, f.token, http.MethodGet, "/api/runs/"+runID+"/diagnostics", "", http.StatusOK)
	if !strings.Contains(string(data), "embedding_unavailable") || !strings.Contains(string(data), "lexical_fallback") || strings.Contains(string(data), "PRIVATE_RECALL_PROVIDER_BODY") {
		t.Fatal("initial pre-admission recall diagnostics were missing or leaked provider content")
	}
	off := false
	if _, err := f.server.store.PatchPreferences(ctx, f.owner, &off, nil); err != nil {
		t.Fatal(err)
	}
	update, err := request.AtBoundary(ctx)
	if err != nil || update.MemoryContext == nil || *update.MemoryContext != "" || calls.Load() != 1 {
		t.Fatal("configureRunContext replaced startup memory state or disabled context was retained")
	}
}

func TestCoreMemoryBoundaryInvalidationAndSteering(t *testing.T) {
	f := newCoreHTTPFixture(t)
	_, calls := coreMemoryEmbeddingFixture(t, f)
	ctx := context.Background()
	stable, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "Stable concise preference", Kind: "preference", Source: "user"})
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"alpha-only task evidence", "beta-only travel evidence"} {
		if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: content, Kind: "session_summary", Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	request := agent.Request{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, Scope: agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, ComputeOnly: true}, Config: &agent.Config{}}
	state := f.server.memoryBoundaryState(ctx, request)
	request.Config.MemoryContext, _, err = f.server.memoryContextWithDiagnostics(ctx, f.owner, "", f.session.ID, "alpha task")
	if err != nil || !strings.Contains(request.Config.MemoryContext, "alpha-only task evidence") {
		t.Fatal("initial related context missing")
	}
	request.AtBoundary = func(ctx context.Context) (agent.BoundaryUpdate, error) {
		return f.server.runBoundaryWithMemory(ctx, request, state)
	}
	f.server.configureRunContext(&request)
	for i := 0; i < 4; i++ {
		update, err := request.AtBoundary(ctx)
		if err != nil || update.MemoryContext != nil || calls.Load() != 1 {
			t.Fatal("steady tool boundaries repeated embedding or replaced valid context")
		}
	}
	stable.Content = "Stable detailed preference"
	if stable, err = f.server.store.SaveMemoryRecord(ctx, f.owner, stable); err != nil {
		t.Fatal(err)
	}
	update, err := request.AtBoundary(ctx)
	if err != nil || update.MemoryContext == nil || !strings.Contains(*update.MemoryContext, stable.Content) || strings.Contains(*update.MemoryContext, "alpha-only") || strings.Contains(*update.MemoryContext, "Stable concise") || calls.Load() != 1 {
		t.Fatal("edit without steering left old stable/related context")
	}
	if err := f.server.store.DeleteMemory(ctx, f.owner, stable.ID); err != nil {
		t.Fatal(err)
	}
	update, err = request.AtBoundary(ctx)
	if err != nil || update.MemoryContext == nil || *update.MemoryContext != "" || calls.Load() != 1 {
		t.Fatal("delete without steering left old personal facts")
	}
	off, on := false, true
	if _, err := f.server.store.PatchPreferences(ctx, f.owner, &off, nil); err != nil {
		t.Fatal(err)
	}
	update, err = request.AtBoundary(ctx)
	if err != nil || update.MemoryContext == nil || *update.MemoryContext != "" || calls.Load() != 1 {
		t.Fatal("disable without steering retained related recall")
	}
	if _, err := f.server.store.PatchPreferences(ctx, f.owner, &on, nil); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(200 * time.Millisecond)
	if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "expiring task evidence", Kind: "session_summary", Source: "user", ExpiresAt: &expires}); err != nil {
		t.Fatal(err)
	}
	state = f.server.memoryBoundaryState(ctx, request)
	memory, _, err := f.server.memoryContextWithDiagnostics(ctx, f.owner, "", f.session.ID, "expiring task")
	if err != nil || !strings.Contains(memory, "expiring task evidence") || calls.Load() != 2 {
		t.Fatal("initial expiring related recall missing")
	}
	time.Sleep(time.Until(expires) + 20*time.Millisecond)
	update, err = request.AtBoundary(ctx)
	if err != nil || update.MemoryContext == nil || strings.Contains(*update.MemoryContext, "expiring task evidence") || calls.Load() != 2 {
		t.Fatal("related expiry without steering retained expired context or embedded again")
	}
	if _, err := f.server.store.AcceptInstruction(ctx, f.owner, f.run.RunID, "boundary-steering-key", "Switch to beta travel"); err != nil {
		t.Fatal(err)
	}
	update, err = request.AtBoundary(ctx)
	if err != nil || len(update.Messages) != 1 || update.MemoryContext == nil || !strings.Contains(*update.MemoryContext, "beta-only travel evidence") || strings.Contains(*update.MemoryContext, "alpha-only") || calls.Load() != 3 {
		t.Fatal("safe steering did not independently recall the new topic exactly once")
	}
	if next, err := request.AtBoundary(ctx); err != nil || len(next.Messages) != 0 || next.MemoryContext != nil || calls.Load() != 3 {
		t.Fatal("accepted steering or embedding replayed at the next tool boundary")
	}
	data, err := f.server.store.Diagnostics(ctx, f.owner, f.run.RunID)
	encoded, _ := json.Marshal(data)
	if err != nil || !strings.Contains(string(encoded), "memory_context_invalidated") || !strings.Contains(string(encoded), "embedding_unavailable") || !strings.Contains(string(encoded), "lexical_fallback") || strings.Contains(string(encoded), "PRIVATE_RECALL_PROVIDER_BODY") {
		t.Fatal("boundary and steering categories were not safely recorded")
	}
}
