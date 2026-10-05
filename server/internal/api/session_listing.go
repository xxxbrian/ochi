package api

import (
	"errors"
	"net/http"
	"strconv"
	"unicode/utf8"

	"ochi/server/internal/storage"
)

func (s *Server) sessionsPage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if utf8.RuneCountInString(q.Get("q")) > 200 || len(q.Get("cursor")) > 256 {
		writeError(w, http.StatusBadRequest, errors.New("搜索内容过长"))
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	page, err := s.store.SessionsPage(r.Context(), currentUser(r).ID, q.Get("q"), q.Get("cursor"), q.Get("project_id"), limit)
	if errors.Is(err, storage.ErrSessionCursor) {
		writeError(w, http.StatusBadRequest, errors.New("无效的分页参数"))
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
