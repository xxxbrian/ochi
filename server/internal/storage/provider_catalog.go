package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/product"
)

type CatalogProvider struct {
	ID         string                  `json:"id"`
	Name       string                  `json:"name"`
	API        string                  `json:"api,omitempty"`
	Doc        string                  `json:"doc,omitempty"`
	ModelCount int                     `json:"model_count"`
	Icon       string                  `json:"icon,omitempty"`
	NPM        string                  `json:"npm,omitempty"`
	Models     map[string]CatalogModel `json:"-"`
}

type CatalogModel struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	ProviderID       string            `json:"provider_id"`
	CanonicalModelID string            `json:"canonical_model_id,omitempty"`
	Status           string            `json:"status,omitempty"`
	Match            string            `json:"-"`
	Type             string            `json:"type,omitempty"`
	ToolCall         bool              `json:"tool_call"`
	Reasoning        bool              `json:"reasoning"`
	ReasoningOptions []ReasoningOption `json:"reasoning_options"`
	StructuredOutput bool              `json:"structured_output"`
	Modalities       Modalities        `json:"modalities"`
	Known            map[string]bool   `json:"metadata_known"`
	Limit            struct {
		Context int `json:"context"`
		Output  int `json:"output"`
	} `json:"limit"`
}

func (m *CatalogModel) UnmarshalJSON(data []byte) error {
	type plain CatalogModel
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*m = CatalogModel(value)
	m.Known = map[string]bool{}
	for _, key := range []string{"tool_call", "reasoning", "structured_output", "modalities", "reasoning_options"} {
		m.Known[key] = len(fields[key]) > 0 && string(fields[key]) != "null"
	}
	return nil
}

var catalogCache struct {
	sync.Mutex
	At        time.Time
	Providers map[string]CatalogProvider
}

// The catalog is advisory metadata. Wire parameters still come from a known
// protocol adapter, not a capability boolean or a model marketing name.
func FetchModelCatalog(ctx context.Context) (map[string]CatalogProvider, error) {
	catalogCache.Lock()
	defer catalogCache.Unlock()
	if catalogCache.Providers != nil && time.Since(catalogCache.At) < 6*time.Hour {
		return catalogCache.Providers, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://models.dev/api.json", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", product.UserAgent())
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		if catalogCache.Providers != nil {
			return catalogCache.Providers, nil
		}
		return nil, errors.New("模型能力目录暂时不可用")
	}
	defer resp.Body.Close()
	var raw map[string]struct {
		ID     string                  `json:"id"`
		Name   string                  `json:"name"`
		API    string                  `json:"api"`
		Doc    string                  `json:"doc"`
		NPM    string                  `json:"npm"`
		Models map[string]CatalogModel `json:"models"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 20*1024*1024)).Decode(&raw) != nil {
		if catalogCache.Providers != nil {
			return catalogCache.Providers, nil
		}
		return nil, errors.New("模型能力目录响应无效")
	}
	providers := make(map[string]CatalogProvider, len(raw))
	for id, entry := range raw {
		provider := CatalogProvider{ID: id, Name: entry.Name, API: entry.API, Doc: entry.Doc, NPM: entry.NPM, Icon: brandIcon(id), ModelCount: len(entry.Models), Models: entry.Models}
		for modelID, model := range provider.Models {
			model.ID, model.ProviderID = modelID, id
			provider.Models[modelID] = model
		}
		providers[id] = provider
	}
	catalogCache.Providers, catalogCache.At = providers, time.Now()
	return providers, nil
}

func ApplyCatalogMetadata(model Model, reference CatalogModel) Model {
	if model.MetadataKnown == nil {
		model.MetadataKnown = map[string]bool{}
	}
	overrides := model.MetadataOverrides
	if reference.Type == "embedding" || reference.Type == "embeddings" {
		if !overrides["kind"] {
			model.Kind = "embedding"
		}
	}
	if !overrides["context_window"] && reference.Limit.Context > 0 {
		model.ContextWindow = reference.Limit.Context
	}
	if !overrides["max_output_tokens"] && reference.Limit.Output > 0 {
		model.MaxOutputTokens = reference.Limit.Output
	}
	if !overrides["supports_tools"] && reference.Known["tool_call"] {
		model.SupportsTools = reference.ToolCall
		model.MetadataKnown["supports_tools"] = true
	}
	if reference.Known["modalities"] {
		if !overrides["supports_vision"] {
			model.SupportsVision = slices.Contains(reference.Modalities.Input, "image")
			model.MetadataKnown["supports_vision"] = true
		}
		if !overrides["modalities"] {
			model.Modalities = reference.Modalities
			model.MetadataKnown["modalities"] = true
		}
	}
	if !overrides["structured_output"] && reference.Known["structured_output"] {
		model.StructuredOutput = reference.StructuredOutput
		model.MetadataKnown["structured_output"] = true
	}
	model.ReasoningOptions = reference.ReasoningOptions
	if model.ReasoningOptions == nil {
		model.ReasoningOptions = []ReasoningOption{}
	}
	// Keep an administrator's proven request dialect. The directory describes
	// capabilities, but does not specify their OpenAI-compatible JSON encoding.
	if !overrides["reasoning"] && model.EffortParameter == "" {
		model.ReasoningKind = "unknown"
		if reference.Known["reasoning"] && !reference.Reasoning {
			model.ReasoningKind = "none"
		}
	}
	for _, option := range reference.ReasoningOptions {
		if option.Type == "budget_tokens" && !overrides["reasoning"] {
			model.ReasoningBudgetMin, model.ReasoningBudgetMax = option.Min, option.Max
		}
	}
	model.CatalogProviderID, model.CatalogModelID = reference.ProviderID, reference.ID
	model.MetadataSource = "models.dev"
	if len(overrides) > 0 {
		model.MetadataSource = "models.dev+admin"
	}
	now := time.Now().UTC()
	model.MetadataUpdatedAt = &now
	return InferImageMetadata(model)
}

func (s *Store) SyncProviderModels(ctx context.Context, provider Provider, ids []string, references map[string]CatalogModel) ([]Model, int, int, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, 0, 0, err
	}
	defer tx.Rollback(context.Background())
	// Serialize one provider's refresh, without blocking any ongoing agent run.
	if _, err = tx.Exec(ctx, `SELECT id FROM providers WHERE id=$1 FOR UPDATE`, provider.ID); err != nil {
		return nil, 0, 0, err
	}
	imported, unavailable := 0, 0
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		var existingID string
		err = tx.QueryRow(ctx, `SELECT id::text FROM models WHERE provider_id=$1 AND model=$2 ORDER BY created_at LIMIT 1`, provider.ID, id).Scan(&existingID)
		if err == nil {
			if _, err = tx.Exec(ctx, `UPDATE models SET available=true WHERE provider_id=$1 AND model=$2`, provider.ID, id); err != nil {
				return nil, 0, 0, err
			}
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, 0, err
		}
		model := Model{Name: id, Model: id, Source: "remote", Available: true, ContextWindow: 0, Modalities: Modalities{Input: []string{"text"}, Output: []string{"text"}}, ReasoningKind: "unknown", MetadataSource: "unknown"}
		if reference, ok := references[id]; ok {
			model = EnrichCatalogModel(model, provider, reference, reference.Match)
		}
		model = InferImageMetadata(model)
		options, _ := json.Marshal(model.ReasoningOptions)
		if model.ReasoningOptions == nil {
			options = []byte("[]")
		}
		modalities, _ := json.Marshal(model.Modalities)
		_, err = tx.Exec(ctx, `INSERT INTO models (provider_id,name,model,enabled,context_window,supports_tools,supports_vision,source,available,max_output_tokens,modalities,structured_output,reasoning_kind,reasoning_options,reasoning_budget_min,reasoning_budget_max,metadata_source,metadata_updated_at,catalog_provider_id,catalog_model_id,kind) VALUES ($1,$2,$3,false,$4,$5,$6,'remote',true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, provider.ID, model.Name, model.Model, model.ContextWindow, model.SupportsTools, model.SupportsVision, model.MaxOutputTokens, modalities, model.StructuredOutput, model.ReasoningKind, options, model.ReasoningBudgetMin, model.ReasoningBudgetMax, model.MetadataSource, model.MetadataUpdatedAt, model.CatalogProviderID, model.CatalogModelID, func() string {
			if model.Kind == "embedding" || model.Kind == "image" {
				return model.Kind
			}
			return "chat"
		}())
		if err != nil {
			return nil, 0, 0, err
		}
		imported++
	}
	tag, err := tx.Exec(ctx, `UPDATE models SET available=false WHERE provider_id=$1 AND source='remote' AND NOT(model=ANY($2::text[])) AND available`, provider.ID, ids)
	if err != nil {
		return nil, 0, 0, err
	}
	unavailable = int(tag.RowsAffected())
	if _, err = tx.Exec(ctx, `UPDATE providers SET last_synced_at=now() WHERE id=$1`, provider.ID); err != nil {
		return nil, 0, 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, 0, 0, err
	}
	// Refresh catalog metadata while preserving field-level admin overrides.
	all, err := s.Models(ctx, false)
	if err != nil {
		return nil, 0, 0, err
	}
	out := []Model{}
	for _, model := range all {
		if model.ProviderID != provider.ID {
			continue
		}
		if reference, ok := references[model.Model]; ok {
			updated := EnrichCatalogModel(model, provider, reference, reference.Match)
			updated.Name = model.Name
			model = updated
		}
		model, err = s.SaveModel(ctx, InferImageMetadata(model))
		if err != nil {
			return nil, 0, 0, err
		}
		out = append(out, model)
	}
	return out, imported, unavailable, nil
}

func (s *Store) SaveProviderTest(ctx context.Context, id string, result any) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE providers SET last_test=$2 WHERE id=$1`, id, data)
	return err
}
func (s *Store) SaveModelTest(ctx context.Context, id string, result any) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE models SET last_test=$2 WHERE id=$1`, id, data)
	return err
}

func SanitizeProviderError(provider Provider, err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	for _, secret := range append([]string{provider.APIKey}, headerValues(provider.Headers)...) {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	return fmt.Sprintf("%.3000s", message)
}
func headerValues(headers map[string]string) []string {
	values := make([]string, 0, len(headers))
	for _, value := range headers {
		values = append(values, value)
	}
	return values
}
