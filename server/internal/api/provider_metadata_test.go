package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"slices"
	"testing"

	"ochi/server/internal/storage"
)

func TestProtocolSwitchAdaptsOnlyAutomaticReasoningDialect(t *testing.T) {
	for _, id := range []string{"group/gpt-6-luna", "group/grok-4.7", "group/gemini-3.8-flash", "group/glm-5.3-flash"} {
		for _, test := range []struct {
			name, baseURL, protocol, current, expected string
			manual                                     bool
		}{
			{"auto-chat", "https://relay.example/v1", "openai", "reasoning.effort", "reasoning_effort", false},
			{"manual-chat", "https://relay.example/v1", "openai", "reasoning.effort", "reasoning.effort", true},
			{"openrouter-chat", "https://openrouter.ai/api/v1", "openai", "reasoning_effort", "reasoning.effort", false},
			{"responses", "https://relay.example/v1", "openai-responses", "reasoning_effort", "reasoning.effort", false},
			{"manual-responses", "https://relay.example/v1", "openai-responses", "thinkingBudget", "thinkingBudget", true},
		} {
			t.Run(id+"/"+test.name, func(t *testing.T) {
				model := storage.Model{Model: id, EffortParameter: test.current, MetadataOverrides: map[string]bool{"reasoning": test.manual}}
				config := (&Server{}).modelConfig(context.Background(), model, storage.Provider{Protocol: test.protocol, BaseURL: test.baseURL}, "high", storage.Settings{})
				if config.EffortParameter != test.expected {
					t.Fatalf("got %s, want %s", config.EffortParameter, test.expected)
				}
			})
		}
	}
}

func TestCatalogRelayEffortsPersistAndPublish(t *testing.T) {
	store := searchIntegrationStore(t)
	ctx := context.Background()
	provider, err := store.SaveProvider(ctx, storage.Provider{Name: "Local Magpie", Protocol: "openai", BaseURL: "https://fixture.invalid/v1", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	references := map[string]storage.CatalogModel{}
	ids := []string{}
	for _, family := range []struct {
		vendor, id string
		efforts    []string
	}{
		{"deepseek", "deepseek-v4.1-flash", []string{"none", "low", "high", "max"}},
		{"openai", "gpt-6-luna", []string{"none", "low", "medium", "high", "xhigh", "max"}},
		{"xai", "grok-4.7", []string{"low", "medium", "high", "xhigh"}},
		{"google", "gemini-3.8-flash", []string{"low", "medium", "high"}},
		{"zai", "glm-5.3-flash", []string{"low", "high", "max"}},
	} {
		id := "group/" + family.id
		ids = append(ids, id)
		references[id] = storage.CatalogModel{ID: family.id, ProviderID: family.vendor, CanonicalModelID: family.vendor + "/" + family.id, Reasoning: true, Known: map[string]bool{"reasoning": true}, ReasoningOptions: []storage.ReasoningOption{{Type: "effort", Values: family.efforts}}}
	}
	models, imported, _, err := store.SyncProviderModels(ctx, provider, ids, references)
	if err != nil || imported != len(ids) {
		t.Fatalf("catalog import: imported=%d err=%v", imported, err)
	}
	for _, model := range models {
		model.Enabled = true
		if model.Model == ids[0] {
			model.DefaultEffort = "high"
			model.MetadataOverrides["reasoning"] = true
		}
		if _, err := store.SaveModel(ctx, model); err != nil {
			t.Fatal(err)
		}
	}
	if _, imported, _, err := store.SyncProviderModels(ctx, provider, ids, references); err != nil || imported != 0 {
		t.Fatalf("catalog refresh: imported=%d err=%v", imported, err)
	}
	recorder := httptest.NewRecorder()
	(&Server{store: store}).publishedModels(recorder, httptest.NewRequest("GET", "/api/models", nil))
	var published []storage.Model
	if recorder.Code != 200 || json.Unmarshal(recorder.Body.Bytes(), &published) != nil || len(published) != len(ids) {
		t.Fatalf("published models: status=%d count=%d", recorder.Code, len(published))
	}
	for _, model := range published {
		expected := references[model.Model].ReasoningOptions[0].Values
		defaultEffort := ""
		if model.Model == ids[0] {
			defaultEffort = "high"
		}
		if model.ReasoningKind != "effort" || model.EffortParameter != "reasoning_effort" || !slices.Equal(model.Efforts, expected) || model.DefaultEffort != defaultEffort || !model.Enabled {
			t.Fatalf("persisted/published catalog options lost: %+v", model)
		}
		if model.EffortMapping != nil {
			t.Fatal("private wire value mappings leaked into published catalog")
		}
	}
}
