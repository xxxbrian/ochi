package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func TestProviderDebugLiveSwitchCapturesExistingConfigAndAuxiliaryScope(t *testing.T) {
	f := newCoreHTTPFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("X-Request-ID", "fixture-request")
		if body.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fixture answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		} else {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"Fixture title"},"finish_reason":"stop"}]}`)
		}
	}))
	defer upstream.Close()
	ctx := context.Background()
	scope := agent.RunScope{RunID: f.run.RunID, SessionID: f.session.ID, UserID: f.owner}
	config := f.server.modelConfig(ctx, storage.Model{Model: "fixture"}, storage.Provider{BaseURL: upstream.URL, APIKey: "fixture-secret-key"}, "", storage.Settings{})
	g, err := agent.NewOpenAI(*config)
	if err != nil {
		t.Fatal(err)
	}
	generate := func() {
		t.Helper()
		err := g.Generate(agent.WithRunScope(ctx, scope), agent.Request{Scope: scope, Messages: []agent.Message{{Role: "user", Content: "fixture prompt"}}}, func(agent.Update) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
	}
	page := func() storage.ProviderTracePage {
		t.Helper()
		v, err := f.server.store.ListProviderTraces(ctx, f.run.RunID, 30, 0)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	generate()
	if page().Total != 0 {
		t.Fatal("debug-off inference created detailed records")
	}
	f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", `{"debug_mode":true}`, http.StatusOK)
	generate()
	auxctx := agent.WithProviderTracePurpose(agent.WithRunScope(ctx, scope), "title")
	if _, err := agent.Complete(auxctx, *config, "Synthetic title policy", "fixture", 64); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for page().Total != 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	items := page().Items
	if len(items) != 2 {
		t.Fatalf("live switch missed detailed model requests: got %d", len(items))
	}
	seen := map[string]bool{}
	for _, item := range items {
		seen[item.Purpose] = true
		if item.RunID != f.run.RunID || item.SessionID != f.session.ID || item.RequestID != "fixture-request" || item.StatusCode != 200 {
			t.Fatalf("captured request lost owner scope or transport metadata: %+v", item)
		}
		full, err := f.server.store.ProviderTrace(ctx, f.run.RunID, item.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(full)
		if err != nil || strings.Contains(string(data), "fixture-secret-key") || !strings.Contains(full.RequestBody, "fixture") {
			t.Fatal("debug record leaked credentials or lost request input")
		}
	}
	if !seen["chat"] || !seen["title"] {
		t.Fatalf("auxiliary purpose was not preserved: %v", seen)
	}
	f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", `{"debug_mode":false}`, http.StatusOK)
	generate()
	if page().Total != 2 {
		t.Fatal("existing model config ignored disabling the global debug switch")
	}
}

func TestProviderDebugShutdownDrainsFinalCancelledBackgroundTrace(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	// The fixture validates this opt-in DSN before any connection is opened. A
	// session lock gates SaveProviderTrace without touching application data.
	blocker, err := pgx.Connect(ctx, os.Getenv("OCHI_PROCESS_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("could not open disposable QA debug-write gate", err)
	}
	unlock := sync.OnceFunc(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := blocker.Exec(cleanupCtx, `SELECT pg_advisory_unlock(891304)`); err != nil {
			t.Error("could not release disposable QA debug-write gate", err)
		}
		if err := blocker.Close(cleanupCtx); err != nil {
			t.Error("could not close disposable QA debug-write gate", err)
		}
	})
	t.Cleanup(unlock)
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_lock(891304)`); err != nil {
		t.Fatal("could not gate disposable QA debug writes", err)
	}
	started, cancelled, emitted, producerDone := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	shutdownResult, shutdownDone := make(chan error, 1), make(chan struct{})
	shutdownStarted := false
	t.Cleanup(func() {
		release()
		unlock()
		cancel()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		for _, done := range []<-chan struct{}{producerDone, shutdownDone} {
			if done == shutdownDone && !shutdownStarted {
				continue
			}
			select {
			case <-done:
			case <-cleanupCtx.Done():
				t.Error("provider-debug lifecycle work did not stop during cleanup")
				return
			}
		}
	})
	wait := func(signal <-chan struct{}, stage string) {
		t.Helper()
		select {
		case <-signal:
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s: %v", stage, ctx.Err())
		}
	}
	trace := agent.ProviderTrace{ID: "44444444444444448444444444444441", RunID: f.run.RunID, SessionID: f.session.ID,
		Purpose: "title", Attempt: 1, StartedAt: time.Now().UTC(), Model: "synthetic", Protocol: "openai",
		RequestBody: "final synthetic request", ErrorClass: "cancelled", Error: context.Canceled.Error()}
	f.server.launchBackground(func(parent context.Context) {
		defer close(producerDone)
		close(started)
		<-parent.Done()
		close(cancelled)
		select {
		case <-gate:
			trace.FinishedAt = time.Now().UTC()
			f.server.recordProviderTrace(trace)
			close(emitted)
		case <-ctx.Done():
		}
	})
	wait(started, "tracked background producer to start")
	shutdownStarted = true
	go func() {
		defer close(shutdownDone)
		shutdownResult <- f.server.Shutdown(ctx)
	}()
	wait(cancelled, "shutdown to cancel the tracked producer")
	f.server.backgroundMu.Lock()
	closed := f.server.providerDebugClosed
	f.server.backgroundMu.Unlock()
	if closed {
		t.Fatal("shutdown closed trace admission before the cancelled producer could emit its final request")
	}
	lateBackgroundRan := make(chan struct{})
	f.server.launchBackground(func(context.Context) { close(lateBackgroundRan) })
	select {
	case err := <-shutdownResult:
		t.Fatalf("shutdown returned before the tracked producer finished: %v", err)
	default:
	}
	release()
	wait(emitted, "cancelled producer to enqueue its final trace")
	wait(producerDone, "tracked producer to finish")
	// Wait for the positive closed-admission state, rather than guessing when
	// shutdown has moved from producer cleanup to draining the gated DB write.
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		f.server.backgroundMu.Lock()
		closed = f.server.providerDebugClosed
		f.server.backgroundMu.Unlock()
		if closed {
			break
		}
		select {
		case err := <-shutdownResult:
			t.Fatalf("shutdown returned before final debug storage drained: %v", err)
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("shutdown did not close admission after tracked producers completed")
		}
	}
	if len(f.server.providerDebugSlots) != 1 {
		t.Fatal("cancelled producer's final trace was not retained for the pending storage write")
	}
	if _, err := f.server.store.ProviderTrace(ctx, f.run.RunID, trace.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("debug write did not remain pending behind the test gate", err)
	}
	select {
	case err := <-shutdownResult:
		t.Fatalf("shutdown returned while final debug storage was still gated: %v", err)
	default:
	}
	unlock()
	select {
	case err := <-shutdownResult:
		if err != nil {
			t.Fatal("shutdown did not drain the final debug write", err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown did not finish after debug storage was released")
	}
	stored, err := f.server.store.ProviderTrace(ctx, f.run.RunID, trace.ID)
	if err != nil || stored.ErrorClass != "cancelled" || stored.Purpose != "title" || stored.RequestBody != "final synthetic request" {
		t.Fatalf("shutdown lost the final cancelled background request: %+v %v", stored, err)
	}
	if len(f.server.providerDebugSlots) != 0 {
		t.Fatal("shutdown returned without releasing the completed debug-write slot")
	}
	select {
	case <-lateBackgroundRan:
		t.Fatal("shutdown admitted a new background producer after cancellation")
	default:
	}
	late := trace
	late.ID = "44444444444444448444444444444442"
	f.server.recordProviderTrace(late)
	if len(f.server.providerDebugSlots) != 0 {
		t.Fatal("closed trace admission leaked its temporary debug-write slot")
	}
	if _, err := f.server.store.ProviderTrace(ctx, f.run.RunID, late.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("shutdown admitted a request after trace admission closed", err)
	}
}

func TestProviderDebugAdmissionRejectsFullCapacityAndReleasesClosedSlot(t *testing.T) {
	s := &Server{providerDebugSlots: make(chan struct{}, 1)}
	s.providerDebugSlots <- struct{}{}
	record := func() {
		t.Helper()
		done := make(chan struct{})
		go func() {
			defer close(done)
			s.recordProviderTrace(agent.ProviderTrace{ID: "synthetic-admission-test"})
		}()
		t.Cleanup(func() {
			select {
			case <-s.providerDebugSlots:
			default:
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("debug admission did not stop during cleanup")
			}
		})
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("debug admission blocked instead of rejecting the request")
		}
	}
	record()
	if len(s.providerDebugSlots) != 1 {
		t.Fatal("capacity rejection consumed or released another writer's slot")
	}
	<-s.providerDebugSlots
	s.backgroundMu.Lock()
	s.providerDebugClosed = true
	s.backgroundMu.Unlock()
	record()
	if len(s.providerDebugSlots) != 0 {
		t.Fatal("closed admission did not release the slot it acquired")
	}
}
