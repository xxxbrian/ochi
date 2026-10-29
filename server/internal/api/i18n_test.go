package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"ochi/server/internal/i18n"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func TestErrorLanguageBeforeAuthentication(t *testing.T) {
	handler := (&Server{auth: &authentication{}}).Handler()
	for _, test := range []struct {
		method, path, body, language, locale, code string
		status                                     int
	}{
		{"GET", "/api/auth/me", "", "en-US", "en", "unauthenticated", 401},
		{"GET", "/api/auth/me", "", "zh-Hans-SG", "zh-CN", "unauthenticated", 401},
		{"GET", "/api/auth/me", "", "zh-HK", "zh-TW", "unauthenticated", 401},
		{"POST", "/api/auth/login", "{", "zh-TW", "zh-TW", "invalid_json", 400},
		{"POST", "/api/auth/login", "{", "fr-FR", "en", "invalid_json", 400},
		{"GET", "/api/no-such-route", "", "zh-TW", "zh-TW", "not_found", 404},
		{"PUT", "/api/auth/login", "", "zh-CN", "zh-CN", "method_not_allowed", 405},
	} {
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		request.Header.Set("Accept-Language", test.language)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var body struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != test.status || body.Code != test.code || body.Error != i18n.Text(test.locale, test.code, nil) {
			t.Fatalf("%s %s language %s: status=%d, body=%+v", test.method, test.path, test.language, response.Code, body)
		}
		if response.Header().Get("Content-Language") != test.locale || !strings.Contains(response.Header().Get("Vary"), "Accept-Language") {
			t.Fatal("response omitted its negotiated language/cache variation")
		}
		if test.status == http.StatusMethodNotAllowed && response.Header().Get("Allow") != "POST" {
			t.Fatal("localized method error omitted the route's allowed methods")
		}
	}
}

func TestConnectionTestLocalizesSummaryAndPreservesTechnicalDetail(t *testing.T) {
	result := map[string]any{}
	failure := i18n.WrapWith("image_provider_http_error", map[string]any{"status": 522}, errors.New("HTTP 522 technical edge failure"))
	setConnectionTestError(result, failure)
	result["detail"] = storage.SanitizeProviderError(storage.Provider{}, failure)
	if result["error_code"] != "image_provider_http_error" || result["error"] != i18n.Text("en", "image_provider_http_error", map[string]any{"status": 522}) {
		t.Fatal("a saved connection test did not retain a canonical error identity")
	}
	detail := result["detail"]
	localizeConnectionTest(result, "zh-TW")
	if result["error"] != i18n.Text("zh-TW", "image_provider_http_error", map[string]any{"status": 522}) ||
		result["detail"] != detail || !strings.Contains(detail.(string), "HTTP 522 technical edge failure") {
		t.Fatal("localizing administrator test summary discarded its technical cause")
	}
}

func TestConcurrentRequestLanguageDoesNotLeak(t *testing.T) {
	handler := (&Server{auth: &authentication{}}).Handler()
	var pending sync.WaitGroup
	for index := 0; index < 60; index++ {
		pending.Add(1)
		go func(locale string) {
			defer pending.Done()
			request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
			request.Header.Set("Accept-Language", locale)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error != i18n.Text(locale, "unauthenticated", nil) || response.Header().Get("Content-Language") != locale {
				t.Errorf("concurrent request leaked a different locale: %s", locale)
			}
		}([]string{"en", "zh-CN", "zh-TW"}[index%3])
	}
	pending.Wait()
}

func TestPublicErrorsKeepIdentityAndHideUnknownDetail(t *testing.T) {
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{i18n.New("invalid_language"), 400, "invalid_language"},
		{errors.New("postgres private address and secret fixture-value"), 500, "conversation_storage_failed"},
	} {
		response := httptest.NewRecorder()
		response.Header().Set("Content-Language", "zh-TW")
		writeStoreError(response, test.err)
		var body map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		if response.Code != test.status || body["code"] != test.code || body["error"] != i18n.Text("zh-TW", test.code, nil) {
			t.Fatalf("incorrect public error: status=%d body=%+v", response.Code, body)
		}
		if strings.Contains(response.Body.String(), "fixture-value") {
			t.Fatal("unknown internal detail escaped through the API")
		}
	}
	response := httptest.NewRecorder()
	response.Header().Set("Content-Language", "zh-CN")
	writeError(response, 502, i18n.With("search_http_error", map[string]any{"status": 503}))
	var body struct {
		Code   string         `json:"code"`
		Error  string         `json:"error"`
		Params map[string]any `json:"params"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body.Code != "search_http_error" || body.Params["status"] != float64(503) || !strings.Contains(body.Error, "503") {
		t.Fatal("structured interpolation parameters were discarded")
	}
}

func TestPreferenceLanguageThroughAuthenticatedAPI(t *testing.T) {
	fixture := newCoreHTTPFixture(t)
	request := func(token, method, body, locale string, status int) map[string]any {
		t.Helper()
		req := httptest.NewRequest(method, "/api/preferences", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept-Language", locale)
		response := httptest.NewRecorder()
		fixture.server.Handler().ServeHTTP(response, req)
		var value map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &value)
		if response.Code != status {
			t.Fatalf("preferences status=%d body=%+v", response.Code, value)
		}
		return value
	}
	initial := request(fixture.token, "GET", "", "en", 200)
	if initial["language"] != "system" {
		t.Fatal("new account language is not system")
	}
	saved := request(fixture.token, "PATCH", `{"language":"zh-TW"}`, "en", 200)
	if saved["language"] != "zh-TW" {
		t.Fatal("explicit language was not saved")
	}
	saved = request(fixture.token, "PATCH", `{"computer_default":true}`, "zh-CN", 200)
	if saved["language"] != "zh-TW" || saved["computer_default"] != true {
		t.Fatal("a partial preference write reset the language")
	}
	invalid := request(fixture.token, "PATCH", `{"language":"fr"}`, "zh-CN", 400)
	if invalid["code"] != "invalid_language" || invalid["error"] != i18n.Text("zh-CN", "invalid_language", nil) {
		t.Fatal("invalid language did not return a localized structured error")
	}
	if other := request(fixture.foreign, "GET", "", "zh-TW", 200); other["language"] != "system" {
		t.Fatal("account language leaked to a different login")
	}
	if saved := request(fixture.token, "GET", "", "en", 200); saved["language"] != "zh-TW" {
		t.Fatal("an invalid or independent request changed the saved preference")
	}
}

func TestScheduleExecutionLiveFailureKeepsErrorIdentity(t *testing.T) {
	fixture := newCoreHTTPFixture(t)
	ctx := context.Background()
	schedule, err := fixture.server.store.SaveSchedule(ctx, fixture.owner, storage.Schedule{
		SessionID: fixture.session.ID, Name: "Fixture", Prompt: "Fixture",
		Recurrence: "interval", IntervalMinutes: 60, Timezone: "UTC", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	executionID, admitted, err := fixture.server.store.BeginScheduleExecution(ctx, fixture.owner, schedule.ID)
	if err != nil || !admitted {
		t.Fatal("could not prepare a schedule execution", err)
	}
	if err := fixture.server.store.LinkScheduleExecution(ctx, executionID, fixture.run.RunID, fixture.session.ID, nil); err != nil {
		t.Fatal(err)
	}
	live, ok := fixture.server.runtime.Get(fixture.run.RunID)
	if !ok {
		t.Fatal("fixture run was not restored")
	}
	// A request can read storage before completion and then observe the newer
	// in-memory result; the entire failure identity must follow that overlay.
	live.Finish(runtime.StatusFailed, i18n.New("model_rate_limit"))
	stored, err := fixture.server.store.GetRun(ctx, fixture.owner, fixture.run.RunID)
	if err != nil || stored.ErrorCode != "" {
		t.Fatal("fixture must keep an earlier persisted snapshot", err)
	}
	base := "/api/schedules/" + schedule.ID + "/executions"
	var list []storage.ScheduleExecution
	if err := json.Unmarshal(fixture.request(t, fixture.token, http.MethodGet, base, "", http.StatusOK), &list); err != nil || len(list) != 1 {
		t.Fatal("could not read the execution list", err)
	}
	var detail storage.ScheduleExecution
	if err := json.Unmarshal(fixture.request(t, fixture.token, http.MethodGet, base+"/"+executionID, "", http.StatusOK), &detail); err != nil {
		t.Fatal(err)
	}
	for _, execution := range []storage.ScheduleExecution{list[0], detail} {
		if execution.Status != runtime.StatusFailed || execution.ErrorCode != "model_rate_limit" || execution.Error != i18n.Text("en", "model_rate_limit", nil) {
			t.Fatalf("live execution failure was inconsistent: %+v", execution)
		}
	}
	if detail.Snapshot == nil || detail.ErrorCode != detail.Snapshot.ErrorCode {
		t.Fatal("outer execution and its live snapshot disagree on failure identity")
	}
}
