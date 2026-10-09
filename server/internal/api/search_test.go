package api

import (
	"encoding/json"
	"strings"
	"testing"

	"ochi/server/internal/websearch"
)

func TestSearchSecretPreservationAndProviderChange(t *testing.T) {
	c := websearch.Defaults()
	c.APIKey = "saved-secret"
	keep, err := applySearchPatch(c, searchPatch{})
	if err != nil || keep.APIKey != c.APIKey {
		t.Fatalf("lost stored credential: %v", err)
	}
	provider := "brave"
	changed, err := applySearchPatch(c, searchPatch{Provider: &provider})
	if err != nil || changed.APIKey != "" || changed.BaseURL != websearch.DefaultBaseURL(provider) {
		t.Fatalf("credential crossed providers: %+v %v", changed, err)
	}
	changed, err = applySearchPatch(c, searchPatch{Provider: &provider, APIKey: "new-secret", APIKeyAction: "replace"})
	if err != nil || changed.APIKey != "new-secret" {
		t.Fatalf("new credential not accepted: %v", err)
	}
	removed, err := applySearchPatch(c, searchPatch{APIKeyAction: "delete"})
	if err != nil || removed.APIKey != "" {
		t.Fatal("delete credential failed")
	}
	if _, err := applySearchPatch(c, searchPatch{APIKeyAction: "replace"}); err == nil {
		t.Fatal("accepted blank replacement")
	}
	public, _ := json.Marshal(publicSearchSettings(c))
	if strings.Contains(string(public), "saved-secret") || strings.Contains(string(public), `"api_key":`) || !strings.Contains(string(public), `"has_api_key":true`) {
		t.Fatalf("public credential contract: %s", public)
	}
}

func TestSearchConfigValidation(t *testing.T) {
	c := websearch.Defaults()
	enabled := true
	if _, err := applySearchPatch(c, searchPatch{Enabled: &enabled}); err == nil {
		t.Fatal("enabled search without a key")
	}
	for _, address := range []string{"file:///etc", "https://user:password@example.com", "https://example.com?token=x", "https://example.com/#secret"} {
		if _, err := applySearchPatch(c, searchPatch{BaseURL: &address}); err == nil {
			t.Fatalf("accepted unsafe endpoint %s", address)
		}
	}
	provider := "searxng"
	endpoint := "http://localhost:8888"
	if _, err := applySearchPatch(c, searchPatch{Provider: &provider, BaseURL: &endpoint, Enabled: &enabled}); err != nil {
		t.Fatalf("local SearXNG must work without key: %v", err)
	}
}
