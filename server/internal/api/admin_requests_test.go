package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func TestAdminRequestPageValidation(t *testing.T) {
	for _, tc := range []struct {
		query         string
		limit, offset int
		valid         bool
	}{
		{"", 30, 0, true}, {"?limit=1&offset=20", 1, 20, true}, {"?limit=100&offset=0", 100, 0, true},
		{"?limit=0", 0, 0, false}, {"?limit=101", 0, 0, false}, {"?limit=no", 0, 0, false},
		{"?offset=-1", 0, 0, false}, {"?offset=1.5", 0, 0, false}, {"?offset=99999999999999999999999999", 0, 0, false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			limit, offset, err := parseAdminRequestPage(httptest.NewRequest(http.MethodGet, "/api/admin/requests"+tc.query, nil))
			if (err == nil) != tc.valid || (tc.valid && (limit != tc.limit || offset != tc.offset)) {
				t.Fatalf("got limit=%d offset=%d error=%v", limit, offset, err)
			}
		})
	}
}

func TestAdminRequestRoutesEnforceAdminScopeAndClearOnlyDebug(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	trace := agent.ProviderTrace{
		ID: "33333333333343338333333333333331", StartedAt: time.Now().UTC(), FinishedAt: time.Now().UTC(),
		Purpose: "chat", Attempt: 1, Model: "fixture", RequestBody: "private request payload", ResponseBody: "private response payload",
		RequestHeaders: http.Header{"Authorization": {"[REDACTED]"}}, ResponseHeaders: http.Header{"X-Request-ID": {"upstream"}},
		StreamChunks: []agent.ProviderStreamChunk{{Sequence: 1, Data: "private stream payload"}},
		FinishReason: "length", ErrorClass: "output_limit", SawEOF: true, Truncated: true,
	}
	if err := f.server.store.SaveProviderTrace(ctx, f.run.RunID, trace); err != nil {
		t.Fatal(err)
	}
	probe := trace
	probe.ID = "33333333333343338333333333333332"
	if err := f.server.store.SaveProviderTrace(ctx, "", probe); err != nil {
		t.Fatal(err)
	}
	base := "/api/admin/runs/" + f.run.RunID + "/requests"
	for _, path := range []string{base, base + "/" + trace.ID, "/api/admin/requests", "/api/admin/requests/" + probe.ID} {
		f.request(t, "", http.MethodGet, path, "", http.StatusUnauthorized)
		f.request(t, f.token, http.MethodGet, path, "", http.StatusForbidden)
	}
	for _, path := range []string{base, "/api/admin/requests"} {
		f.request(t, "", http.MethodDelete, path, "", http.StatusUnauthorized)
		f.request(t, f.token, http.MethodDelete, path, "", http.StatusForbidden)
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?offset=-1", "?offset=bad"} {
		f.request(t, f.foreign, http.MethodGet, "/api/admin/requests"+query, "", http.StatusBadRequest)
	}
	var page storage.ProviderTracePage
	list := f.request(t, f.foreign, http.MethodGet, base, "", http.StatusOK)
	if err := json.Unmarshal(list, &page); err != nil || page.Total != 1 || len(page.Items) != 1 || page.Limit != 30 || page.RetentionDays != 7 || page.MaxRequestsPerRun != 256 {
		t.Fatalf("scoped debug list contract invalid: %s %v", list, err)
	}
	for _, field := range []string{"request_headers", "request_body", "response_headers", "response_body", "stream_chunks", "private"} {
		if strings.Contains(string(list), field) {
			t.Fatalf("debug list exposed %s", field)
		}
	}
	if page.Items[0].FinishReason != "length" || page.Items[0].ErrorClass != "output_limit" || !page.Items[0].SawEOF || !page.Items[0].Truncated {
		t.Fatal("debug list lost terminal markers")
	}
	var full agent.ProviderTrace
	if err := json.Unmarshal(f.request(t, f.foreign, http.MethodGet, base+"/"+trace.ID, "", http.StatusOK), &full); err != nil || full.RequestBody != trace.RequestBody || len(full.StreamChunks) != 1 {
		t.Fatal("admin selected detail did not expose captured payload", err)
	}
	f.request(t, f.foreign, http.MethodGet, base+"/"+probe.ID, "", http.StatusNotFound)
	f.request(t, f.foreign, http.MethodGet, "/api/admin/requests/"+probe.ID, "", http.StatusOK)
	f.request(t, f.foreign, http.MethodGet, "/api/admin/requests/not-a-uuid", "", http.StatusBadRequest)
	f.request(t, f.foreign, http.MethodGet, "/api/admin/runs/not-a-uuid/requests", "", http.StatusBadRequest)
	f.request(t, f.foreign, http.MethodGet, "/api/admin/runs/33333333-3333-4333-8333-333333333333/requests", "", http.StatusNotFound)
	global := f.request(t, f.foreign, http.MethodGet, "/api/admin/requests?limit=1&offset=99", "", http.StatusOK)
	if err := json.Unmarshal(global, &page); err != nil || page.Total != 2 || len(page.Items) != 0 || page.Items == nil || page.Offset != 99 {
		t.Fatal("empty global page lost its total or array contract", err)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/admin/requests", nil)
	r.Header.Set("Authorization", "Bearer "+f.foreign)
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("debug payload was cacheable")
	}
	if err := f.server.store.SaveDiagnostic(ctx, f.run.RunID, agent.Diagnostic{Kind: "preserve", Message: "ordinary diagnostic"}); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.foreign, http.MethodDelete, base, "", http.StatusNoContent)
	if err := json.Unmarshal(f.request(t, f.foreign, http.MethodGet, "/api/admin/requests", "", http.StatusOK), &page); err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != probe.ID {
		t.Fatal("scoped clear deleted an unscoped probe", err)
	}
	f.request(t, f.foreign, http.MethodDelete, "/api/admin/requests", "", http.StatusNoContent)
	if err := json.Unmarshal(f.request(t, f.foreign, http.MethodGet, "/api/admin/requests", "", http.StatusOK), &page); err != nil || page.Total != 0 {
		t.Fatal("global clear retained debug requests", err)
	}
	f.request(t, f.token, http.MethodGet, "/api/runs/"+f.run.RunID, "", http.StatusOK)
	diagnostics := f.request(t, f.token, http.MethodGet, "/api/runs/"+f.run.RunID+"/diagnostics", "", http.StatusOK)
	if !strings.Contains(string(diagnostics), "ordinary diagnostic") {
		t.Fatal("debug clear touched ordinary diagnostics")
	}
}
