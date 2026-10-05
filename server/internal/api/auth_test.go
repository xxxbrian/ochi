package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestToken(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	if token := requestToken(r); token != "" {
		t.Fatalf("unexpected credential: %q", token)
	}
	r.AddCookie(&http.Cookie{Name: authCookie, Value: "cookie"})
	if token := requestToken(r); token != "cookie" {
		t.Fatalf("browser credential missing: %q", token)
	}
	r.Header.Set("Authorization", "Bearer native")
	if token := requestToken(r); token != "native" {
		t.Fatalf("bearer should take precedence: %q", token)
	}
	r.Header.Set("Authorization", "Basic invalid")
	if token := requestToken(r); token != "" {
		t.Fatal("invalid explicit credentials must not fall back to a cookie")
	}
}

func TestParseAccounts(t *testing.T) {
	accounts, err := ParseAccounts(`[{"username":" owner ","password":"secret"}]`)
	if err != nil || len(accounts) != 1 || accounts[0].Username != "owner" || accounts[0].DisplayName != "owner" || accounts[0].Role != "user" {
		t.Fatalf("invalid account defaults: %+v %v", accounts, err)
	}
	for _, raw := range []string{
		`[]`,
		`[{"password":"secret"}]`,
		`[{"username":"owner","password":"secret","role":"other"}]`,
		`[{"username":"__admin__","password":"secret"}]`,
		`[{"username":"owner","password":"secret"},{"username":"owner","password":"secret"}]`,
	} {
		if _, err := ParseAccounts(raw); err == nil {
			t.Fatalf("accepted invalid account configuration: %s", raw)
		}
	}
}

func TestWebviewRedirectStaysLocal(t *testing.T) {
	for _, path := range []string{"https://example.com", "//example.com", "/api/../external", "/api/\\example", "/api/%2e%2e/external", "/api/%5cexample"} {
		if validWebviewPath(path) {
			t.Fatalf("accepted external redirect %q", path)
		}
	}
	for _, path := range []string{"/api/files/id/content?download=1", "/native/computer", "/admin/providers"} {
		if !validWebviewPath(path) {
			t.Fatalf("authenticated native preview rejected: %s", path)
		}
	}
}
