package storage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	Role         string    `json:"role"`
	Enabled      bool      `json:"enabled"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
}

type Provider struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Protocol          string            `json:"protocol"`
	BaseURL           string            `json:"base_url"`
	APIKey            string            `json:"-"`
	HasAPIKey         bool              `json:"has_api_key"`
	Enabled           bool              `json:"enabled"`
	Headers           map[string]string `json:"-"`
	TimeoutSeconds    int               `json:"timeout_seconds"`
	DiscoverModels    bool              `json:"discover_models"`
	AllowNoKey        bool              `json:"allow_no_key"`
	CatalogProviderID string            `json:"catalog_provider_id"`
	LastSyncedAt      *time.Time        `json:"last_synced_at"`
	LastTest          json.RawMessage   `json:"last_test"`
	Icon              string            `json:"icon,omitempty"`
}

type Modalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}
type ReasoningOption struct {
	Type   string   `json:"type"`
	Values []string `json:"values,omitempty"`
	Min    int      `json:"min,omitempty"`
	Max    int      `json:"max,omitempty"`
}

type ImageConfig struct {
	Size         string `json:"size,omitempty"`
	Quality      string `json:"quality,omitempty"`
	OutputFormat string `json:"output_format,omitempty"`
	Background   string `json:"background,omitempty"`
	SupportsEdit *bool  `json:"supports_edit,omitempty"`
}

type Model struct {
	ID                      string                     `json:"id"`
	ProviderID              string                     `json:"provider_id"`
	ProviderName            string                     `json:"provider_name"`
	Name                    string                     `json:"name"`
	Model                   string                     `json:"model"`
	Enabled                 bool                       `json:"enabled"`
	IsDefault               bool                       `json:"is_default"`
	ContextWindow           int                        `json:"context_window"`
	SupportsTools           bool                       `json:"supports_tools"`
	SupportsVision          bool                       `json:"supports_vision"`
	SupportsImageGeneration bool                       `json:"supports_image_generation"`
	ImageConfig             ImageConfig                `json:"image_config"`
	Efforts                 []string                   `json:"efforts"`
	DefaultEffort           string                     `json:"default_effort"`
	EffortParameter         string                     `json:"effort_parameter"`
	EffortMapping           map[string]json.RawMessage `json:"effort_mapping"`
	Source                  string                     `json:"source"`
	Kind                    string                     `json:"kind"`
	Available               bool                       `json:"available"`
	MaxOutputTokens         int                        `json:"max_output_tokens"`
	Modalities              Modalities                 `json:"modalities"`
	StructuredOutput        bool                       `json:"structured_output"`
	ReasoningKind           string                     `json:"reasoning_kind"`
	ReasoningOptions        []ReasoningOption          `json:"reasoning_options"`
	ReasoningBudgetMin      int                        `json:"reasoning_budget_min"`
	ReasoningBudgetMax      int                        `json:"reasoning_budget_max"`
	ReasoningBudgetDefault  int                        `json:"reasoning_budget_default"`
	MetadataSource          string                     `json:"metadata_source"`
	MetadataUpdatedAt       *time.Time                 `json:"metadata_updated_at"`
	CatalogProviderID       string                     `json:"catalog_provider_id"`
	CatalogModelID          string                     `json:"catalog_model_id"`
	LastTest                json.RawMessage            `json:"last_test"`
	MetadataOverrides       map[string]bool            `json:"metadata_overrides"`
	MetadataKnown           map[string]bool            `json:"metadata_known"`
	MetadataMatch           string                     `json:"metadata_match"`
	Icon                    string                     `json:"icon,omitempty"`
	ProviderIcon            string                     `json:"provider_icon,omitempty"`
}

type Settings struct {
	SystemPrompt      string `json:"system_prompt"`
	MaxToolRounds     int    `json:"max_tool_rounds"`
	CompactionModelID string `json:"compaction_model_id"`
	MemoryModelID     string `json:"memory_model_id"`
	EmbeddingModelID  string `json:"embedding_model_id"`
	TitleModelID      string `json:"title_model_id"`
	ImageModelID      string `json:"image_model_id"`
}

// Bootstrap only inserts missing deployment config; editing the admin UI wins
// over environment variables on every subsequent restart.
func (s *Store) BootstrapUser(ctx context.Context, user User) error {
	_, err := s.db.Exec(ctx, `INSERT INTO users (id,username,display_name,password_hash,role,enabled) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (username) DO NOTHING`, user.ID, user.Username, user.DisplayName, user.PasswordHash, user.Role)
	return err
}
func (s *Store) EnsureAdmin(ctx context.Context, username string) error {
	_, err := s.db.Exec(ctx, `UPDATE users SET role='admin' WHERE username=$1 AND NOT EXISTS(SELECT 1 FROM users WHERE role='admin' AND enabled)`, username)
	return err
}
func (s *Store) BootstrapProvider(ctx context.Context, baseURL, key, name string) error {
	if baseURL == "" || key == "" || name == "" {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM providers)`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return tx.Commit(ctx)
	}
	var providerID string
	if err = tx.QueryRow(ctx, `INSERT INTO providers (name,base_url,api_key) VALUES ('默认服务',$1,$2) RETURNING id::text`, strings.TrimRight(baseURL, "/"), key).Scan(&providerID); err != nil {
		return err
	}
	// Capability options are not invented from a model's marketing name.
	_, err = tx.Exec(ctx, `INSERT INTO models (provider_id,name,model,is_default) VALUES ($1,$2,$2,true)`, providerID, name)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) GetUser(ctx context.Context, username string) (User, error) {
	var u User
	err := s.db.QueryRow(ctx, `SELECT id,username,display_name,password_hash,role,enabled,created_at FROM users WHERE username=$1`, username).Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt)
	return u, err
}
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.Query(ctx, `SELECT id,username,display_name,password_hash,role,enabled,created_at FROM users ORDER BY created_at,username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, u)
	}
	return items, rows.Err()
}
func (s *Store) SaveUser(ctx context.Context, u User) (User, error) {
	passwordChanged := u.PasswordHash != ""
	if u.ID == "" {
		u.ID = u.Username
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return u, err
	}
	defer tx.Rollback(context.Background())
	// The simple role model still must not remove the only working admin.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891302)`); err != nil {
		return u, err
	}
	if u.Role != "admin" || !u.Enabled {
		var last bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='admin' AND enabled) AND (SELECT count(*) FROM users WHERE role='admin' AND enabled)=1`, u.ID).Scan(&last)
		if err != nil {
			return u, err
		}
		if last {
			return u, errors.New("请至少保留一位可用的管理员")
		}
	}
	err = tx.QueryRow(ctx, `INSERT INTO users (id,username,display_name,password_hash,role,enabled) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=CASE WHEN EXCLUDED.password_hash='' THEN users.password_hash ELSE EXCLUDED.password_hash END,role=EXCLUDED.role,enabled=EXCLUDED.enabled
       RETURNING id,username,display_name,password_hash,role,enabled,created_at`, u.ID, u.Username, u.DisplayName, u.PasswordHash, u.Role, u.Enabled).Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt)
	if err != nil {
		return u, err
	}
	if !u.Enabled || passwordChanged { // Tokens also re-check role/enabled on every request.
		if _, err = tx.Exec(ctx, `DELETE FROM login_sessions WHERE user_id=$1`, u.ID); err != nil {
			return u, err
		}
	}
	return u, tx.Commit(ctx)
}
func (s *Store) CreateLogin(ctx context.Context, hash, userID string, expires time.Time) error {
	_, err := s.db.Exec(ctx, `DELETE FROM login_sessions WHERE expires_at < now()`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `INSERT INTO login_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, hash, userID, expires)
	return err
}
func (s *Store) LoginUser(ctx context.Context, hash string) (User, error) {
	var u User
	err := s.db.QueryRow(ctx, `SELECT u.id,u.username,u.display_name,u.role,u.enabled,u.created_at FROM login_sessions l JOIN users u ON u.id=l.user_id WHERE l.token_hash=$1 AND l.expires_at>now() AND u.enabled`, hash).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Enabled, &u.CreatedAt)
	return u, err
}
func (s *Store) DeleteLogin(ctx context.Context, hash string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM login_sessions WHERE token_hash=$1`, hash)
	return err
}

const providerColumns = `id::text,name,protocol,base_url,api_key,enabled,headers,timeout_seconds,discover_models,allow_no_key,catalog_provider_id,last_synced_at,last_test`

func scanProvider(row pgx.Row) (Provider, error) {
	var p Provider
	var headers []byte
	err := row.Scan(&p.ID, &p.Name, &p.Protocol, &p.BaseURL, &p.APIKey, &p.Enabled, &headers, &p.TimeoutSeconds, &p.DiscoverModels, &p.AllowNoKey, &p.CatalogProviderID, &p.LastSyncedAt, &p.LastTest)
	if err == nil {
		err = json.Unmarshal(headers, &p.Headers)
	}
	p.HasAPIKey = p.APIKey != ""
	p.Icon = ProviderBrandIcon(p)
	return p, err
}
func (s *Store) Providers(ctx context.Context) ([]Provider, error) {
	rows, err := s.db.Query(ctx, `SELECT `+providerColumns+` FROM providers ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Provider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (s *Store) Provider(ctx context.Context, id string) (Provider, error) {
	return scanProvider(s.db.QueryRow(ctx, `SELECT `+providerColumns+` FROM providers WHERE id=$1`, id))
}
func (s *Store) SaveProvider(ctx context.Context, p Provider) (Provider, error) {
	if p.Headers == nil {
		p.Headers = map[string]string{}
	}
	headers, err := json.Marshal(p.Headers)
	if err != nil {
		return p, err
	}
	if p.TimeoutSeconds == 0 {
		p.TimeoutSeconds = 480
	}
	if p.ID == "" {
		err = s.db.QueryRow(ctx, `INSERT INTO providers (name,protocol,base_url,api_key,enabled,headers,timeout_seconds,discover_models,allow_no_key,catalog_provider_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`, p.Name, p.Protocol, p.BaseURL, p.APIKey, p.Enabled, headers, p.TimeoutSeconds, p.DiscoverModels, p.AllowNoKey, p.CatalogProviderID).Scan(&p.ID)
	} else {
		err = s.db.QueryRow(ctx, `UPDATE providers SET name=$2,protocol=$3,base_url=$4,api_key=$5,enabled=$6,headers=$7,timeout_seconds=$8,discover_models=$9,allow_no_key=$10,catalog_provider_id=$11 WHERE id=$1 RETURNING id::text`, p.ID, p.Name, p.Protocol, p.BaseURL, p.APIKey, p.Enabled, headers, p.TimeoutSeconds, p.DiscoverModels, p.AllowNoKey, p.CatalogProviderID).Scan(&p.ID)
	}
	if err != nil {
		return p, err
	}
	return s.Provider(ctx, p.ID)
}
func (s *Store) DeleteProvider(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM providers WHERE id=$1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}

const modelColumns = `m.id::text,m.provider_id::text,p.name,m.name,m.model,m.enabled,m.is_default,m.context_window,m.supports_tools,m.supports_vision,m.efforts,m.default_effort,m.effort_parameter,m.effort_mapping,m.source,m.available,m.max_output_tokens,m.modalities,m.structured_output,m.reasoning_kind,m.reasoning_options,m.reasoning_budget_min,m.reasoning_budget_max,m.reasoning_budget_default,m.metadata_source,m.metadata_updated_at,m.catalog_provider_id,m.catalog_model_id,m.last_test,m.kind,m.metadata_overrides,m.metadata_known,m.metadata_match,p.catalog_provider_id,p.base_url,m.supports_image_generation,m.image_config`

func scanModel(row pgx.Row) (Model, error) {
	var m Model
	var efforts, mapping, modalities, options, overrides, known, imageConfig []byte
	var catalogProvider, baseURL string
	err := row.Scan(&m.ID, &m.ProviderID, &m.ProviderName, &m.Name, &m.Model, &m.Enabled, &m.IsDefault, &m.ContextWindow, &m.SupportsTools, &m.SupportsVision, &efforts, &m.DefaultEffort, &m.EffortParameter, &mapping, &m.Source, &m.Available, &m.MaxOutputTokens, &modalities, &m.StructuredOutput, &m.ReasoningKind, &options, &m.ReasoningBudgetMin, &m.ReasoningBudgetMax, &m.ReasoningBudgetDefault, &m.MetadataSource, &m.MetadataUpdatedAt, &m.CatalogProviderID, &m.CatalogModelID, &m.LastTest, &m.Kind, &overrides, &known, &m.MetadataMatch, &catalogProvider, &baseURL, &m.SupportsImageGeneration, &imageConfig)
	if err != nil {
		return m, err
	}
	for _, item := range []struct {
		data   []byte
		target any
	}{{efforts, &m.Efforts}, {mapping, &m.EffortMapping}, {modalities, &m.Modalities}, {options, &m.ReasoningOptions}, {overrides, &m.MetadataOverrides}, {known, &m.MetadataKnown}, {imageConfig, &m.ImageConfig}} {
		if err = json.Unmarshal(item.data, item.target); err != nil {
			return m, err
		}
	}
	m.Icon = ModelBrandIcon(m.CatalogProviderID, m.CatalogModelID, m.Model)
	m.ProviderIcon = ProviderBrandIcon(Provider{Name: m.ProviderName, CatalogProviderID: catalogProvider, BaseURL: baseURL})
	return m, nil
}
func (s *Store) Models(ctx context.Context, published bool) ([]Model, error) {
	return s.modelsOfKind(ctx, published, "chat")
}
func (s *Store) ImageModels(ctx context.Context) ([]Model, error) {
	return s.modelsOfKind(ctx, true, "image")
}
func (s *Store) modelsOfKind(ctx context.Context, published bool, kind string) ([]Model, error) {
	query := `SELECT ` + modelColumns + ` FROM models m JOIN providers p ON p.id=m.provider_id`
	var args []any
	if published {
		query += ` WHERE m.enabled AND p.enabled AND m.available AND m.kind=$1`
		if kind == "image" {
			query += ` AND m.supports_image_generation`
		}
		args = append(args, kind)
	}
	query += ` ORDER BY m.is_default DESC,m.created_at,m.id`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Model{}
	for rows.Next() {
		m, err := scanModel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Store) Model(ctx context.Context, id string) (Model, error) {
	return scanModel(s.db.QueryRow(ctx, `SELECT `+modelColumns+` FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, id))
}
func (s *Store) SaveModel(ctx context.Context, m Model) (Model, error) {
	m = InferImageMetadata(m)
	if m.Efforts == nil {
		m.Efforts = []string{}
	}
	if m.EffortMapping == nil {
		m.EffortMapping = map[string]json.RawMessage{}
	}
	if m.ReasoningOptions == nil {
		m.ReasoningOptions = []ReasoningOption{}
	}
	if m.MetadataOverrides == nil {
		m.MetadataOverrides = map[string]bool{}
	}
	if m.MetadataKnown == nil {
		m.MetadataKnown = map[string]bool{}
	}
	if m.Modalities.Input == nil {
		m.Modalities.Input = []string{"text"}
	}
	if m.Modalities.Output == nil {
		m.Modalities.Output = []string{"text"}
	}
	if m.Kind == "" {
		m.Kind = "chat"
	}
	if m.Source == "" {
		m.Source = "custom"
	}
	if m.ReasoningKind == "" {
		m.ReasoningKind = "unknown"
	}
	efforts, _ := json.Marshal(m.Efforts)
	mapping, _ := json.Marshal(m.EffortMapping)
	modalities, _ := json.Marshal(m.Modalities)
	options, _ := json.Marshal(m.ReasoningOptions)
	overrides, _ := json.Marshal(m.MetadataOverrides)
	known, _ := json.Marshal(m.MetadataKnown)
	imageConfig, _ := json.Marshal(m.ImageConfig)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return m, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891303)`); err != nil {
		return m, err
	}
	if m.IsDefault {
		if _, err = tx.Exec(ctx, `UPDATE models SET is_default=false WHERE is_default`); err != nil {
			return m, err
		}
	}
	if m.ID == "" {
		err = tx.QueryRow(ctx, `INSERT INTO models (provider_id,name,model,enabled,is_default,context_window,supports_tools,supports_vision,efforts,default_effort,effort_parameter,effort_mapping,source,available,max_output_tokens,modalities,structured_output,reasoning_kind,reasoning_options,reasoning_budget_min,reasoning_budget_max,reasoning_budget_default,metadata_source,metadata_updated_at,catalog_provider_id,catalog_model_id,kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id::text`, m.ProviderID, m.Name, m.Model, m.Enabled, m.IsDefault, m.ContextWindow, m.SupportsTools, m.SupportsVision, efforts, m.DefaultEffort, m.EffortParameter, mapping, m.Source, m.Available, m.MaxOutputTokens, modalities, m.StructuredOutput, m.ReasoningKind, options, m.ReasoningBudgetMin, m.ReasoningBudgetMax, m.ReasoningBudgetDefault, m.MetadataSource, m.MetadataUpdatedAt, m.CatalogProviderID, m.CatalogModelID, m.Kind).Scan(&m.ID)
	} else {
		err = tx.QueryRow(ctx, `UPDATE models SET provider_id=$2,name=$3,model=$4,enabled=$5,is_default=$6,context_window=$7,supports_tools=$8,supports_vision=$9,efforts=$10,default_effort=$11,effort_parameter=$12,effort_mapping=$13,source=$14,available=$15,max_output_tokens=$16,modalities=$17,structured_output=$18,reasoning_kind=$19,reasoning_options=$20,reasoning_budget_min=$21,reasoning_budget_max=$22,reasoning_budget_default=$23,metadata_source=$24,metadata_updated_at=$25,catalog_provider_id=$26,catalog_model_id=$27,kind=$28 WHERE id=$1 RETURNING id::text`, m.ID, m.ProviderID, m.Name, m.Model, m.Enabled, m.IsDefault, m.ContextWindow, m.SupportsTools, m.SupportsVision, efforts, m.DefaultEffort, m.EffortParameter, mapping, m.Source, m.Available, m.MaxOutputTokens, modalities, m.StructuredOutput, m.ReasoningKind, options, m.ReasoningBudgetMin, m.ReasoningBudgetMax, m.ReasoningBudgetDefault, m.MetadataSource, m.MetadataUpdatedAt, m.CatalogProviderID, m.CatalogModelID, m.Kind).Scan(&m.ID)
	}
	if err != nil {
		return m, err
	}
	_, err = tx.Exec(ctx, `UPDATE models SET metadata_overrides=$2,metadata_known=$3,metadata_match=$4,supports_image_generation=$5,image_config=$6 WHERE id=$1`, m.ID, overrides, known, m.MetadataMatch, m.SupportsImageGeneration, imageConfig)
	if err != nil {
		return m, err
	}
	if err = tx.Commit(ctx); err != nil {
		return m, err
	}
	return s.Model(ctx, m.ID)
}
func (s *Store) DeleteModel(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM models WHERE id=$1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var v Settings
	err := s.db.QueryRow(ctx, `SELECT system_prompt,max_tool_rounds,compaction_model_id,memory_model_id,embedding_model_id,title_model_id,image_model_id FROM app_settings WHERE id=true`).Scan(&v.SystemPrompt, &v.MaxToolRounds, &v.CompactionModelID, &v.MemoryModelID, &v.EmbeddingModelID, &v.TitleModelID, &v.ImageModelID)
	return v, err
}
func (s *Store) SaveSettings(ctx context.Context, v Settings) error {
	_, err := s.db.Exec(ctx, `UPDATE app_settings SET system_prompt=$1,max_tool_rounds=$2,compaction_model_id=$3,memory_model_id=$4,embedding_model_id=$5,title_model_id=$6,image_model_id=$7 WHERE id=true`, v.SystemPrompt, v.MaxToolRounds, v.CompactionModelID, v.MemoryModelID, v.EmbeddingModelID, v.TitleModelID, v.ImageModelID)
	return err
}
func (s *Store) Ping(ctx context.Context) error { return s.db.Ping(ctx) }
