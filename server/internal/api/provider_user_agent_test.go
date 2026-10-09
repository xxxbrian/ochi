package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"ochi/server/internal/product"
	"ochi/server/internal/storage"
)

func TestFetchProviderModelsUserAgent(t *testing.T) {
	for _, test := range []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{name: "default", want: product.UserAgent()},
		{name: "mixed-case override", headers: map[string]string{"uSeR-aGeNt": "ProviderProxy/2.3"}, want: "ProviderProxy/2.3"},
		{name: "explicit empty", headers: map[string]string{"uSeR-aGeNt": ""}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer test-key" {
					t.Errorf("unexpected model discovery request: %s %s", r.Method, r.URL.Path)
				}
				if got := r.Header.Get("User-Agent"); got != test.want {
					t.Errorf("wire User-Agent = %q, want %q", got, test.want)
				}
				values := r.Header.Values("User-Agent")
				if test.want == "" {
					if _, present := r.Header["User-Agent"]; present || len(values) != 0 {
						t.Errorf("explicit empty User-Agent reached wire: %q", values)
					}
				} else if len(values) != 1 {
					t.Errorf("wire User-Agent values = %q, want exactly one", values)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"data":[{"id":"fixture-model"}]}`)
			}))
			defer upstream.Close()

			models, status, err := fetchProviderModels(context.Background(), storage.Provider{
				BaseURL: upstream.URL + "/v1", APIKey: "test-key", Headers: test.headers,
			})
			if err != nil || status != http.StatusOK || len(models) != 1 || models[0] != "fixture-model" {
				t.Fatalf("model discovery: models=%v status=%d err=%v", models, status, err)
			}
			if got := requests.Load(); got != 1 {
				t.Fatalf("model discovery requests = %d, want 1", got)
			}
		})
	}
}
