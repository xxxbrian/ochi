package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"ochi/server/internal/agent"
	"ochi/server/internal/product"
	"ochi/server/internal/storage"
)

func (s *Server) registerAdminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/models", s.auth.require(s.publishedModels))
	mux.HandleFunc("GET /api/image-models", s.auth.require(s.publishedImageModels))
	for _, path := range []string{"GET /api/admin/providers", "POST /api/admin/providers", "PATCH /api/admin/providers/{id}", "DELETE /api/admin/providers/{id}"} {
		mux.HandleFunc(path, s.auth.admin(s.adminProviders))
	}
	mux.HandleFunc("POST /api/admin/providers/{id}/test", s.auth.admin(s.testProvider))
	mux.HandleFunc("GET /api/admin/providers/{id}/models", s.auth.admin(s.discoverProviderModels))
	mux.HandleFunc("POST /api/admin/providers/{id}/sync", s.auth.admin(s.syncProviderModels))
	mux.HandleFunc("POST /api/admin/providers/{id}/metadata", s.auth.admin(s.refreshProviderMetadata))
	mux.HandleFunc("GET /api/admin/catalog/resolve", s.auth.admin(s.resolveModelMetadata))
	mux.HandleFunc("GET /api/admin/catalog/providers", s.auth.admin(s.modelCatalog))
	mux.HandleFunc("GET /api/admin/catalog/models", s.auth.admin(s.modelCatalog))
	mux.HandleFunc("POST /api/admin/models/{id}/test", s.auth.admin(s.testModel))
	mux.HandleFunc("POST /api/admin/models/{id}/catalog", s.auth.admin(s.applyModelCatalog))
	for _, path := range []string{"GET /api/admin/models", "POST /api/admin/models", "PATCH /api/admin/models/{id}", "DELETE /api/admin/models/{id}"} {
		mux.HandleFunc(path, s.auth.admin(s.adminModels))
	}
	for _, path := range []string{"GET /api/admin/users", "POST /api/admin/users", "PATCH /api/admin/users/{id}", "DELETE /api/admin/users/{id}"} {
		mux.HandleFunc(path, s.auth.admin(s.adminUsers))
	}
	mux.HandleFunc("GET /api/admin/settings", s.auth.admin(s.adminSettings))
	mux.HandleFunc("PATCH /api/admin/settings", s.auth.admin(s.adminSettings))
	mux.HandleFunc("GET /api/admin/search", s.auth.admin(s.adminSearch))
	mux.HandleFunc("PATCH /api/admin/search", s.auth.admin(s.adminSearch))
	mux.HandleFunc("POST /api/admin/search/test", s.auth.admin(s.testSearch))
	mux.HandleFunc("GET /api/admin/health", s.auth.admin(s.adminHealth))
	mux.HandleFunc("GET /api/admin/runs", s.auth.admin(s.adminRunList))
	mux.HandleFunc("GET /api/admin/runs/stats", s.auth.admin(s.adminRunStats))
	mux.HandleFunc("GET /api/admin/runs/{id}", s.auth.admin(s.adminRunDetail))
	for _, path := range []string{
		"GET /api/admin/runs/{id}/requests", "GET /api/admin/runs/{id}/requests/{request}", "DELETE /api/admin/runs/{id}/requests",
		"GET /api/admin/requests", "GET /api/admin/requests/{request}", "DELETE /api/admin/requests",
	} {
		mux.HandleFunc(path, s.auth.admin(s.adminRequests))
	}
}
func (s *Server) publishedModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.Models(r.Context(), true)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// Provider request encoding and secret-bearing configuration are not exposed
	// to ordinary chat clients; only administrator-published choices are visible.
	for i := range models {
		models[i].EffortMapping = nil
		if models[i].EffortParameter == "" {
			models[i].Efforts = []string{}
			models[i].DefaultEffort = ""
			if models[i].ReasoningKind != "none" && models[i].ReasoningKind != "always" {
				models[i].ReasoningKind = "unknown"
			}
		}
		// Connection-test errors are administrator diagnostics and may contain
		// endpoint details. Users receive only published display capabilities.
		models[i].LastTest = nil
	}
	writeJSON(w, http.StatusOK, models)
}
func (s *Server) adminProviders(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if r.Method == http.MethodGet {
		items, err := s.store.Providers(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		public := make([]map[string]any, 0, len(items))
		for _, item := range items {
			public = append(public, publicProvider(item))
		}
		writeJSON(w, http.StatusOK, public)
		return
	}
	if r.Method == http.MethodDelete {
		if err := s.store.DeleteProvider(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		s.enqueueMemoryIndexesAfterConfigChange(r.Context())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	p := storage.Provider{Enabled: true, Protocol: "openai", TimeoutSeconds: 480, DiscoverModels: true, Headers: map[string]string{}}
	if id != "" {
		var err error
		p, err = s.store.Provider(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	var req struct {
		ID                string            `json:"id"`
		Name              string            `json:"name"`
		Protocol          string            `json:"protocol"`
		BaseURL           string            `json:"base_url"`
		APIKey            string            `json:"api_key"`
		APIKeyAction      string            `json:"api_key_action"`
		Enabled           bool              `json:"enabled"`
		HasAPIKey         bool              `json:"has_api_key"`
		Headers           map[string]string `json:"headers"`
		HeaderNames       []string          `json:"header_names"`
		ClearHeaders      []string          `json:"clear_headers"`
		TimeoutSeconds    int               `json:"timeout_seconds"`
		DiscoverModels    bool              `json:"discover_models"`
		AllowNoKey        bool              `json:"allow_no_key"`
		CatalogProviderID string            `json:"catalog_provider_id"`
		LastSyncedAt      *time.Time        `json:"last_synced_at"`
		LastTest          json.RawMessage   `json:"last_test"`
	}
	req.Name, req.Protocol, req.BaseURL, req.Enabled = p.Name, p.Protocol, p.BaseURL, p.Enabled
	req.TimeoutSeconds, req.DiscoverModels, req.AllowNoKey, req.CatalogProviderID = p.TimeoutSeconds, p.DiscoverModels, p.AllowNoKey, p.CatalogProviderID
	if !decodeRequest(w, r, &req) {
		return
	}
	p.Name, p.Protocol, p.BaseURL, p.Enabled = strings.TrimSpace(req.Name), req.Protocol, strings.TrimRight(strings.TrimSpace(req.BaseURL), "/"), req.Enabled
	p.TimeoutSeconds, p.DiscoverModels, p.AllowNoKey, p.CatalogProviderID = req.TimeoutSeconds, req.DiscoverModels, req.AllowNoKey, req.CatalogProviderID
	switch req.APIKeyAction {
	case "", "keep":
		if req.APIKey != "" {
			p.APIKey = req.APIKey
		}
	case "replace":
		if req.APIKey == "" {
			writeError(w, http.StatusBadRequest, errors.New("请输入新的密钥"))
			return
		}
		p.APIKey = req.APIKey
	case "delete":
		p.APIKey = ""
	default:
		writeError(w, http.StatusBadRequest, errors.New("密钥操作无效"))
		return
	}
	if p.Headers == nil {
		p.Headers = map[string]string{}
	}
	for k, v := range req.Headers {
		if k == "" || strings.ContainsAny(k, "\r\n :") || strings.ContainsAny(v, "\r\n") {
			writeError(w, http.StatusBadRequest, errors.New("请求头格式无效"))
			return
		}
		if v != "" {
			p.Headers[k] = v
		}
	}
	for _, k := range req.ClearHeaders {
		delete(p.Headers, k)
	}
	if p.TimeoutSeconds < 5 || p.TimeoutSeconds > 1800 {
		writeError(w, http.StatusBadRequest, errors.New("请求超时应在 5 到 1800 秒之间"))
		return
	}
	parsed, err := url.Parse(p.BaseURL)
	if p.Name == "" || err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || (p.Enabled && p.APIKey == "" && !p.AllowNoKey) {
		writeError(w, http.StatusBadRequest, errors.New("请填写名称、有效服务地址和密钥；无密钥服务需显式开启"))
		return
	}
	if p.Protocol != "openai" && p.Protocol != "openai-responses" {
		writeError(w, http.StatusBadRequest, errors.New("请选择 OpenAI Chat Completions 或 Responses 协议"))
		return
	}
	result, err := s.store.SaveProvider(r.Context(), p)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	response := publicProvider(result)
	if id == "" && result.DiscoverModels {
		// Creating a provider discovers its real list immediately. An unsupported
		// listing endpoint does not discard a successfully saved connection.
		ids, _, discoverErr := fetchProviderModels(r.Context(), result)
		if discoverErr != nil {
			response["sync_error"] = storage.SanitizeProviderError(result, discoverErr)
		} else {
			refs := resolvedCatalogReferences(r.Context(), result, ids)
			if _, imported, _, syncErr := s.store.SyncProviderModels(r.Context(), result, ids, refs); syncErr != nil {
				response["sync_error"] = "模型列表未同步，请重新同步"
			} else {
				response["imported"] = imported
			}
		}
	}
	s.enqueueMemoryIndexesAfterConfigChange(r.Context())
	writeJSON(w, http.StatusOK, response)
}
func publicProvider(provider storage.Provider) map[string]any {
	data, _ := json.Marshal(provider)
	result := map[string]any{}
	_ = json.Unmarshal(data, &result)
	headers := map[string]string{}
	keys := []string{}
	for key := range provider.Headers {
		headers[key] = ""
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result["headers"], result["header_names"] = headers, keys
	return result
}

func fetchProviderModels(ctx context.Context, provider storage.Provider) ([]string, int, error) {
	seconds := provider.TimeoutSeconds
	if seconds <= 0 || seconds > 30 {
		seconds = 30
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, provider.BaseURL+"/models", nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", product.UserAgent())
	req.Header.Set("Accept", "application/json")
	if provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+provider.APIKey)
	}
	for key, value := range provider.Headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, errors.New("连接失败，请检查服务地址和网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("服务拒绝了模型列表请求 (HTTP %d)", resp.StatusCode)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&body); err != nil {
		return nil, resp.StatusCode, errors.New("服务响应不是有效模型列表")
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, model := range body.Data {
		id := strings.TrimSpace(model.ID)
		if id != "" && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	sort.Strings(ids)
	return ids, resp.StatusCode, nil
}
func (s *Server) testProvider(w http.ResponseWriter, r *http.Request) {
	provider, err := s.store.Provider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	ids, status, testErr := fetchProviderModels(r.Context(), provider)
	result := map[string]any{"ok": testErr == nil, "status": status, "checked_at": time.Now().UTC(), "models": ids}
	if testErr != nil {
		result["error"] = storage.SanitizeProviderError(provider, testErr)
	}
	if err = s.store.SaveProviderTest(r.Context(), provider.ID, result); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) discoverProviderModels(w http.ResponseWriter, r *http.Request) {
	provider, err := s.store.Provider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	ids, status, err := fetchProviderModels(r.Context(), provider)
	if err != nil {
		writeError(w, http.StatusBadGateway, errors.New(storage.SanitizeProviderError(provider, err)))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": status, "models": ids})
}
func (s *Server) syncProviderModels(w http.ResponseWriter, r *http.Request) {
	provider, err := s.store.Provider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !provider.DiscoverModels {
		writeError(w, http.StatusBadRequest, errors.New("此服务未开启模型发现"))
		return
	}
	ids, _, err := fetchProviderModels(r.Context(), provider)
	if err != nil {
		writeError(w, http.StatusBadGateway, errors.New(storage.SanitizeProviderError(provider, err)))
		return
	}
	refs := resolvedCatalogReferences(r.Context(), provider, ids)
	items, imported, unavailable, err := s.store.SyncProviderModels(r.Context(), provider, ids, refs)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	provider, _ = s.store.Provider(r.Context(), provider.ID)
	s.enqueueMemoryIndexesAfterConfigChange(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"provider": publicProvider(provider), "models": items, "imported": imported, "unavailable": unavailable})
}
func (s *Server) adminModels(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if r.Method == http.MethodGet {
		items, err := s.store.Models(r.Context(), false)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
		return
	}
	if r.Method == http.MethodDelete {
		if err := s.store.DeleteModel(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		s.enqueueMemoryIndexesAfterConfigChange(r.Context())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	m := storage.Model{Enabled: false, Available: true, Source: "custom", Kind: "chat", SupportsTools: true, ContextWindow: 0, Efforts: []string{}, ReasoningKind: "unknown", MetadataSource: "unknown", MetadataOverrides: map[string]bool{}, MetadataKnown: map[string]bool{}}
	if id != "" {
		var err error
		m, err = s.store.Model(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	var patch map[string]json.RawMessage
	if !decodeRequest(w, r, &patch) {
		return
	}
	data, marshalErr := json.Marshal(patch)
	if marshalErr != nil || json.Unmarshal(data, &m) != nil {
		writeError(w, http.StatusBadRequest, errors.New("模型配置格式无效"))
		return
	}
	if m.MetadataOverrides == nil {
		m.MetadataOverrides = map[string]bool{}
	}
	if m.MetadataKnown == nil {
		m.MetadataKnown = map[string]bool{}
	}
	for _, key := range []string{"kind", "supports_image_generation", "context_window", "max_output_tokens", "supports_tools", "supports_vision", "modalities", "structured_output", "reasoning_kind", "efforts", "default_effort", "effort_parameter", "effort_mapping", "reasoning_budget_min", "reasoning_budget_max", "reasoning_budget_default"} {
		if _, present := patch[key]; present {
			override := key
			if strings.HasPrefix(key, "reasoning_") || strings.Contains(key, "effort") {
				override = "reasoning"
			}
			m.MetadataOverrides[override] = true
			m.MetadataKnown[key] = true
			m.MetadataSource = "admin"
			now := time.Now().UTC()
			m.MetadataUpdatedAt = &now
		}
	}
	m.ID = id
	m.Name = strings.TrimSpace(m.Name)
	m.Model = strings.TrimSpace(m.Model)
	provider, err := s.store.Provider(r.Context(), m.ProviderID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if _, present := patch["name"]; present && m.Name != "" && m.Name != m.Model {
		m.MetadataOverrides["name"] = true
	}
	if id == "" || (patch["model"] != nil) || (patch["provider_id"] != nil) {
		if catalog, catalogErr := storage.FetchModelCatalog(r.Context()); catalogErr == nil {
			if reference, match, ok := storage.ResolveCatalogModel(catalog, provider, m.Model); ok {
				if id == "" && m.Name == reference.Name {
					delete(m.MetadataOverrides, "name")
				}
				m = storage.EnrichCatalogModel(m, provider, reference, match)
			}
		}
	}
	m = storage.InferImageMetadata(m)
	if m.ProviderID == "" || m.Model == "" || m.Name == "" || (m.ContextWindow != 0 && m.ContextWindow < 2048) || m.ContextWindow > 4000000 {
		writeError(w, http.StatusBadRequest, errors.New("请填写模型名称、标识、服务与有效上下文长度"))
		return
	}
	if m.IsDefault && !m.Enabled {
		writeError(w, http.StatusBadRequest, errors.New("默认模型必须启用"))
		return
	}
	if m.IsDefault && !m.Available {
		writeError(w, http.StatusBadRequest, errors.New("默认模型必须在服务中可用"))
		return
	}
	if !validEffortParameter(m.EffortParameter) {
		writeError(w, http.StatusBadRequest, errors.New("思考参数路径无效"))
		return
	}
	if m.ReasoningKind == "" {
		m.ReasoningKind = "unknown"
	}
	if len(m.Efforts) > 0 && m.ReasoningKind == "unknown" {
		m.ReasoningKind = "effort"
	}
	if !slices.Contains([]string{"unknown", "none", "effort", "toggle", "budget", "always"}, m.ReasoningKind) {
		writeError(w, http.StatusBadRequest, errors.New("思考类型无效"))
		return
	}
	if !slices.Contains([]string{"chat", "embedding", "image"}, m.Kind) {
		writeError(w, http.StatusBadRequest, errors.New("模型类型无效"))
		return
	}
	if m.Enabled && m.Kind == "chat" && m.MetadataKnown["modalities"] && len(m.Modalities.Output) > 0 && !slices.Contains(m.Modalities.Output, "text") {
		writeError(w, http.StatusBadRequest, errors.New("此模型不输出聊天文本，当前聊天协议不能启用图像或音频生成模型"))
		return
	}
	if m.Kind != "chat" && m.IsDefault {
		writeError(w, http.StatusBadRequest, errors.New("只有聊天模型可以作为默认聊天模型"))
		return
	}
	if m.Kind == "image" && !m.SupportsImageGeneration {
		writeError(w, http.StatusBadRequest, errors.New("图像模型需要启用生图能力"))
		return
	}
	if err := agent.ValidateImageOptions(agent.ImageOptions{Size: m.ImageConfig.Size, Quality: m.ImageConfig.Quality, OutputFormat: m.ImageConfig.OutputFormat, Background: m.ImageConfig.Background}); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if (len(m.Efforts) > 0 || m.ReasoningKind == "budget") && m.EffortParameter == "" {
		writeError(w, http.StatusBadRequest, errors.New("请配置服务支持的思考参数"))
		return
	}
	if m.DefaultEffort != "" && !slices.Contains(m.Efforts, m.DefaultEffort) {
		writeError(w, http.StatusBadRequest, errors.New("默认思考程度不在可用选项中"))
		return
	}
	if m.MaxOutputTokens < 0 || m.MaxOutputTokens > 4000000 || m.ReasoningBudgetMin < 0 || m.ReasoningBudgetMax < m.ReasoningBudgetMin || m.ReasoningBudgetDefault < 0 {
		writeError(w, http.StatusBadRequest, errors.New("Token 范围无效"))
		return
	}
	if m.ReasoningBudgetDefault > 0 && (m.ReasoningBudgetDefault < m.ReasoningBudgetMin || (m.ReasoningBudgetMax > 0 && m.ReasoningBudgetDefault > m.ReasoningBudgetMax)) {
		writeError(w, http.StatusBadRequest, errors.New("默认思考预算超出范围"))
		return
	}
	if m.EffortMapping == nil {
		m.EffortMapping = map[string]json.RawMessage{}
	}
	for _, effort := range m.Efforts {
		if effort == "" {
			writeError(w, http.StatusBadRequest, errors.New("思考选项不能为空"))
			return
		}
		if _, ok := m.EffortMapping[effort]; !ok {
			if m.EffortParameter != "reasoning_effort" && m.EffortParameter != "reasoning.effort" {
				writeError(w, http.StatusBadRequest, errors.New("请为每个思考选项填写服务支持的 JSON 映射"))
				return
			}
			m.EffortMapping[effort], _ = json.Marshal(effort)
		}
	}
	for _, raw := range m.EffortMapping {
		if !json.Valid(raw) || string(raw) == "null" {
			writeError(w, http.StatusBadRequest, errors.New("思考映射必须是有效 JSON 值"))
			return
		}
	}
	if id == "" {
		m.Source = "custom"
		m.Available = true
	}
	if m.IsDefault && !provider.Enabled {
		writeError(w, http.StatusBadRequest, errors.New("默认模型的服务必须启用"))
		return
	}
	item, err := s.store.SaveModel(r.Context(), m)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.enqueueMemoryIndexesAfterConfigChange(r.Context())
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := s.store.ListUsers(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, items)
		return
	}
	user := storage.User{Enabled: true, Role: "user"}
	id := r.PathValue("id")
	if id != "" {
		items, err := s.store.ListUsers(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		found := false
		for _, item := range items {
			if item.ID == id {
				user = item
				found = true
				break
			}
		}
		if !found {
			writeError(w, http.StatusNotFound, errors.New("用户不存在"))
			return
		}
	}
	var req struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
		Role        string `json:"role"`
		Enabled     bool   `json:"enabled"`
	}
	req.Username, req.DisplayName, req.Role, req.Enabled = user.Username, user.DisplayName, user.Role, user.Enabled
	if r.Method == http.MethodDelete {
		req.Enabled = false
	} else if !decodeRequest(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.Username == "__admin__" {
		writeError(w, http.StatusBadRequest, errors.New("此用户名为系统保留名称"))
		return
	}
	if req.Username == "" || req.DisplayName == "" || (req.Role != "user" && req.Role != "admin") || (id == "" && len(req.Password) < 6) {
		writeError(w, http.StatusBadRequest, errors.New("请填写用户名、显示名称、角色和至少六位密码"))
		return
	}
	if id != "" && req.Username != user.Username {
		writeError(w, http.StatusBadRequest, errors.New("用户名不能修改"))
		return
	}
	user.Username, user.DisplayName, user.Role, user.Enabled = req.Username, req.DisplayName, req.Role, req.Enabled
	user.PasswordHash = ""
	if req.Password != "" {
		if len(req.Password) < 6 {
			writeError(w, http.StatusBadRequest, errors.New("密码至少六位"))
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, http.StatusBadRequest, errors.New("密码过长"))
			return
		}
		user.PasswordHash = string(hash)
	}
	item, err := s.store.SaveUser(r.Context(), user)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
func (s *Server) adminSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPatch {
		// Keep partial updates and the live switch in the same commit order.
		s.settingsUpdateMu.Lock()
		defer s.settingsUpdateMu.Unlock()
	}
	settings, err := s.store.Settings(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if r.Method == http.MethodPatch {
		previous := settings
		patch := adminSettingsPatch{Settings: &settings}
		if !decodeRequest(w, r, &patch) {
			return
		}
		if err := patch.applyDebugMode(); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		withoutDebug := settings
		withoutDebug.DebugMode = previous.DebugMode
		if withoutDebug == previous {
			if err := s.store.SaveDebugMode(r.Context(), settings.DebugMode); err != nil {
				writeStoreError(w, err)
				return
			}
			s.debugMode.Store(settings.DebugMode)
			writeJSON(w, http.StatusOK, settings)
			return
		}
		if settings.MaxToolRounds < 1 || settings.MaxToolRounds > 200 {
			writeError(w, http.StatusBadRequest, errors.New("操作上限应在 1 到 200 之间"))
			return
		}
		for _, slot := range []struct{ id, kind string }{{settings.CompactionModelID, "chat"}, {settings.MemoryModelID, "chat"}, {settings.EmbeddingModelID, "embedding"}, {settings.TitleModelID, "chat"}, {settings.ImageModelID, "image"}} {
			if slot.id == "" {
				continue
			}
			model, modelErr := s.store.Model(r.Context(), slot.id)
			if modelErr != nil {
				writeError(w, http.StatusBadRequest, errors.New("辅助模型不存在"))
				return
			}
			provider, providerErr := s.store.Provider(r.Context(), model.ProviderID)
			if providerErr != nil || !provider.Enabled || !model.Available || model.Kind != slot.kind {
				writeError(w, http.StatusBadRequest, errors.New("辅助模型类型不符或服务不可用"))
				return
			}
			if slot.kind == "image" && (!model.Enabled || !model.SupportsImageGeneration) {
				writeError(w, http.StatusBadRequest, errors.New("生图模型需要先启用"))
				return
			}
		}
		if err := s.store.SaveSettings(r.Context(), settings); err != nil {
			writeStoreError(w, err)
			return
		}
		s.debugMode.Store(settings.DebugMode)
		if settings.EmbeddingModelID != previous.EmbeddingModelID {
			s.enqueueMemoryIndexesAfterConfigChange(r.Context())
		}
	}
	writeJSON(w, http.StatusOK, settings)
}

func validEffortParameter(parameter string) bool {
	return slices.Contains([]string{"", "reasoning_effort", "reasoning.effort", "reasoning.enabled", "reasoning.max_tokens", "thinking", "thinking.type", "thinking.budget_tokens", "thinking_budget", "thinkingBudget", "thinkingLevel", "reasoning.budget_tokens", "enable_thinking"}, parameter)
}

func (s *Server) modelConfig(ctx context.Context, model storage.Model, provider storage.Provider, effort string, settings storage.Settings) *agent.Config {
	config := &agent.Config{Protocol: provider.Protocol, BaseURL: provider.BaseURL, APIKey: provider.APIKey, Headers: provider.Headers, TimeoutSeconds: provider.TimeoutSeconds, AllowNoKey: provider.AllowNoKey, Model: model.Model, ModelID: model.ID, ProviderID: model.ProviderID, Effort: effort, EffortParameter: model.EffortParameter, EffortValue: model.EffortMapping[effort], EffortMapping: model.EffortMapping, ReasoningKind: model.ReasoningKind, ReasoningBudgetMin: model.ReasoningBudgetMin, ReasoningBudgetMax: model.ReasoningBudgetMax, ReasoningBudget: model.ReasoningBudgetDefault, ContextWindow: model.ContextWindow, OutputTokenLimit: model.MaxOutputTokens, SupportsTools: model.SupportsTools, SupportsVision: model.SupportsVision, SystemPrompt: settings.SystemPrompt, MaxToolRounds: settings.MaxToolRounds, Tools: s.tools}
	s.configureProviderDebug(config)
	config.SupportsTools = model.SupportsTools || !model.MetadataKnown["supports_tools"]
	config.SupportsVision = model.SupportsVision || !model.MetadataKnown["supports_vision"]
	if !model.MetadataOverrides["reasoning"] && (config.EffortParameter == "reasoning_effort" || config.EffortParameter == "reasoning.effort") {
		// Keep catalog-derived mappings aligned when the provider protocol changes.
		// Explicit administrator dialects remain untouched.
		if parameter := storage.CatalogEffortParameter(provider); parameter != "" {
			config.EffortParameter = parameter
		}
	}
	if strings.HasPrefix(effort, "budget:") {
		config.ReasoningBudget, _ = strconv.Atoi(strings.TrimPrefix(effort, "budget:"))
	}
	if settings.CompactionModelID != "" {
		if auxiliary, err := s.store.Model(ctx, settings.CompactionModelID); err == nil && auxiliary.Kind == "chat" && auxiliary.Available {
			if auxiliaryProvider, err := s.store.Provider(ctx, auxiliary.ProviderID); err == nil && auxiliaryProvider.Enabled {
				options := settings
				options.CompactionModelID = ""
				config.CompactionConfig = s.modelConfig(ctx, auxiliary, auxiliaryProvider, auxiliary.DefaultEffort, options)
			}
		}
	}
	return config
}

func (s *Server) modelCatalog(w http.ResponseWriter, r *http.Request) {
	catalog, err := storage.FetchModelCatalog(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/providers") {
		items := make([]storage.CatalogProvider, 0, len(catalog))
		for _, provider := range catalog {
			items = append(items, provider)
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
		writeJSON(w, http.StatusOK, items)
		return
	}
	provider, ok := catalog[r.URL.Query().Get("provider")]
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("能力目录中没有此服务"))
		return
	}
	query := strings.ToLower(r.URL.Query().Get("q"))
	items := []storage.CatalogModel{}
	for _, model := range provider.Models {
		if query == "" || strings.Contains(strings.ToLower(model.ID+" "+model.Name), query) {
			items = append(items, model)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) applyModelCatalog(w http.ResponseWriter, r *http.Request) {
	model, err := s.store.Model(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var request struct {
		ProviderID     string `json:"catalog_provider_id"`
		ModelID        string `json:"catalog_model_id"`
		Apply          bool   `json:"apply"`
		Auto           bool   `json:"auto"`
		ResetOverrides bool   `json:"reset_overrides"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	catalog, err := storage.FetchModelCatalog(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	provider, err := s.store.Provider(r.Context(), model.ProviderID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	reference, ok := catalog[request.ProviderID].Models[request.ModelID]
	match := "manual-catalog"
	if request.Auto {
		reference, match, ok = storage.ResolveCatalogModel(catalog, provider, model.Model)
	}
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("未找到对应模型能力"))
		return
	}
	if !request.Apply {
		writeJSON(w, http.StatusOK, reference)
		return
	}
	if request.ResetOverrides || !request.Auto {
		model.MetadataOverrides = map[string]bool{}
	}
	model = storage.EnrichCatalogModel(model, provider, reference, match)
	model, err = s.store.SaveModel(r.Context(), model)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.enqueueMemoryIndexesAfterConfigChange(r.Context())
	writeJSON(w, http.StatusOK, model)
}

func (s *Server) testModel(w http.ResponseWriter, r *http.Request) {
	model, err := s.store.Model(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	provider, err := s.store.Provider(r.Context(), model.ProviderID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var request struct {
		Effort       string `json:"effort"`
		BudgetTokens int    `json:"budget_tokens"`
	}
	if r.ContentLength != 0 && !decodeRequest(w, r, &request) {
		return
	}
	if request.Effort != "" && !slices.Contains(model.Efforts, request.Effort) {
		writeError(w, http.StatusBadRequest, errors.New("思考程度不在此模型支持的选项中"))
		return
	}
	if request.BudgetTokens > 0 {
		if model.ReasoningKind != "budget" || request.BudgetTokens < model.ReasoningBudgetMin || (model.ReasoningBudgetMax > 0 && request.BudgetTokens > model.ReasoningBudgetMax) {
			writeError(w, http.StatusBadRequest, errors.New("思考预算超出范围"))
			return
		}
		request.Effort = fmt.Sprintf("budget:%d", request.BudgetTokens)
	}
	config := s.modelConfig(r.Context(), model, provider, request.Effort, storage.Settings{})
	timeout := 60 * time.Second
	if model.Kind == "image" {
		timeout = 180 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	result := map[string]any{"ok": false, "checked_at": time.Now().UTC(), "effort": request.Effort, "parameter_accepted": false}
	if model.Kind == "image" {
		options := imageOptions(model)
		options.Prompt = "A small orange circle on a plain white background. No text."
		var generated agent.GeneratedImage
		generated, err = agent.GenerateImage(ctx, *config, options)
		if err == nil {
			var file storage.Artifact
			file, err = s.saveGeneratedImage(ctx, agent.RunScope{UserID: currentUser(r).ID}, model, options, generated)
			if err == nil {
				result["artifact"] = file.Attachment()
			}
		}
	} else if model.Kind == "embedding" {
		_, err = agent.Embed(ctx, *config, []string{"connection test"})
	} else {
		// Use the actual selected parameter for acceptance, not AuxiliaryConfig,
		// which deliberately lowers effort for summary/memory work.
		err = agent.TestCompletion(ctx, *config)
	}
	result["ok"] = err == nil
	result["parameter_accepted"] = err == nil && request.Effort != ""
	if err != nil {
		result["error"] = storage.SanitizeProviderError(provider, err)
	}
	if saveErr := s.store.SaveModelTest(r.Context(), model.ID, result); saveErr != nil {
		writeStoreError(w, saveErr)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) adminHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	status := "ok"
	if s.store.Ping(ctx) != nil {
		status = "error"
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "database": status, "tools_configured": s.tools != nil, "runtime": "single_process"})
}
