package api

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/filelimits"
	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
)

type bridgeSource interface {
	Bridge(context.Context, string, string, string, []byte) (int, http.Header, []byte, error)
}

type streamingBridgeSource interface {
	BridgeStream(context.Context, string, string, string, io.Reader, int64) (int, http.Header, io.ReadCloser, error)
}

func bridgeFile(ctx context.Context, bridge bridgeSource, userID, method, path string, body io.Reader, size int64) (int, http.Header, io.ReadCloser, error) {
	stream, ok := bridge.(streamingBridgeSource)
	if !ok {
		return 0, nil, nil, errors.New("workspace file streaming is unavailable")
	}
	return stream.BridgeStream(ctx, userID, method, path, body, size)
}

func bridgeReply(status int, body io.ReadCloser, err error) ([]byte, error) {
	if err != nil {
		if body != nil {
			body.Close()
		}
		return nil, err
	}
	if body == nil {
		return nil, errors.New("workspace file response is missing")
	}
	defer body.Close()
	data, readErr := io.ReadAll(io.LimitReader(body, filelimits.BridgeErrorBytes+1))
	if readErr != nil {
		return nil, readErr
	}
	if int64(len(data)) > filelimits.BridgeErrorBytes {
		return nil, errors.New("workspace file response is too large")
	}
	if status >= 400 {
		return nil, bridgeError(status, data, nil)
	}
	return data, nil
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
	return nil, i18n.New("computer_unavailable")
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
	bodyLimit := filelimits.MaxFileBytes() + filelimits.MultipartOverheadBytes
	if r.ContentLength > bodyLimit {
		writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, i18n.New("payload_too_large"))
		return
	}
	id, err := newID()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var upload storage.Artifact
	saved := false
	defer func() {
		if !saved && upload.StorageKey != "" {
			_ = os.Remove(filepath.Join(artifactsRoot(), upload.StorageKey))
		}
	}()
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
			return
		}
		if part.FormName() != "file" || part.FileName() == "" || upload.StorageKey != "" {
			r.Body.Close()
			writeError(w, http.StatusBadRequest, i18n.New("file_required"))
			return
		}
		name := filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
		if name == "." || name == "" {
			name = "attachment"
		}
		path := "/data/files/uploads/" + id + "/" + name
		content := bufio.NewReader(part)
		sample, _ := content.Peek(512)
		mimeType := mime.TypeByExtension(filepath.Ext(name))
		if mimeType == "" {
			mimeType = http.DetectContentType(sample)
		}
		key, size, storeErr := storeArtifactStream(currentUser(r).ID, path, content)
		if storeErr != nil {
			r.Body.Close()
			if errors.Is(storeErr, errFileTooLarge) || errors.As(storeErr, new(*http.MaxBytesError)) {
				writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
			} else {
				writeError(w, http.StatusBadRequest, storeErr)
			}
			return
		}
		part.Close()
		upload = storage.Artifact{UserID: currentUser(r).ID, Name: name, Path: path, MIMEType: mimeType, Size: size, StorageKey: key}
	}
	if upload.StorageKey == "" {
		writeError(w, http.StatusBadRequest, i18n.New("file_required"))
		return
	}
	item, err := s.store.SaveArtifact(r.Context(), upload)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	saved = true
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
	file, err := openArtifact(item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	if info.Size() > filelimits.MaxFileBytes() {
		writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
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
	http.ServeContent(w, r, item.Name, info.ModTime(), file)
}

// Large images remain file references; the model can request a bounded preview.
func (s *Server) prepareAttachmentImages(ctx context.Context, userID string, attachments []agent.Attachment) error {
	var total int64
	for i := range attachments {
		item := &attachments[i]
		if !strings.HasPrefix(item.MIMEType, "image/") || item.MIMEType == "image/svg+xml" || item.Size > filelimits.ModelImageBytes || total+item.Size > filelimits.ModelImagesBytes {
			continue
		}
		file, err := s.store.GetArtifact(ctx, userID, item.ID)
		if err != nil {
			return err
		}
		data, err := artifactBytesLimited(file, filelimits.ModelImageBytes)
		if errors.Is(err, errFileTooLarge) {
			continue
		}
		if err != nil {
			return err
		}
		if total+int64(len(data)) > filelimits.ModelImagesBytes {
			continue
		}
		total += int64(len(data))
		item.DataURL = "data:" + item.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	return nil
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
	status, _, data, err := bridgeFile(ctx, bridge, userID, http.MethodGet, "/file?path="+url.QueryEscape(v.Path), nil, 0)
	if err != nil {
		return v, err
	}
	if status >= 400 {
		_, err = bridgeReply(status, data, nil)
		return v, err
	}
	defer data.Close()
	var size int64
	v.StorageKey, size, err = storeArtifactStream(userID, v.Path, data)
	if err != nil {
		return v, err
	}
	v.Size = size
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
