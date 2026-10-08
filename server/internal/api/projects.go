package api

import (
	"errors"
	"net/http"
	"ochi/server/internal/agent"
	"strings"

	"ochi/server/internal/storage"
)

func (s *Server) registerProjectRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Projects(r.Context(), currentUser(r).ID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}))
	mux.HandleFunc("GET /api/projects/{id}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Project(r.Context(), currentUser(r).ID, r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		page, err := s.store.SessionsPage(r.Context(), currentUser(r).ID, "", "", v.ID, 50)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			storage.Project
			Sessions   []storage.SessionListItem `json:"sessions"`
			NextCursor string                    `json:"next_cursor,omitempty"`
		}{v, page.Items, page.NextCursor})
	}))
	save := s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Name         *string `json:"name"`
			Instructions *string `json:"instructions"`
		}
		if !decodeRequest(w, r, &input) {
			return
		}
		v := storage.Project{ID: r.PathValue("id")}
		var err error
		if v.ID != "" {
			v, err = s.store.Project(r.Context(), currentUser(r).ID, v.ID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
		}
		if input.Name != nil {
			v.Name = strings.TrimSpace(*input.Name)
		}
		if input.Instructions != nil {
			v.Instructions = strings.TrimSpace(*input.Instructions)
		}
		if v.Name == "" || len([]rune(v.Name)) > 120 || len(v.Instructions) > 32000 {
			writeError(w, http.StatusBadRequest, errors.New("项目名称或说明长度不正确"))
			return
		}
		v, err = s.store.SaveProject(r.Context(), currentUser(r).ID, v)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if r.Method == http.MethodPost {
			if bridge, bridgeErr := s.bridgeSource(); bridgeErr == nil {
				scope := agent.RunScope{UserID: currentUser(r).ID, ProjectID: v.ID, WorkspaceID: currentUser(r).ID, CWD: v.WorkspacePath}
				status, _, body, initErr := bridge.Bridge(agent.WithRunScope(r.Context(), scope), scope.UserID, http.MethodPost, "/workspace/init", []byte(`{}`))
				if initErr != nil || status >= 400 {
					writeError(w, http.StatusBadGateway, bridgeError(status, body, initErr))
					return
				}
			}
		}
		status := http.StatusOK
		if r.Method == http.MethodPost {
			status = http.StatusCreated
		}
		writeJSON(w, status, v)
	})
	mux.HandleFunc("POST /api/projects", save)
	mux.HandleFunc("PATCH /api/projects/{id}", save)
	mux.HandleFunc("DELETE /api/projects/{id}", s.auth.require(func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.DeleteProject(r.Context(), currentUser(r).ID, r.PathValue("id")); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}
