package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"ochi/server/internal/storage"
)

func TestSessionHeadRouteUsesLiveMetadataAndEnforcesOwner(t *testing.T) {
	f := newCoreHTTPFixture(t)
	run, ok := f.server.runtime.Get(f.run.RunID)
	if !ok {
		t.Fatal("missing fixture run")
	}
	if err := run.AppendText("round", "source", strings.Repeat("private process fixture ", 100_000), "pending"); err != nil {
		t.Fatal(err)
	}
	path := "/api/sessions/" + f.session.ID + "/head"
	body := f.request(t, f.token, http.MethodGet, path, "", http.StatusOK)
	var head storage.SessionHead
	if err := json.Unmarshal(body, &head); err != nil {
		t.Fatal(err)
	}
	if head.Session.ID != f.session.ID || head.LatestRun == nil || head.LatestRun.Seq != run.Head().Seq {
		t.Fatalf("head did not observe live revision: %+v", head)
	}
	if len(body) > 2000 || strings.Contains(string(body), "private process fixture") || strings.Contains(string(body), `"items"`) {
		t.Fatalf("live process escaped lightweight head: %d bytes", len(body))
	}
	f.request(t, "", http.MethodGet, path, "", http.StatusUnauthorized)
	f.request(t, f.foreign, http.MethodGet, path, "", http.StatusNotFound)
}
