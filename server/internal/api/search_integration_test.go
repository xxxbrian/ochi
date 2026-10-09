package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
	"ochi/server/internal/websearch"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open performs startup recovery, so this opt-in fixture must never resolve
// application tables: only the explicitly named QA DB and its owned schema.
func searchIntegrationStore(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("OCHI_PROCESS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set OCHI_PROCESS_TEST_DATABASE_URL to the disposable ochi_process_qa database")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid search QA database configuration")
	}
	if config.ConnConfig.Database != "ochi_process_qa" || config.ConnConfig.RuntimeParams["options"] != "" {
		t.Fatal("refusing search integration test outside the explicit QA database")
	}
	address, err := url.Parse(dsn)
	if err != nil || (address.Scheme != "postgres" && address.Scheme != "postgresql") {
		t.Fatal("search QA fixture requires a PostgreSQL URI")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	config.ConnConfig.RuntimeParams["search_path"] = "public"
	config.MaxConns = 2
	admin, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal("could not connect to search QA database")
	}
	var database string
	if err := admin.QueryRow(ctx, "SELECT current_database()").Scan(&database); err != nil || database != "ochi_process_qa" {
		admin.Close()
		t.Fatal("search QA connection did not resolve the disposable database")
	}
	// Shared extension types stay in QA public, never in the schema we drop.
	if _, err = admin.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
		CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
		CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`); err != nil {
		admin.Close()
		t.Fatal("could not prepare search QA extension types")
	}
	var suffix [8]byte
	if _, err = rand.Read(suffix[:]); err != nil {
		admin.Close()
		t.Fatal("could not create search QA schema identity")
	}
	schema := "search_api_qa_" + hex.EncodeToString(suffix[:])
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal("could not create owned search QA schema")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close()
		if err != nil {
			t.Error("could not remove owned search QA schema")
		}
	})
	query := address.Query()
	query.Set("search_path", schema+",public")
	address.RawQuery = query.Encode()
	scopedDSN := address.String()
	scoped, err := pgxpool.ParseConfig(scopedDSN)
	if err != nil || scoped.ConnConfig.Database != "ochi_process_qa" || scoped.ConnConfig.RuntimeParams["search_path"] != schema+",public" {
		t.Fatal("search QA schema scope was not isolated")
	}
	store, err := storage.Open(ctx, scopedDSN)
	if err != nil {
		t.Fatal("could not initialize owned search QA schema")
	}
	t.Cleanup(store.Close)
	var tables int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname=$1 AND c.relname IN ('sessions','runs','search_settings')`, schema).Scan(&tables); err != nil || tables != 3 {
		t.Fatal("search QA tables did not belong to the owned schema")
	}
	return store
}

func TestSearchHTTPAndToolIntegration(t *testing.T) {
	store := searchIntegrationStore(t)
	s, err := NewServer(store, nil, []Account{
		{Username: "search-qa-admin", Password: "fixture-admin-password", Role: "admin"},
		{Username: "search-qa-user", Password: "fixture-user-password", Role: "user"},
	}, false)
	if err != nil {
		t.Fatal("could not create isolated search QA server")
	}
	s.SetTools(nil)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Error("could not shut down search QA server")
		}
	})
	api := httptest.NewServer(s.Handler())
	api.Client().Timeout = 5 * time.Second
	t.Cleanup(api.Close)
	request := func(t *testing.T, token, method, path string, body any, status int) []byte {
		t.Helper()
		var data []byte
		if body != nil {
			var err error
			data, err = json.Marshal(body)
			if err != nil {
				t.Fatal("could not encode search QA request")
			}
		}
		req, err := http.NewRequest(method, api.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal("could not create search QA request")
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := api.Client().Do(req)
		if err != nil {
			t.Fatal("search QA HTTP request failed")
		}
		defer res.Body.Close()
		data, err = io.ReadAll(res.Body)
		if err != nil {
			t.Fatal("could not read search QA HTTP response")
		}
		if res.StatusCode != status {
			t.Fatalf("%s %s returned %d, want %d", method, path, res.StatusCode, status)
		}
		return data
	}
	login := func(t *testing.T, username, password string) string {
		t.Helper()
		data := request(t, "", http.MethodPost, "/api/auth/login", map[string]any{"username": username, "password": password, "native": true}, http.StatusOK)
		var response struct {
			AccessToken string `json:"access_token"`
		}
		if json.Unmarshal(data, &response) != nil || response.AccessToken == "" {
			t.Fatal("search QA native login did not return a credential")
		}
		return response.AccessToken
	}
	adminToken := login(t, "search-qa-admin", "fixture-admin-password")
	userToken := login(t, "search-qa-user", "fixture-user-password")
	const unsavedKey = "unsaved-fixture-key"
	const savedKey = "saved-fixture-key"
	const replacementKey = "replacement-fixture-key"
	type providerCall struct {
		Query string `json:"query"`
		Limit int    `json:"numResults"`
		Key   string `json:"-"`
	}
	var providerMu sync.Mutex
	var calls []providerCall
	providerFailure := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var call providerCall
		if r.Method != http.MethodPost || r.URL.Path != "/search" || json.NewDecoder(r.Body).Decode(&call) != nil {
			t.Error("invalid controlled Exa request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		call.Key = r.Header.Get("x-api-key")
		providerMu.Lock()
		calls = append(calls, call)
		fail := providerFailure
		providerMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if fail {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "provider diagnostic " + replacementKey})
			return
		}
		_, _ = io.WriteString(w, `{"results":[{"title":"<b>Source one</b>","url":"https://example.org/one","highlights":["A source excerpt"]},{"title":"Source two","url":"https://example.net/two"}]}`)
	}))
	t.Cleanup(provider.Close)
	assertCall := func(t *testing.T, query, key string, limit, count int) {
		t.Helper()
		providerMu.Lock()
		defer providerMu.Unlock()
		if len(calls) != count {
			t.Fatalf("controlled provider received %d calls, want %d", len(calls), count)
		}
		last := calls[len(calls)-1]
		if last.Query != query || last.Key != key || last.Limit != limit {
			t.Fatal("provider query, credential or result limit did not match")
		}
	}
	settings := func(t *testing.T) websearch.Config {
		t.Helper()
		value, err := store.SearchSettings(context.Background())
		if err != nil {
			t.Fatal("could not read isolated search settings")
		}
		return value
	}
	reset := func(t *testing.T) {
		t.Helper()
		if err := store.SaveSearchSettings(context.Background(), websearch.Defaults()); err != nil {
			t.Fatal("could not reset isolated search configuration")
		}
		providerMu.Lock()
		calls = nil
		providerFailure = false
		providerMu.Unlock()
	}
	assertPublic := func(t *testing.T, data []byte, hasKey bool) {
		t.Helper()
		var value map[string]json.RawMessage
		var present bool
		if json.Unmarshal(data, &value) != nil || json.Unmarshal(value["has_api_key"], &present) != nil || present != hasKey {
			t.Fatal("public search configuration has incorrect credential presence")
		}
		if _, exists := value["api_key"]; exists {
			t.Fatal("public search configuration exposes a credential field")
		}
		for _, secret := range []string{unsavedKey, savedKey, replacementKey, adminToken, userToken} {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatal("search response exposed a private credential")
			}
		}
	}

	t.Run("admin user and anonymous authorization", func(t *testing.T) {
		reset(t)
		for _, actor := range []struct {
			name, token string
			status      int
		}{{"anonymous", "", http.StatusUnauthorized}, {"user", userToken, http.StatusForbidden}, {"admin", adminToken, http.StatusOK}} {
			t.Run(actor.name, func(t *testing.T) {
				request(t, actor.token, http.MethodGet, "/api/admin/search", nil, actor.status)
				request(t, actor.token, http.MethodPatch, "/api/admin/search", map[string]any{"max_results": 6}, actor.status)
				request(t, actor.token, http.MethodPost, "/api/admin/search/test", map[string]any{
					"base_url": provider.URL, "api_key_action": "replace", "api_key": unsavedKey, "query": "authorization fixture",
				}, actor.status)
			})
		}
		assertCall(t, "authorization fixture", unsavedKey, 3, 1)
		if settings(t) != websearch.Defaults() {
			t.Fatal("authorization or test requests changed persisted configuration")
		}
	})

	t.Run("unsaved test succeeds without persistence", func(t *testing.T) {
		reset(t)
		before := settings(t)
		data := request(t, adminToken, http.MethodPost, "/api/admin/search/test", map[string]any{
			"enabled": false, "base_url": provider.URL, "api_key_action": "replace", "api_key": unsavedKey, "query": "unsaved fixture", "max_results": 1,
		}, http.StatusOK)
		var result websearch.Response
		if json.Unmarshal(data, &result) != nil || result.Query != "unsaved fixture" || result.Count != 1 || len(result.Results) != 1 || result.Results[0].Title != "Source one" {
			t.Fatal("unsaved test did not return normalized actual provider results")
		}
		assertCall(t, "unsaved fixture", unsavedKey, 1, 1)
		if settings(t) != before || bytes.Contains(data, []byte(unsavedKey)) {
			t.Fatal("unsaved test persisted or exposed its credential")
		}
	})

	t.Run("saved key preservation replacement and redaction", func(t *testing.T) {
		reset(t)
		data := request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{
			"enabled": false, "base_url": provider.URL, "api_key_action": "replace", "api_key": savedKey,
		}, http.StatusOK)
		assertPublic(t, data, true)
		assertPublic(t, request(t, adminToken, http.MethodGet, "/api/admin/search", nil, http.StatusOK), true)
		request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{"max_results": 2, "api_key_action": "keep"}, http.StatusOK)
		if settings(t).APIKey != savedKey || settings(t).MaxResults != 2 {
			t.Fatal("ordinary settings update lost the saved credential")
		}
		assertPublic(t, request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{
			"api_key_action": "replace", "api_key": replacementKey,
		}, http.StatusOK), true)
		if settings(t).APIKey != replacementKey {
			t.Fatal("replacement credential was not persisted")
		}
		before := settings(t)
		data = request(t, adminToken, http.MethodPost, "/api/admin/search/test", map[string]any{"query": "saved fixture"}, http.StatusOK)
		assertCall(t, "saved fixture", replacementKey, 2, 1)
		if settings(t) != before || bytes.Contains(data, []byte(replacementKey)) {
			t.Fatal("saved configuration test changed settings or exposed the key")
		}
	})

	t.Run("search tool with Computer off and enabled disabled configuration", func(t *testing.T) {
		reset(t)
		request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{
			"base_url": provider.URL, "api_key_action": "replace", "api_key": replacementKey, "max_results": 2,
		}, http.StatusOK)
		data := request(t, userToken, http.MethodPost, "/api/sessions", map[string]any{"computer_enabled": false}, http.StatusCreated)
		var session storage.Session
		if json.Unmarshal(data, &session) != nil || session.ID == "" || session.ComputerEnabled {
			t.Fatal("tool fixture session must have Computer off")
		}
		ctx := agent.WithRunScope(context.Background(), agent.RunScope{UserID: "search-qa-user", SessionID: session.ID, ComputeOnly: true})
		assertDefinition := func(want bool) {
			t.Helper()
			definitions, err := s.tools.Definitions(ctx, "search-qa-user")
			if err != nil {
				t.Fatal("could not obtain actual wrapped tool definitions")
			}
			count := 0
			for _, definition := range definitions {
				if definition.Name == "web_search" {
					count++
				}
			}
			if (want && count != 1) || (!want && count != 0) {
				t.Fatal("search definition did not follow saved enabled state")
			}
		}
		assertDefinition(false)
		args := json.RawMessage(`{"query":"tool fixture","limit":1}`)
		if _, err := s.tools.Call(ctx, "search-qa-user", "web_search", args); err == nil {
			t.Fatal("disabled search tool contacted a provider")
		}
		request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{"enabled": true}, http.StatusOK)
		assertDefinition(true)
		result, err := s.tools.Call(ctx, "search-qa-user", "web_search", args)
		if err != nil {
			t.Fatal("enabled actual search tool failed with Computer off")
		}
		var output websearch.Response
		if json.Unmarshal([]byte(result.Output), &output) != nil || output.Query != "tool fixture" || output.Count != 1 || len(output.Results) != 1 || output.Results[0].URL != "https://example.org/one" || strings.Contains(result.Output, replacementKey) {
			t.Fatal("search tool did not return safe normalized provider results")
		}
		assertCall(t, "tool fixture", replacementKey, 1, 1)
		request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{"enabled": false}, http.StatusOK)
		assertDefinition(false)
		if _, err := s.tools.Call(ctx, "search-qa-user", "web_search", args); err == nil {
			t.Fatal("disabling search did not revoke subsequent calls")
		}
		assertCall(t, "tool fixture", replacementKey, 1, 1)
	})

	t.Run("upstream HTTP error stays sanitized and does not persist test state", func(t *testing.T) {
		reset(t)
		request(t, adminToken, http.MethodPatch, "/api/admin/search", map[string]any{
			"base_url": provider.URL, "api_key_action": "replace", "api_key": replacementKey, "max_results": 2,
		}, http.StatusOK)
		providerMu.Lock()
		providerFailure = true
		providerMu.Unlock()
		before := settings(t)
		data := request(t, adminToken, http.MethodPost, "/api/admin/search/test", map[string]any{"query": "failure fixture"}, http.StatusBadGateway)
		if bytes.Contains(data, []byte(replacementKey)) || bytes.Contains(data, []byte("provider diagnostic")) || bytes.Contains(data, []byte(provider.URL)) || settings(t) != before {
			t.Fatal("provider failure exposed diagnostics or persisted unsaved enablement")
		}
		assertCall(t, "failure fixture", replacementKey, 2, 1)
	})
}
