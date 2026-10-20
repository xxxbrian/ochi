package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ochi/server/internal/selfupdate"
)

func TestUpdateRoutesRequireAuthentication(t *testing.T) {
	s := &Server{auth: &authentication{}}
	mux := http.NewServeMux()
	s.registerUpdateRoutes(mux)
	for _, path := range []string{"", "/check", "/apply", "/restart", "/rollback"} {
		method := http.MethodPost
		if path == "" {
			method = http.MethodGet
		}
		request := httptest.NewRequest(method, "/api/admin/updates"+path, nil)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s: %d", path, response.Code)
		}
	}
}

func TestAdminUpdateStateAndInvalidMutations(t *testing.T) {
	s := &Server{updater: selfupdate.New(selfupdate.Config{BuildType: "development"})}
	response := httptest.NewRecorder()
	s.adminUpdates(response, httptest.NewRequest(http.MethodGet, "/api/admin/updates", nil))
	var state selfupdate.State
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil || response.Code != http.StatusOK || state.Supported || state.UnsupportedReason == "" || state.Phase != "idle" {
		t.Fatalf("development state: %+v %v status %d", state, err, response.Code)
	}
	for _, test := range []struct {
		path string
		body string
		code int
	}{
		{"/apply", "{", http.StatusBadRequest},
		{"/apply", `{}`, http.StatusBadRequest},
		{"/apply", `{"revision":"a","url":"https://untrusted.invalid/binary"}`, http.StatusBadRequest},
		{"/apply", `{"revision":"a"}`, http.StatusConflict},
		{"/rollback", "", http.StatusConflict},
		{"/restart", "", http.StatusConflict},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/admin/updates"+test.path, strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		s.adminUpdates(response, request)
		if response.Code != test.code {
			t.Fatalf("%s %s: %d, want %d", test.path, test.body, response.Code, test.code)
		}
	}
}

func TestUpdateRoutesRequireAdministrator(t *testing.T) {
	f := newCoreHTTPFixture(t)
	f.server.SetUpdater(selfupdate.New(selfupdate.Config{BuildType: "development"}))
	f.request(t, f.token, http.MethodGet, "/api/admin/updates", "", http.StatusForbidden)
	f.request(t, f.token, http.MethodPost, "/api/admin/updates/check", "", http.StatusForbidden)
	f.request(t, f.foreign, http.MethodGet, "/api/admin/updates", "", http.StatusOK)
}
