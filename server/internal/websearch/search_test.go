package websearch

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ochi/server/internal/product"
)

func TestProviderRequestsAndNormalizedResults(t *testing.T) {
	for _, provider := range []string{"exa", "brave", "searxng"} {
		t.Run(provider, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if got := r.Header.Values("User-Agent"); len(got) != 1 || got[0] != product.UserAgent() {
					t.Errorf("User-Agent = %q, want one %q", got, product.UserAgent())
				}
				query := r.URL.Query().Get("q")
				switch provider {
				case "exa":
					if r.Method != http.MethodPost || r.URL.Path != "/search" || r.Header.Get("x-api-key") != "secret" {
						t.Errorf("bad Exa request")
					}
					var body struct {
						Query    string `json:"query"`
						Limit    int    `json:"numResults"`
						Contents struct {
							Highlights bool `json:"highlights"`
						} `json:"contents"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Limit != 2 || !body.Contents.Highlights {
						t.Errorf("bad Exa search body: %v", err)
					}
					query = body.Query
					fmt.Fprint(w, `{"results":[{"title":"<b>Example</b> &amp; source","url":"https://example.com/doc","highlights":["One","Two"],"publishedDate":"2026-10-13"},{"title":"duplicate","url":"https://example.com/doc"},{"url":"javascript:alert(1)"},{"url":"https://docs.example.org"}]}`)
				case "brave":
					if r.Method != http.MethodGet || r.URL.Path != "/web/search" || r.Header.Get("X-Subscription-Token") != "secret" || r.URL.Query().Get("count") != "2" {
						t.Errorf("bad Brave request")
					}
					fmt.Fprint(w, `{"web":{"results":[{"title":"<b>Example</b> &amp; source","url":"https://example.com/doc","description":"One Two","age":"today"},{"url":"https://docs.example.org"}]}}`)
				case "searxng":
					if r.Method != http.MethodGet || r.URL.Path != "/search" || r.URL.Query().Get("format") != "json" || r.Header.Get("Authorization") != "Bearer secret" {
						t.Errorf("bad SearXNG request")
					}
					fmt.Fprint(w, `{"results":[{"title":"<b>Example</b> &amp; source","url":"https://example.com/doc","content":"One Two"},{"url":"https://docs.example.org"}]}`)
				}
				if query != "中文 & science" {
					t.Errorf("lost query encoding: %q", query)
				}
			}))
			defer s.Close()
			c := Defaults()
			c.Enabled, c.Provider, c.BaseURL, c.APIKey, c.MaxResults = true, provider, s.URL, "secret", 2
			result, err := Search(context.Background(), c, " 中文 & science ", 99)
			if err != nil || calls != 1 || result.Count != 2 || len(result.Results) != 2 {
				t.Fatalf("search/count: %+v, %v; %d calls", result, err, calls)
			}
			if result.Results[0].Title != "Example & source" || result.Results[0].Description != "One Two" || result.Results[1].Title != "docs.example.org" {
				t.Fatalf("normalization: %+v", result.Results)
			}
			body, _ := json.Marshal(result)
			if strings.Contains(string(body), "secret") || strings.Contains(string(body), s.URL) {
				t.Fatal("provider configuration leaked")
			}
		})
	}
}

func TestErrorsLimitsAndRedirects(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{"auth", 401, `{"error":"secret token"}`},
		{"rate", 429, "secret token"},
		{"malformed", 200, `<html>secret token</html>`},
		{"missing", 200, `{}`},
		{"oversized", 200, strings.Repeat("x", (2<<20)+1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(test.status); fmt.Fprint(w, test.body) }))
			defer s.Close()
			c := Defaults()
			c.Enabled, c.BaseURL, c.APIKey = true, s.URL, "secret"
			_, err := Search(context.Background(), c, "query", 1)
			if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), s.URL) {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
	redirects := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirects++ }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	c := Defaults()
	c.Enabled, c.BaseURL, c.APIKey = true, source.URL, "secret"
	if _, err := Search(context.Background(), c, "query", 0); err == nil || redirects != 0 {
		t.Fatal("followed search redirect")
	}
	for _, query := range []string{"", strings.Repeat("汉", 601), strings.Repeat("a ", 76)} {
		if _, err := Search(context.Background(), c, query, 1); err == nil {
			t.Fatal("accepted invalid query")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Search(ctx, c, "query", 1); err != context.Canceled {
		t.Fatalf("lost cancellation: %v", err)
	}
}

func TestConfigPublicURLsAndEmptyResults(t *testing.T) {
	c := Defaults()
	if err := Validate(c); err != nil {
		t.Fatal(err)
	}
	if _, err := Search(context.Background(), c, "q", 1); err == nil {
		t.Fatal("disabled search ran")
	}
	for _, address := range []string{"javascript:alert(1)", "https://u:p@example.com", "http://127.0.0.1/a", "https://localhost", "https://localhost.", "https://10.0.0.2/a", "file:///a", "/relative", "http://:80", "https://example.com:999999", "https://example.com:", "http://127.1", "http://2130706433", "http://0x7f000001"} {
		if publicURL(address) != "" {
			t.Fatalf("unsafe URL %q", address)
		}
	}
	for _, address := range []string{"https://docs.example.org/a?q=b#c", "http://example.org"} {
		if publicURL(address) != address {
			t.Fatalf("public URL lost: %q", address)
		}
	}
	for _, provider := range []string{"exa", "brave", "searxng"} {
		body := `{"results":[]}`
		if provider == "brave" {
			body = `{"web":{"results":[]}}`
		}
		items, err := decode(provider, []byte(body))
		if err != nil || len(items) != 0 {
			t.Fatalf("empty %s: %v", provider, err)
		}
	}
}
