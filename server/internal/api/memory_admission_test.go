package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func TestMemoryAdmissionSeparatesDurabilityFromExactQuotation(t *testing.T) {
	for _, test := range []struct {
		name, statement, scope, verdict string
		want                            int
		wantError                       bool
	}{
		{"standing preference", "Always answer me in English unless I ask otherwise.", "user", `{"decisions":[{"index":0,"classification":"standing_preference","scope":"user"}]}`, 1, false},
		{"one response", "For this answer only: in English.", "user", `{"decisions":[{"index":0,"classification":"task_local","scope":"user"}]}`, 0, false},
		{"vendor quotation", `Explain this vendor rule: "always answer in English".`, "user", `{"decisions":[{"index":0,"classification":"quoted","scope":"user"}]}`, 0, false},
		{"uncertain", "Maybe English would work here.", "user", `{"decisions":[{"index":0,"classification":"uncertain","scope":"user"}]}`, 0, false},
		{"no project widening", "For this repository, all documentation is English.", "project", `{"decisions":[{"index":0,"classification":"standing_preference","scope":"user"}]}`, 0, false},
		{"wrong identity", "Always use English.", "user", `{"decisions":[{"index":9,"classification":"standing_preference","scope":"user"}]}`, 0, true},
		{"invalid response", "Always use English.", "user", `not JSON`, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Messages) != 2 || request.Messages[0].Content != memoryAdmissionPolicy || !strings.Contains(request.Messages[1].Content, test.statement[:min(15, len(test.statement))]) {
					t.Error("admission lost its independent policy or complete user evidence")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": test.verdict}}}})
			}))
			defer provider.Close()
			candidates := []extractedFact{{Kind: "preference", Content: "Prefers English", Excerpt: test.statement, Scope: test.scope}}
			admitted, err := admitMemoryFacts(context.Background(), agent.Config{BaseURL: provider.URL, Model: "fixture", Protocol: "openai", AllowNoKey: true}, test.statement, "project-fixture", candidates, nil)
			if (err != nil) != test.wantError || len(admitted) != test.want {
				t.Fatalf("admission: %+v %v", admitted, err)
			}
			if len(admitted) > 0 && admitted[0].Admission != "durable" {
				t.Fatal("admitted fact lacks separate lifetime evidence")
			}
		})
	}
}

func TestMemoryAdmissionRejectsUnboundedOrPartialEvidenceBeforeModel(t *testing.T) {
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusServiceUnavailable) }))
	defer provider.Close()
	config := agent.Config{BaseURL: provider.URL, Model: "fixture", Protocol: "openai", AllowNoKey: true}
	prompt := strings.Repeat("x", 16001)
	got, err := admitMemoryFacts(context.Background(), config, prompt, "", []extractedFact{{Kind: "fact", Content: "Claim", Excerpt: prompt[:10], Scope: "user"}}, nil)
	if err != nil || len(got) != 0 || calls != 0 {
		t.Fatal("oversized evidence was truncated into an apparently durable claim")
	}
	if _, err = admitMemoryFacts(context.Background(), config, "actual statement", "", []extractedFact{{Kind: "fact", Content: "Claim", Excerpt: "invented", Scope: "user"}}, nil); err != storage.ErrMemorySource || calls != 0 {
		t.Fatal("unattributed candidate reached semantic admission")
	}
	if _, err = admitMemoryFacts(context.Background(), config, "actual statement", "", []extractedFact{{Kind: "fact", Content: "Claim", Excerpt: "actual statement", Scope: "user"}}, nil); err == nil {
		t.Fatal("unavailable assessor silently admitted a fact")
	}
}

func TestAutomaticExtractionAndAgentSaveShareAdmissionGate(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	const statement = "For this answer only: in English."
	if _, err := f.server.store.AcceptInstruction(ctx, f.owner, f.run.RunID, "memory-scope-fixture", statement); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.ConsumeInstructions(ctx, f.owner, f.session.ID, f.run.RunID); err != nil {
		t.Fatal(err)
	}
	admissions := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Messages) != 2 {
			t.Error("invalid auxiliary request")
			return
		}
		response := `{"facts":[{"kind":"preference","content":"Prefers English","excerpt":"in English","scope":"user","admission":"durable"}],"summary":"This answer was requested in English.","methods":[]}`
		if request.Messages[0].Content == memoryAdmissionPolicy {
			admissions++
			if !strings.Contains(request.Messages[1].Content, "For this answer only") {
				t.Error("one-off scope disappeared from admission evidence")
			}
			response = `{"decisions":[{"index":0,"classification":"task_local","scope":"user"}]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": response}}}})
	}))
	defer provider.Close()
	p, err := f.server.store.SaveProvider(ctx, storage.Provider{Name: "Admission fixture", Protocol: "openai", BaseURL: provider.URL, Enabled: true, AllowNoKey: true})
	if err != nil {
		t.Fatal(err)
	}
	model, err := f.server.store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "Fixture", Model: "fixture", Kind: "chat", Enabled: true, Available: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := f.server.store.Settings(ctx)
	settings.MemoryModelID = model.ID
	if err = f.server.store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	scope := agent.WithRunScope(ctx, agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID})
	result, err := f.server.memoryTool(scope, f.owner, "memory_save", json.RawMessage(`{"content":"Prefers English","excerpt":"in English"}`))
	if err != nil || !strings.Contains(result.Output, `"saved":false`) {
		t.Fatalf("agent save bypassed rejection: %s %v", result.Output, err)
	}
	f.run.Status = runtime.StatusCompleted
	f.run.Seq++
	if err = f.server.store.CompleteRun(ctx, f.run); err != nil {
		t.Fatal(err)
	}
	job, err := f.server.store.ClaimMemoryJob(ctx)
	if err != nil || job == nil {
		t.Fatalf("memory job: %v", err)
	}
	if err = f.server.extractMemoryJob(ctx, *job); err != nil {
		t.Fatal(err)
	}
	profile, err := f.server.store.StableMemoryProfile(ctx, f.owner)
	if err != nil || len(profile) != 0 || admissions != 2 {
		t.Fatalf("one-off instruction became global preference: %+v %v (checks %d)", profile, err, admissions)
	}
	items, err := f.server.store.Memories(ctx, f.owner, "")
	if err != nil || len(items) != 1 || items[0].Kind != "session_summary" || items[0].Admission != "episodic" {
		t.Fatalf("rejection discarded episodic history or kept unadmitted fact: %+v %v", items, err)
	}
}
