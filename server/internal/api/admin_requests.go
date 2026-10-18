package api

import (
	"errors"
	"net/http"
	"strconv"
)

func parseAdminRequestPage(r *http.Request) (limit, offset int, err error) {
	limit = 30
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			return 0, 0, errors.New("limit must be between 1 and 100")
		}
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 {
			return 0, 0, errors.New("offset must be a non-negative integer")
		}
	}
	return limit, offset, nil
}

func (s *Server) adminRequests(w http.ResponseWriter, r *http.Request) {
	// These payloads can contain conversation text; never let an intermediary
	// cache admin debug responses, including successful clear operations.
	w.Header().Set("Cache-Control", "no-store")
	runID := r.PathValue("id")
	if r.Method == http.MethodDelete {
		if err := s.store.DeleteProviderTraces(r.Context(), runID); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if requestID := r.PathValue("request"); requestID != "" {
		trace, err := s.store.ProviderTrace(r.Context(), runID, requestID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, trace)
		return
	}
	limit, offset, err := parseAdminRequestPage(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	page, err := s.store.ListProviderTraces(r.Context(), runID, limit, offset)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
