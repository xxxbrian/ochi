package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestEmbeddedWebRouting(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":       {Data: []byte("<title>Ochi</title>")},
		"assets/app-1.js":  {Data: []byte("console.log('Ochi')")},
		"favicon-32.png":   {Data: []byte("image bytes")},
		"fonts/face.woff2": {Data: []byte("font bytes")},
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-API", "true")
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.Error(w, "API response", http.StatusUnauthorized)
	})
	handler := withAssets(api, assets)
	for _, test := range []struct {
		path   string
		status int
		body   string
		cache  string
	}{
		{"/", 200, "<title>Ochi</title>", "no-cache"},
		{"/index.html", 200, "<title>Ochi</title>", "no-cache"},
		{"/c/fixture", 200, "<title>Ochi</title>", "no-cache"},
		{"/admin/settings", 200, "<title>Ochi</title>", "no-cache"},
		{"/native/computer", 200, "<title>Ochi</title>", "no-cache"},
		{"/assets/app-1.js", 200, "console.log('Ochi')", "public, max-age=31536000, immutable"},
		{"/favicon-32.png", 200, "image bytes", "no-cache"},
		{"/fonts/face.woff2", 200, "font bytes", "no-cache"},
		{"/assets/missing.js", 404, "404 page not found", ""},
		{"/assets/missing", 404, "404 page not found", ""},
		{"/missing.png", 404, "404 page not found", ""},
		{"/api", 401, "API response", ""},
		{"/api/missing", 401, "API response", ""},
		{"/healthz", 200, `{"status":"ok"}`, ""},
	} {
		t.Run(test.path, func(t *testing.T) {
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, test.path, nil))
			if res.Code != test.status || !strings.Contains(res.Body.String(), test.body) {
				t.Fatalf("status %d, body %q", res.Code, res.Body.String())
			}
			if got := res.Header().Get("Cache-Control"); got != test.cache {
				t.Errorf("cache = %q, want %q", got, test.cache)
			}
		})
	}
	for _, test := range []struct{ method, path string }{{"POST", "/admin/settings"}, {"POST", "/api/auth/login"}, {"DELETE", "/assets/app-1.js"}} {
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, httptest.NewRequest(test.method, test.path, nil))
		if res.Code != http.StatusUnauthorized || res.Header().Get("X-API") != "true" {
			t.Errorf("%s %s did not reach API: %d", test.method, test.path, res.Code)
		}
	}
	for _, requestPath := range []string{"/", "/assets/app-1.js"} {
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, httptest.NewRequest(http.MethodHead, requestPath, nil))
		if res.Code != http.StatusOK || res.Body.Len() != 0 {
			t.Errorf("HEAD %s returned %d, %d bytes", requestPath, res.Code, res.Body.Len())
		}
	}
}

func TestMissingEmbeddedIndexFailsAtStartup(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("missing index.html did not fail startup")
		}
	}()
	withAssets(http.NotFoundHandler(), fstest.MapFS{})
}
