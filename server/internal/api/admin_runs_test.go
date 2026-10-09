package api

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestAdminRunFiltersAreBounded(t *testing.T) {
	f, err := parseAdminRunFilter(httptest.NewRequest("GET", "/api/admin/runs?q=report&status=failed&limit=10&offset=30", nil))
	if err != nil || f.Limit != 10 || f.Offset != 30 || f.Query != "report" || f.Status != "failed" || f.To.Sub(f.From) > 31*24*time.Hour {
		t.Fatalf("unexpected run filter: %+v, %v", f, err)
	}
	for _, query := range []string{"limit=101", "offset=-1", "status=made-up", "from=2020-01-01T00:00:00Z", "from=bad"} {
		if _, err := parseAdminRunFilter(httptest.NewRequest("GET", "/api/admin/runs?"+query, nil)); err == nil {
			t.Fatalf("accepted invalid filter %q", query)
		}
	}
}
