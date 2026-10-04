package storage

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
)

func catalogFixture(t *testing.T, provider, id, canonical string) CatalogModel {
	t.Helper()
	var model CatalogModel
	err := json.Unmarshal([]byte(`{"name":"DeepSeek Flash","tool_call":true,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}],"modalities":{"input":["text","image"],"output":["text"]},"limit":{"context":1000000,"output":384000}}`), &model)
	if err != nil {
		t.Fatal(err)
	}
	model.ID, model.ProviderID, model.CanonicalModelID = id, provider, canonical
	return model
}

func TestCatalogMatchesCanonicalProxyWithoutGuessingVersions(t *testing.T) {
	reference := catalogFixture(t, "deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash")
	catalog := map[string]CatalogProvider{"deepseek": {Models: map[string]CatalogModel{reference.ID: reference}}}
	for _, id := range []string{"deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "group/deepseek-v4.1-flash"} {
		match, source, ok := ResolveCatalogModel(catalog, Provider{BaseURL: "https://relay.example/v1"}, id)
		if !ok || match.ID != "deepseek-flash" || source != "vendor-canonical" {
			t.Fatalf("%s: match=%+v source=%s", id, match, source)
		}
	}
	if _, _, ok := ResolveCatalogModel(catalog, Provider{}, "deepseek-v4.2-flash"); ok {
		t.Fatal("unlisted version must remain unknown")
	}
}

func TestCatalogKnownAndManualOverrides(t *testing.T) {
	reference := catalogFixture(t, "deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash")
	base := Model{Model: "deepseek-v4.1-flash", Name: "Custom", ContextWindow: 64000, SupportsVision: false, MetadataOverrides: map[string]bool{"name": true, "context_window": true, "supports_vision": true}, MetadataKnown: map[string]bool{"supports_vision": true}}
	model := EnrichCatalogModel(base, Provider{Protocol: "openai"}, reference, "vendor-canonical")
	if model.Name != "Custom" || model.ContextWindow != 64000 || model.SupportsVision || !model.SupportsTools || model.MaxOutputTokens != 384000 {
		t.Fatalf("overrides not preserved: %+v", model)
	}
	if model.EffortParameter != "reasoning_effort" || len(model.Efforts) != 4 || model.Efforts[0] != "none" || model.MetadataSource != "models.dev+admin" {
		t.Fatalf("catalog effort options not adapted: %+v", model)
	}
	var sparse CatalogModel
	if err := json.Unmarshal([]byte(`{"name":"Unknown","reasoning":true}`), &sparse); err != nil {
		t.Fatal(err)
	}
	unknown := ApplyCatalogMetadata(Model{SupportsTools: true}, sparse)
	if !unknown.SupportsTools || unknown.MetadataKnown["supports_tools"] || unknown.MetadataKnown["supports_vision"] {
		t.Fatal("absent catalog capabilities must not become confirmed false")
	}
}

func TestCatalogDatabaseRefreshPreservesFieldOverrides(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	provider, err := s.SaveProvider(ctx, Provider{Name: "Catalog QA", Protocol: "openai", BaseURL: "https://fixture.invalid/v1", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	const id = "deepseek-v4.1-flash"
	reference := catalogFixture(t, "deepseek", "deepseek-flash", "deepseek/"+id)
	references := map[string]CatalogModel{id: reference}
	models, imported, unavailable, err := s.SyncProviderModels(ctx, provider, []string{id}, references)
	if err != nil || imported != 1 || unavailable != 0 || len(models) != 1 {
		t.Fatalf("catalog import: imported=%d unavailable=%d models=%d err=%v", imported, unavailable, len(models), err)
	}
	model := models[0]
	if !model.MetadataKnown["supports_tools"] || !model.SupportsTools || model.ContextWindow != reference.Limit.Context {
		t.Fatal("catalog metadata did not survive model persistence")
	}
	model.ContextWindow, model.SupportsVision = 64000, false
	model.MetadataOverrides = map[string]bool{"context_window": true, "supports_vision": true}
	if _, err = s.SaveModel(ctx, model); err != nil {
		t.Fatal(err)
	}
	reference.Limit.Output = 128000
	references[id] = reference
	models, imported, unavailable, err = s.SyncProviderModels(ctx, provider, []string{id}, references)
	if err != nil || imported != 0 || unavailable != 0 || len(models) != 1 {
		t.Fatalf("catalog refresh: imported=%d unavailable=%d models=%d err=%v", imported, unavailable, len(models), err)
	}
	refreshed, err := s.Model(ctx, model.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.ContextWindow != 64000 || refreshed.SupportsVision || !refreshed.MetadataOverrides["context_window"] || !refreshed.MetadataOverrides["supports_vision"] {
		t.Fatal("persisted field overrides were lost during catalog refresh")
	}
	if !refreshed.MetadataKnown["supports_tools"] || !refreshed.SupportsTools || refreshed.MaxOutputTokens != 128000 || refreshed.MetadataSource != "models.dev+admin" {
		t.Fatal("unmodified catalog fields did not refresh alongside overrides")
	}
}

func TestCatalogProviderExactOverridesVendorCapabilities(t *testing.T) {
	canonical := catalogFixture(t, "deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash")
	proxy := catalogFixture(t, "openrouter", "deepseek/deepseek-v4.1-flash", canonical.CanonicalModelID)
	proxy.Limit.Context = 800000
	catalog := map[string]CatalogProvider{"deepseek": {Models: map[string]CatalogModel{canonical.ID: canonical}}, "openrouter": {Models: map[string]CatalogModel{proxy.ID: proxy}}}
	provider := Provider{Protocol: "openai", BaseURL: "https://openrouter.ai/api/v1"}
	reference, match, ok := ResolveCatalogModel(catalog, provider, proxy.ID)
	if !ok || match != "provider-exact" || reference.Limit.Context != 800000 {
		t.Fatal("provider's own limits must take precedence")
	}
	model := EnrichCatalogModel(Model{Model: proxy.ID}, provider, reference, match)
	if model.EffortParameter != "reasoning.effort" || model.Icon != "/brands/deepseek-color.svg" {
		t.Fatalf("proxy transport or maker icon incorrect: %+v", model)
	}
}

func TestCatalogRelayEffortsUseTransportAcrossVendors(t *testing.T) {
	for _, family := range []struct {
		vendor, id string
		efforts    []string
	}{
		{"openai", "gpt-6-luna", []string{"none", "low", "medium", "high", "xhigh", "max"}},
		{"deepseek", "deepseek-v4.1-flash", []string{"low", "high", "max"}},
		{"xai", "grok-4.7", []string{"low", "medium", "high", "xhigh"}},
		{"google", "gemini-3.8-flash", []string{"low", "medium", "high"}},
		{"zai", "glm-5.3-flash", []string{"low", "high", "max"}},
		{"moonshotai", "kimi-k3", []string{"low", "high", "max"}},
		{"anthropic", "claude-sonnet-5-5", []string{"low", "medium", "high", "xhigh", "max"}},
	} {
		for _, transport := range []struct {
			name, protocol, catalogProvider, parameter string
		}{
			{"chat", "openai", "", "reasoning_effort"},
			{"responses", "openai-responses", "", "reasoning.effort"},
			{"openrouter", "openai", "openrouter", "reasoning.effort"},
		} {
			t.Run(family.id+"/"+transport.name, func(t *testing.T) {
				reference := CatalogModel{ID: family.id, ProviderID: family.vendor, CanonicalModelID: family.vendor + "/" + family.id, Reasoning: true, Known: map[string]bool{"reasoning": true}, ReasoningOptions: []ReasoningOption{{Type: "effort", Values: family.efforts}}}
				catalog := map[string]CatalogProvider{family.vendor: {Models: map[string]CatalogModel{family.id: reference}}}
				provider := Provider{Name: "Local Magpie", Protocol: transport.protocol, BaseURL: "https://relay.example/v1", CatalogProviderID: transport.catalogProvider}
				model := Model{Model: "group/" + family.id}
				resolved, match, ok := ResolveCatalogModel(catalog, provider, model.Model)
				if !ok || match != "vendor-canonical" {
					t.Fatalf("relay model not matched: %s %v", match, ok)
				}
				model = EnrichCatalogModel(model, provider, resolved, match)
				if model.ReasoningKind != "effort" || model.EffortParameter != transport.parameter || !slices.Equal(model.Efforts, family.efforts) {
					t.Fatalf("catalog options lost or invented: %+v", model)
				}
				for _, effort := range family.efforts {
					if string(model.EffortMapping[effort]) != `"`+effort+`"` {
						t.Fatalf("incorrect wire value for %s: %s", effort, model.EffortMapping[effort])
					}
				}
			})
		}
	}
}

func TestCatalogEffortAdapterKeepsUnknownAndManualBoundaries(t *testing.T) {
	provider := Provider{Protocol: "openai", BaseURL: "https://relay.example/v1"}
	for _, raw := range []string{
		`{"reasoning":true}`,
		`{"reasoning":true,"reasoning_options":[{"type":"effort","values":[]}]}`,
		`{"reasoning":false,"reasoning_options":[{"type":"effort","values":["high"]}]}`,
	} {
		var reference CatalogModel
		if err := json.Unmarshal([]byte(raw), &reference); err != nil {
			t.Fatal(err)
		}
		model := EnrichCatalogModel(Model{Model: "group/grok-4.7", Efforts: []string{"stale"}, EffortParameter: "reasoning_effort"}, provider, reference, "vendor-canonical")
		if len(model.Efforts) != 0 || model.EffortParameter != "" || (model.ReasoningKind != "unknown" && model.ReasoningKind != "none") {
			t.Fatalf("unsupported catalog must not invent controls: %+v", model)
		}
	}
	reference := catalogFixture(t, "google", "gemini-3.8-flash", "google/gemini-3.8-flash")
	manual := Model{Model: "group/gemini-3.8-flash", ReasoningKind: "budget", EffortParameter: "thinkingBudget", Efforts: []string{"custom"}, DefaultEffort: "custom", EffortMapping: map[string]json.RawMessage{"custom": json.RawMessage("4096")}, MetadataOverrides: map[string]bool{"reasoning": true}}
	model := EnrichCatalogModel(manual, provider, reference, "vendor-canonical")
	if model.ReasoningKind != "budget" || model.EffortParameter != "thinkingBudget" || !slices.Equal(model.Efforts, manual.Efforts) || model.DefaultEffort != "custom" || string(model.EffortMapping["custom"]) != "4096" {
		t.Fatalf("manual reasoning mapping replaced: %+v", model)
	}
	model = EnrichCatalogModel(Model{Model: "group/gemini-3.8-flash"}, Provider{Protocol: "unsupported"}, reference, "vendor-canonical")
	if model.ReasoningKind != "unknown" || len(model.Efforts) != 0 || model.EffortParameter != "" {
		t.Fatal("unknown transport must not guess a wire parameter")
	}
}

func TestImageOutputClassificationAndManualOverrides(t *testing.T) {
	var reference CatalogModel
	if err := json.Unmarshal([]byte(`{"id":"gpt-image-2","tool_call":false,"reasoning":false,"modalities":{"input":["text","image"],"output":["image"]}}`), &reference); err != nil {
		t.Fatal(err)
	}
	model := EnrichCatalogModel(Model{Model: "group/gpt-image-2", Kind: "chat"}, Provider{Protocol: "openai"}, reference, "vendor-canonical")
	if model.Kind != "image" || !model.SupportsImageGeneration || !model.SupportsVision || model.SupportsTools || !model.MetadataKnown["supports_image_generation"] {
		t.Fatalf("image generation conflated with chat or vision: %+v", model)
	}
	fallback := InferImageMetadata(Model{Model: "gpt-image-2", Kind: "chat", Enabled: false, MetadataSource: "unknown"})
	if fallback.Kind != "image" || !fallback.SupportsImageGeneration || fallback.Enabled || fallback.MetadataSource != "family" || fallback.ImageConfig.SupportsEdit == nil || !*fallback.ImageConfig.SupportsEdit {
		t.Fatalf("native image family fallback failed: %+v", fallback)
	}
	manual := InferImageMetadata(Model{Model: "gpt-image-2", Kind: "chat", MetadataOverrides: map[string]bool{"kind": true, "supports_image_generation": true}})
	if manual.Kind != "chat" || manual.SupportsImageGeneration {
		t.Fatal("explicit image metadata override was overwritten")
	}
	vision := InferImageMetadata(Model{Model: "multimodal-chat", Kind: "chat", SupportsVision: true, Modalities: Modalities{Input: []string{"image"}, Output: []string{"text"}}, MetadataKnown: map[string]bool{"modalities": true}})
	if vision.Kind != "chat" || vision.SupportsImageGeneration {
		t.Fatal("image input falsely classified as image generation")
	}
}
