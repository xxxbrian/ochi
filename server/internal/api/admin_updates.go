package api

import (
	"errors"
	"net/http"

	"ochi/server/internal/i18n"
	"ochi/server/internal/selfupdate"
)

func (s *Server) registerUpdateRoutes(mux *http.ServeMux) {
	for _, path := range []string{
		"GET /api/admin/updates", "POST /api/admin/updates/check",
		"POST /api/admin/updates/apply", "POST /api/admin/updates/restart", "POST /api/admin/updates/rollback",
	} {
		mux.HandleFunc(path, s.auth.admin(s.adminUpdates))
	}
}

func (s *Server) adminUpdates(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.updater == nil {
		writeError(w, http.StatusServiceUnavailable, i18n.New("update_uninitialized"))
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.updater.State().Localized(w.Header().Get("Content-Language")))
		return
	}
	var state selfupdate.State
	var err error
	status := http.StatusAccepted
	switch r.URL.Path {
	case "/api/admin/updates/check":
		state, err = s.updater.Check(r.Context())
		status = http.StatusOK
	case "/api/admin/updates/apply":
		var request struct {
			Revision string `json:"revision"`
		}
		if !decodeRequest(w, r, &request) {
			return
		}
		if request.Revision == "" {
			writeError(w, http.StatusBadRequest, i18n.New("update_choose_build"))
			return
		}
		state, err = s.updater.Apply(request.Revision)
	case "/api/admin/updates/rollback":
		state, err = s.updater.Rollback()
	case "/api/admin/updates/restart":
		state, err = s.updater.PrepareRestart()
	}
	if err != nil {
		code := http.StatusConflict
		if r.URL.Path == "/api/admin/updates/check" && !errors.Is(err, selfupdate.ErrConflict) {
			code = http.StatusBadGateway
		}
		writeError(w, code, err)
		return
	}
	writeJSON(w, status, state.Localized(w.Header().Get("Content-Language")))
	if r.URL.Path == "/api/admin/updates/restart" {
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		s.updater.TriggerRestart()
	}
}
