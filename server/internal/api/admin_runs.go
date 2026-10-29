package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
)

// Keep aggregation time bounded without introducing an analytics service.
func parseAdminRunFilter(r *http.Request) (storage.AdminRunFilter, error) {
	now := time.Now().UTC()
	f := storage.AdminRunFilter{Limit: 30, From: now.AddDate(0, 0, -30), To: now,
		Query: strings.TrimSpace(r.URL.Query().Get("q")), Status: r.URL.Query().Get("status"),
		ModelID: r.URL.Query().Get("model_id"), UserID: r.URL.Query().Get("user_id")}
	q := r.URL.Query()
	if len([]rune(f.Query)) > 200 {
		return f, i18n.New("search_too_long")
	}
	if f.Status != "" {
		switch f.Status {
		case "queued", "running", "waiting_user", "waiting_resource", "cancelling", "completed", "failed", "cancelled", "interrupted":
		default:
			return f, i18n.New("invalid_run_status")
		}
	}
	var err error
	if q.Get("from") != "" {
		if f.From, err = time.Parse(time.RFC3339, q.Get("from")); err != nil {
			return f, i18n.New("invalid_start_time")
		}
	}
	if q.Get("to") != "" {
		if f.To, err = time.Parse(time.RFC3339, q.Get("to")); err != nil {
			return f, i18n.New("invalid_end_time")
		}
	}
	if f.To.After(now) {
		f.To = now
	}
	if f.From.After(f.To) || f.To.Sub(f.From) > 91*24*time.Hour {
		return f, i18n.New("date_range_too_large")
	}
	if q.Get("limit") != "" {
		if f.Limit, err = strconv.Atoi(q.Get("limit")); err != nil || f.Limit < 1 || f.Limit > 100 {
			return f, i18n.New("invalid_page_limit")
		}
	}
	if q.Get("offset") != "" {
		if f.Offset, err = strconv.Atoi(q.Get("offset")); err != nil || f.Offset < 0 {
			return f, i18n.New("invalid_page_offset")
		}
	}
	return f, nil
}

func (s *Server) adminRunList(w http.ResponseWriter, r *http.Request) {
	f, err := parseAdminRunFilter(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	items, err := s.store.AdminRuns(r.Context(), f)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) adminRunStats(w http.ResponseWriter, r *http.Request) {
	f, err := parseAdminRunFilter(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	stats, err := s.store.AdminRunStats(r.Context(), f)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) adminRunDetail(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.AdminRun(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
