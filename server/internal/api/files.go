package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

type bridgeSource interface {
	Bridge(context.Context, string, string, string, []byte) (int, http.Header, []byte, error)
}

func (s *Server) bridgeSource() (bridgeSource, error) {
	if wrapped, ok := s.tools.(*personalTools); ok {
		if bridge, ok := wrapped.source.(bridgeSource); ok {
			return bridge, nil
		}
	}
	if bridge, ok := s.tools.(bridgeSource); ok {
		return bridge, nil
	}
	return nil, errors.New("computer workspace is unavailable")
}

func (s *Server) registerExtraRoutes(mux *http.ServeMux) {
	s.registerFileRoutes(mux)
	s.registerExtensionRoutes(mux)
	s.registerPluginRoutes(mux)
	s.registerPersonalRoutes(mux)
	s.registerScheduleRoutes(mux)
	s.registerComputerRoutes(mux)
}

func (s *Server) registerFileRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/files", s.auth.require(s.uploadFile))
	mux.HandleFunc("GET /api/files", s.auth.require(s.listFiles))
	mux.HandleFunc("GET /api/files/{id}/content", s.auth.require(s.fileContent))
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 33*1024*1024)
	if err := r.ParseMultipartForm(2 * 1024 * 1024); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("file must be no larger than 32 MB"))
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("file is required"))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 32*1024*1024+1))
	if err != nil || len(data) > 32*1024*1024 {
		writeError(w, http.StatusBadRequest, errors.New("file must be no larger than 32 MB"))
		return
	}
	id, err := newID()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	name := filepath.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
	if name == "." || name == "" {
		name = "attachment"
	}
	path := "/data/files/uploads/" + id + "/" + name
	key, err := storeArtifactBytes(currentUser(r).ID, path, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	mimeType := mime.TypeByExtension(filepath.Ext(name))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	item, err := s.store.SaveArtifact(r.Context(), storage.Artifact{UserID: currentUser(r).ID, Name: name, Path: path, MIMEType: mimeType, Size: int64(len(data)), StorageKey: key})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListArtifacts(r.Context(), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) fileContent(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetArtifact(r.Context(), currentUser(r).ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	data, err := artifactBytes(item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	mimeType := item.MIMEType
	if strings.HasPrefix(mimeType, "text/") || mimeType == "image/svg+xml" || mimeType == "application/json" {
		mimeType = strings.Split(mimeType, ";")[0] + "; charset=utf-8"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'")
	disposition := "inline"
	if r.URL.Query().Get("download") != "" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": item.Name}))
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) attachmentsForRun(ctx context.Context, userID, sessionID string, ids []string) ([]agent.Attachment, error) {
	if _, err := s.store.GetSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	items, err := s.store.GetArtifacts(ctx, userID, ids)
	if err != nil {
		return nil, err
	}
	attachments := make([]agent.Attachment, 0, len(items))
	for _, item := range items {
		attachments = append(attachments, item.Attachment())
	}
	return attachments, nil
}

func (s *Server) publishArtifact(ctx context.Context, userID, sessionID, runID, path string) (storage.Artifact, error) {
	bridge, err := s.bridgeSource()
	if err != nil {
		return storage.Artifact{}, err
	}
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.RunID != runID || scope.SessionID != sessionID {
		return storage.Artifact{}, errors.New("missing artifact run scope")
	}
	payload, _ := json.Marshal(map[string]string{"path": path})
	status, _, body, err := bridge.Bridge(ctx, userID, http.MethodPost, "/publish", payload)
	if err != nil || status >= 400 {
		return storage.Artifact{}, bridgeError(status, body, err)
	}
	var v storage.Artifact
	if err = json.Unmarshal(body, &v); err != nil {
		return v, err
	}
	v.UserID, v.SessionID, v.RunID = userID, sessionID, runID
	status, _, data, err := bridge.Bridge(ctx, userID, http.MethodGet, "/file?path="+url.QueryEscape(v.Path), nil)
	if err != nil || status >= 400 {
		return v, bridgeError(status, data, err)
	}
	v.StorageKey, err = storeArtifactBytes(userID, v.Path, data)
	if err != nil {
		return v, err
	}
	return s.store.SaveArtifact(ctx, v)
}

func bridgeError(status int, body []byte, err error) error {
	if err != nil {
		return err
	}
	var message struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &message) == nil && message.Error != "" {
		return errors.New(message.Error)
	}
	return fmt.Errorf("workspace returned HTTP %d", status)
}
