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

func TestGeneratedTitleCleaningAndRejectsNonTitles(t *testing.T) {
	title, err := cleanGeneratedTitle("  \"中国剩余定理的计算与例子\"  ")
	if err != nil || title != "中国剩余定理的计算与例子" {
		t.Fatalf("title=%q error=%v", title, err)
	}
	for _, test := range []struct{ raw, reason string }{
		{"", "empty"}, {"标题\n这里是一些说明", "multiline (10 characters)"}, {strings.Repeat("x", 81), "too-long (81 characters)"}, {string([]byte{0xff}), "invalid UTF-8"},
	} {
		if _, err := cleanGeneratedTitle(test.raw); err == nil || !strings.HasSuffix(err.Error(), test.reason) {
			t.Errorf("invalid title diagnostic: %v, want %q", err, test.reason)
		}
	}
}

func TestTitleSelectionRepairAndPublication(t *testing.T) {
	const prompt = "Compare the available report export formats"
	const generated = "Report export options"
	for _, test := range []struct {
		name             string
		assigned         bool
		responses        []string
		wantTitle        string
		wantSource       string
		rename           bool
		changeTitleModel bool
	}{
		{name: "follows_main", responses: []string{generated}, wantTitle: generated, wantSource: "automatic"},
		{name: "assigned_model", assigned: true, responses: []string{generated}, wantTitle: generated, wantSource: "automatic"},
		{name: "repairs_multiline", assigned: true, responses: []string{"Report formats\nHere is an explanation", generated}, wantTitle: generated, wantSource: "automatic"},
		{name: "bounds_repair_and_freezes_model", assigned: true, responses: []string{strings.Repeat("界", 600), generated}, wantTitle: generated, wantSource: "automatic", changeTitleModel: true},
		{name: "rejects_both_invalid_responses", assigned: true, responses: []string{"Report formats\nHere is an explanation", "Another title\nMore explanation"}, wantTitle: prompt, wantSource: "fallback"},
		{name: "manual_rename_wins_publication_race", assigned: true, responses: []string{generated}, wantTitle: "My custom title", wantSource: "manual", rename: true},
		{name: "manual_rename_prevents_repair", assigned: true, responses: []string{"Report formats\nHere is an explanation"}, wantTitle: "My custom title", wantSource: "manual", rename: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := searchIntegrationStore(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server := &Server{store: store, backgroundCtx: ctx}
			var session storage.Session
			models := make([]storage.Model, 2)
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempt := int(requests.Add(1))
				var body struct {
					Model    string          `json:"model"`
					Effort   string          `json:"reasoning_effort"`
					Tools    json.RawMessage `json:"tools"`
					Messages []agent.Message `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				want := "main-model"
				if test.assigned {
					want = "title-model"
				}
				if body.Model != want || body.Effort != "low" || len(body.Tools) != 0 {
					t.Errorf("title model/options: model=%q effort=%q tools=%s", body.Model, body.Effort, body.Tools)
				}
				if len(body.Messages) != 2 || body.Messages[0].Content != titlePolicy {
					t.Errorf("title request did not isolate its instructions: %+v", body.Messages)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var input struct {
					Message              string `json:"message"`
					PreviousInvalidTitle string `json:"previous_invalid_title"`
				}
				if err := json.Unmarshal([]byte(body.Messages[1].Content), &input); err != nil || input.Message != prompt {
					t.Errorf("title request lost the original prompt: %+v err=%v", input, err)
				}
				previous := ""
				if attempt == 2 {
					previous = trimRunes(test.responses[0], 512)
				}
				if input.PreviousInvalidTitle != previous {
					t.Error("title retry did not include only the bounded rejected response as data")
				}
				if test.rename && attempt == 1 {
					if _, err := store.UpdateSession(ctx, "title-fixture-user", session.ID, "My custom title", models[0].ID, "high"); err != nil {
						t.Error(err)
					}
				}
				if test.changeTitleModel && attempt == 1 {
					settings, err := store.Settings(ctx)
					if err != nil {
						t.Error(err)
					} else {
						settings.TitleModelID = models[0].ID
						if err := store.SaveSettings(ctx, settings); err != nil {
							t.Error(err)
						}
					}
				}
				if attempt > len(test.responses) {
					t.Errorf("unexpected extra title request %d", attempt)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				response, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": test.responses[attempt-1]}, "finish_reason": "stop"}}})
				w.Write(response)
			}))
			defer upstream.Close()
			if err := store.BootstrapUser(ctx, storage.User{ID: "title-fixture-user", Username: "title-fixture-user", Role: "user"}); err != nil {
				t.Fatal(err)
			}
			provider, err := store.SaveProvider(ctx, storage.Provider{Name: "Fixture", Protocol: "openai", BaseURL: upstream.URL, Enabled: true, AllowNoKey: true})
			if err != nil {
				t.Fatal(err)
			}
			for i, name := range []string{"main-model", "title-model"} {
				models[i], err = store.SaveModel(ctx, storage.Model{ProviderID: provider.ID, Name: name, Model: name, Enabled: true, Available: true, ContextWindow: 32768,
					ReasoningKind: "effort", EffortParameter: "reasoning_effort", DefaultEffort: "high", Efforts: []string{"low", "high"},
					EffortMapping: map[string]json.RawMessage{"low": json.RawMessage(`"low"`), "high": json.RawMessage(`"high"`)}})
				if err != nil {
					t.Fatal(err)
				}
			}
			if test.assigned {
				settings, err := store.Settings(ctx)
				if err != nil {
					t.Fatal(err)
				}
				settings.TitleModelID = models[1].ID
				if err := store.SaveSettings(ctx, settings); err != nil {
					t.Fatal(err)
				}
			}
			session, err = store.CreateSession(ctx, "title-fixture-user")
			if err != nil {
				t.Fatal(err)
			}
			const runID = "11111111-1111-4111-8111-111111111111"
			if _, _, err := store.CreateConfiguredRun(ctx, "title-fixture-user", session.ID, prompt, runID, models[0], "high", "Main instructions", nil); err != nil {
				t.Fatal(err)
			}
			server.asyncTitle(agent.Request{UserID: "title-fixture-user", SessionID: session.ID, Config: server.modelConfig(ctx, models[0], provider, "high", storage.Settings{})})
			done := make(chan struct{})
			go func() {
				server.backgroundWG.Wait()
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				cancel()
				<-done
				t.Fatal("title completion did not finish")
			}
			updated, err := store.GetSession(ctx, "title-fixture-user", session.ID)
			if err != nil || updated.Title != test.wantTitle || updated.TitleSource != test.wantSource || requests.Load() != int32(len(test.responses)) {
				t.Fatalf("title not published: session=%+v requests=%d err=%v", updated, requests.Load(), err)
			}
		})
	}
}
