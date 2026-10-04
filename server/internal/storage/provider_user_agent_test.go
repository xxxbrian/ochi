package storage

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/product"
)

type catalogUserAgentTransport func(*http.Request) (*http.Response, error)

func (roundTrip catalogUserAgentTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return roundTrip(r)
}

func TestFetchModelCatalogUserAgentAndCache(t *testing.T) {
	catalogCache.Lock()
	previousAt, previousProviders := catalogCache.At, catalogCache.Providers
	catalogCache.At, catalogCache.Providers = time.Time{}, nil
	catalogCache.Unlock()
	t.Cleanup(func() {
		catalogCache.Lock()
		catalogCache.At, catalogCache.Providers = previousAt, previousProviders
		catalogCache.Unlock()
	})

	var requests, forwarded atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		if r.Method != http.MethodGet || r.Host != "models.dev" || r.URL.Path != "/api.json" || r.URL.RawQuery != "" {
			t.Errorf("unexpected catalog request: %s host=%q url=%s", r.Method, r.Host, r.URL)
		}
		if got := r.Header.Get("User-Agent"); got != product.UserAgent() {
			t.Errorf("wire catalog User-Agent = %q, want %q", got, product.UserAgent())
		}
		if values := r.Header.Values("User-Agent"); len(values) != 1 || values[0] == "" {
			t.Errorf("wire catalog User-Agent values = %q, want exactly one nonempty value", values)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"fixture":{"id":"fixture","name":"Fixture","models":{"fixture-model":{"name":"Fixture Model","tool_call":true}}}}`)
	}))
	t.Cleanup(upstream.Close)
	local, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	previousTransport := http.DefaultTransport
	localTransport := &http.Transport{}
	http.DefaultTransport = catalogUserAgentTransport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.String() != "https://models.dev/api.json" {
			t.Errorf("unexpected catalog destination: %s %s", r.Method, r.URL)
			return nil, fmt.Errorf("test blocked non-catalog request")
		}
		// Preserve the production target assertion while allowing only loopback I/O.
		request := r.Clone(r.Context())
		request.URL.Scheme, request.URL.Host = local.Scheme, local.Host
		request.Host = r.URL.Host
		return localTransport.RoundTrip(request)
	})
	t.Cleanup(func() {
		http.DefaultTransport = previousTransport
		localTransport.CloseIdleConnections()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		providers, err := FetchModelCatalog(ctx)
		if err != nil {
			t.Fatal(err)
		}
		provider := providers["fixture"]
		model := provider.Models["fixture-model"]
		if len(providers) != 1 || provider.ID != "fixture" || provider.ModelCount != 1 || model.ID != "fixture-model" || model.ProviderID != "fixture" {
			t.Fatalf("unexpected catalog: %+v", providers)
		}
	}
	if requested, served := requests.Load(), forwarded.Load(); requested != 1 || served != 1 {
		t.Fatalf("catalog requests=%d loopback requests=%d, want one fetch followed by a cache hit", requested, served)
	}
}
