package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

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
		writeError(w, http.StatusBadRequest, errors.New("unknown extension"))
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
			writeError(w, http.StatusConflict, errors.New("请先从插件中移除此组件"))
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
			writeError(w, http.StatusConflict, errors.New("请等待当前任务结束后修改扩展配置"))
			return
		}
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("configuration is too large"))
		return
	}
	userID := "__admin__"
	if segments[0] == "skills" && ((r.Method == http.MethodPost && len(segments) == 1) || (r.Method == http.MethodPatch && len(segments) == 2)) {
		// Uploaded bundles initially live in the administrator's personal volume.
		// Copy a selected bundle into the private management workspace before
		// installation; regular users never get a writable extensions mount.
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
				status, _, response, writeErr := bridge.Bridge(r.Context(), userID, http.MethodPut, "/file?path="+url.QueryEscape(filePath), bundle)
				if writeErr != nil || status >= 400 {
					writeError(w, http.StatusBadGateway, bridgeError(status, response, writeErr))
					return
				}
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
	return nil, errors.New("workspace manager is unavailable")
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
	items := []workspace.State{}
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
	userID, _ := url.PathUnescape(r.PathValue("id"))
	if _, err := s.store.GetUser(r.Context(), userID); err != nil {
		writeStoreError(w, err)
		return
	}
	status, err := s.store.ActiveRunStatus(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if status != "" {
		writeError(w, http.StatusConflict, errors.New("workspace has an active task"))
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
