package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/i18n"
	"ochi/server/internal/runtime"
	"ochi/server/internal/workspace"
)

func (s *Server) registerExtensionRoutes(mux *http.ServeMux) {
	for _, kind := range []string{"skills", "mcp"} {
		for _, pattern := range []string{
			"GET /api/admin/" + kind, "POST /api/admin/" + kind,
			"GET /api/admin/" + kind + "/{id}", "PATCH /api/admin/" + kind + "/{id}",
			"DELETE /api/admin/" + kind + "/{id}", "POST /api/admin/" + kind + "/{id}/test",
			"POST /api/admin/" + kind + "/{id}/install",
		} {
			mux.HandleFunc(pattern, s.auth.admin(s.extensionRequest))
		}
	}
	mux.HandleFunc("GET /api/admin/workspaces", s.auth.admin(s.listWorkspaces))
	mux.HandleFunc("POST /api/admin/workspaces/{id}/{action}", s.auth.admin(s.manageWorkspace))
	mux.HandleFunc("DELETE /api/admin/workspaces/{id}", s.auth.admin(s.deleteWorkspace))
}

func (s *Server) extensionRequest(w http.ResponseWriter, r *http.Request) {
	bridge, err := s.bridgeSource()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/")
	segments := strings.Split(path, "/")
	if len(segments) == 0 || (segments[0] != "skills" && segments[0] != "mcp") {
		writeError(w, http.StatusBadRequest, i18n.New("extension_unknown"))
		return
	}
	if r.Method == http.MethodDelete && len(segments) == 2 {
		s.extensionMu.Lock()
		defer s.extensionMu.Unlock()
		owner, readErr := s.store.PluginForComponent(r.Context(), segments[0], segments[1])
		if readErr != nil {
			writeStoreError(w, readErr)
			return
		}
		if owner != "" {
			writeError(w, http.StatusConflict, i18n.New("extension_in_plugin"))
			return
		}
	}
	if r.Method != http.MethodGet && !strings.HasSuffix(path, "/test") {
		active, readErr := s.store.AnyActiveRun(r.Context())
		if readErr != nil {
			writeStoreError(w, readErr)
			return
		}
		if active {
			writeError(w, http.StatusConflict, i18n.New("extension_busy"))
			return
		}
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	if err != nil {
		writeError(w, http.StatusBadRequest, i18n.New("configuration_too_large"))
		return
	}
	userID := "__admin__"
	if segments[0] == "skills" && ((r.Method == http.MethodPost && len(segments) == 1) || (r.Method == http.MethodPatch && len(segments) == 2)) {
		// The control bridge accepts a selected bundle as data. It intentionally
		// has no arbitrary file-read/write or shell route.
		var input map[string]json.RawMessage
		if json.Unmarshal(data, &input) == nil {
			var filePath, source, artifactID string
			var bundle []byte
			_ = json.Unmarshal(input["path"], &filePath)
			_ = json.Unmarshal(input["source"], &source)
			_ = json.Unmarshal(input["artifact_id"], &artifactID)
			if artifactID != "" {
				file, readErr := s.store.GetArtifact(r.Context(), currentUser(r).ID, artifactID)
				if readErr != nil {
					writeStoreError(w, readErr)
					return
				}
				filePath = file.Path
				bundle, readErr = artifactBytes(file)
				if readErr != nil {
					writeError(w, http.StatusBadGateway, readErr)
					return
				}
				delete(input, "artifact_id")
				input["path"], _ = json.Marshal(filePath)
				input["source"], _ = json.Marshal(filePath)
				data, _ = json.Marshal(input)
			} else if source != "" && source != "inline" {
				filePath = source
			}
			if strings.HasPrefix(filePath, "uploads/") {
				filePath = "/data/files/" + filePath
			}
			if strings.HasPrefix(filePath, "/data/files/uploads/") {
				input["source"], _ = json.Marshal(filePath)
				data, _ = json.Marshal(input)
				if bundle == nil {
					status, _, bytes, readErr := bridge.Bridge(r.Context(), currentUser(r).ID, http.MethodGet, "/file?path="+url.QueryEscape(filePath), nil)
					if readErr != nil || status >= 400 {
						writeError(w, http.StatusBadGateway, bridgeError(status, bytes, readErr))
						return
					}
					bundle = bytes
				}
				input["bundle_base64"], _ = json.Marshal(bundle)
				delete(input, "path")
				delete(input, "source")
				data, _ = json.Marshal(input)
			}
		}
	}
	if strings.HasSuffix(path, "/install") {
		userID = currentUser(r).ID
		var input map[string]json.RawMessage
		if json.Unmarshal(data, &input) == nil {
			var selected string
			_ = json.Unmarshal(input["user_id"], &selected)
			if selected != "" {
				if _, err := s.store.GetUser(r.Context(), selected); err != nil {
					writeStoreError(w, err)
					return
				}
				userID = selected
			}
			delete(input, "user_id")
			data, _ = json.Marshal(input)
		}
		runID, err := newID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		ctx, finishAccount, err := s.accounts.begin(r.Context(), userID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		defer finishAccount()
		r = r.WithContext(ctx)
		if _, err := s.store.UserByID(ctx, userID); err != nil {
			writeStoreError(w, err)
			return
		}
		scope := agent.RunScope{
			UserID: userID, SessionID: "skill-install-" + segments[1], RunID: runID,
		}
		owner := resourceOwner{UserID: userID, SessionID: scope.SessionID, RunID: runID}
		if _, err := s.resources.wait(r.Context(), resourceRequest{
			Owner: owner, Keys: []string{"desktop:" + userID}, NoCheckpoint: true,
			Available: func(ctx context.Context) (bool, error) {
				return s.jobClaimsAvailable(ctx, scope, []string{"desktop"}, false)
			},
		}, nil); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		defer s.resources.releaseRun(runID)
		defer s.finishWorkspaceRun(scope, runtime.StatusCompleted)
		r = r.WithContext(agent.WithRunScope(r.Context(), scope))
	}
	status, _, body, err := bridge.Bridge(r.Context(), userID, r.Method, "/extensions/"+path, data)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	if status >= 400 {
		writeError(w, status, bridgeError(status, body, nil))
		return
	}
	if r.Method == http.MethodGet && len(segments) == 1 {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(body, &envelope) == nil {
			if list := envelope[segments[0]]; len(list) > 0 {
				body = list
			}
			if list := envelope["servers"]; segments[0] == "mcp" && len(list) > 0 {
				body = list
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

type managedWorkspace interface {
	Inspect(context.Context, string) (workspace.State, error)
	Manage(context.Context, string, string) (workspace.State, error)
}

func (s *Server) workspaceManager() (managedWorkspace, error) {
	if wrapped, ok := s.tools.(*personalTools); ok {
		if value, ok := wrapped.source.(managedWorkspace); ok {
			return value, nil
		}
	}
	return nil, i18n.New("computer_unavailable")
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	manager, err := s.workspaceManager()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	control, err := manager.Inspect(r.Context(), "__admin__")
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	items := []workspace.State{control}
	for _, user := range users {
		item, err := manager.Inspect(r.Context(), user.ID)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) manageWorkspace(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	ctx, finishAccount, err := s.accounts.begin(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer finishAccount()
	r = r.WithContext(ctx)
	var active bool
	if userID == "__admin__" {
		// The shared plugin executor can serve any user's run.
		active, err = s.store.AnyActiveRun(r.Context())
	} else {
		if _, err := s.store.UserByID(r.Context(), userID); err != nil {
			writeStoreError(w, err)
			return
		}
		var status string
		status, err = s.store.ActiveRunStatus(r.Context(), userID)
		active = status != ""
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if active {
		writeError(w, http.StatusConflict, i18n.New("workspace_busy"))
		return
	}
	manager, err := s.workspaceManager()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	item, err := manager.Manage(r.Context(), userID, r.PathValue("action"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
