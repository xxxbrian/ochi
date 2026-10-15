package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func TestMemorySearchDatabaseInflightUserMutations(t *testing.T) {
	store := searchIntegrationStore(t)
	s, err := NewServer(store, nil, []Account{{Username: "recall-mutation-qa", Password: "fixture-only-memory-password", Role: "admin"}}, false)
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
	user, _ := store.GetUser(ctx, "recall-mutation-qa")
	type blockedRequest struct{ entered, release chan struct{} }
	gates := make(chan blockedRequest, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gate := <-gates
		close(gate.entered)
		select {
		case <-gate.release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[1,2]}]}`))
	}))
	t.Cleanup(provider.Close)
	p, err := store.SaveProvider(ctx, storage.Provider{Name: "Blocked recall fixture", Protocol: "openai", BaseURL: provider.URL, Enabled: true, AllowNoKey: true})
	if err != nil {
		t.Fatal(err)
	}
	model, err := store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Embedding", Model: "fixture", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := store.Settings(ctx)
	settings.EmbeddingModelID = model.ID
	if err = store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	const runID = "77777777-aaaa-4777-8777-777777777777"
	if _, _, err = store.CreateConfiguredRun(ctx, user.ID, session.ID, "Recall my private preference.", runID, storage.Model{}, "", "", nil); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"disable", "edit", "delete"} {
		t.Run(mutation, func(t *testing.T) {
			on := true
			if _, err := store.PatchPreferences(ctx, user.ID, &on, nil); err != nil {
				t.Fatal(err)
			}
			record, err := store.SaveMemoryRecord(ctx, user.ID, storage.Memory{Content: "Private preference " + mutation, Source: "user"})
			if err != nil {
				t.Fatal(err)
			}
			call, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			gate := blockedRequest{make(chan struct{}), make(chan struct{})}
			gates <- gate
			type outcome struct {
				result agent.ToolResult
				err    error
			}
			finished := make(chan outcome, 1)
			go func() {
				scope := agent.WithRunScope(call, agent.RunScope{UserID: user.ID, SessionID: session.ID, RunID: runID})
				result, err := s.memoryTool(scope, user.ID, "memory_search", json.RawMessage(`{"query":"Private preference"}`))
				finished <- outcome{result, err}
			}()
			select {
			case <-gate.entered:
			case <-call.Done():
				close(gate.release)
				t.Fatal("embedding did not enter controlled HTTP gate")
			}
			switch mutation {
			case "disable":
				off := false
				_, err = store.PatchPreferences(ctx, user.ID, &off, nil)
			case "edit":
				record.Content += " changed"
				_, err = store.SaveMemoryRecord(ctx, user.ID, record)
			case "delete":
				err = store.DeleteMemory(ctx, user.ID, record.ID)
			}
			close(gate.release)
			if err != nil {
				t.Fatal(err)
			}
			out := <-finished
			var recalled storage.MemoryRecallResult
			if out.err != nil || json.Unmarshal([]byte(out.result.Output), &recalled) != nil || len(recalled.Items) != 0 || !slices.Contains(recalled.Status.Events, "memory_changed") {
				t.Fatalf("in-flight %s returned stale memory: %s, %v", mutation, out.result.Output, out.err)
			}
		})
	}
}
