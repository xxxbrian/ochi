package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"ochi/server/internal/filelimits"
	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
)

const maxReleaseNotes = 10000

type androidClientRelease struct {
	*storage.AndroidClientRelease
	DownloadURL string `json:"download_url"`
}

type clientReleases struct {
	Android *androidClientRelease     `json:"android"`
	IOS     *storage.IOSClientRelease `json:"ios"`
}

func publicClientReleases(value storage.ClientReleases) clientReleases {
	result := clientReleases{IOS: value.IOS}
	if value.Android != nil {
		result.Android = &androidClientRelease{
			AndroidClientRelease: value.Android,
			DownloadURL:          "/api/client-releases/android/" + value.Android.SHA256 + ".apk",
		}
	}
	return result
}

func (s *Server) registerClientReleaseRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/client-releases", s.getClientReleases)
	mux.HandleFunc("GET /api/client-releases/android/{file}", s.downloadAndroidClient)
	mux.HandleFunc("GET /api/admin/client-releases", s.auth.admin(s.getClientReleases))
	mux.HandleFunc("POST /api/admin/client-releases/android", s.auth.admin(s.uploadAndroidClient))
	mux.HandleFunc("DELETE /api/admin/client-releases/android", s.auth.admin(s.deleteAndroidClient))
	mux.HandleFunc("PUT /api/admin/client-releases/ios", s.auth.admin(s.updateIOSClient))
}

func (s *Server) getClientReleases(w http.ResponseWriter, r *http.Request) {
	releases, err := s.store.ClientReleases(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, publicClientReleases(releases))
}

func clientReleaseRoot() string {
	return filepath.Join(artifactsRoot(), "_clients")
}

func clientReleasePath(hash string) string {
	return filepath.Join(clientReleaseRoot(), hash+".apk")
}

func (s *Server) uploadAndroidClient(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, filelimits.MaxFileBytes()+filelimits.MultipartOverheadBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, i18n.New("bad_request"))
		return
	}
	if err := os.MkdirAll(clientReleaseRoot(), 0700); err != nil {
		writeError(w, http.StatusInternalServerError, i18n.Wrap("client_release_upload_failed", err))
		return
	}
	var temporary string
	defer func() {
		if temporary != "" {
			_ = os.Remove(temporary)
		}
	}()
	var release storage.AndroidClientRelease
	seenNotes := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			clientReleaseUploadError(w, err)
			return
		}
		switch part.FormName() {
		case "release_notes":
			if seenNotes || part.FileName() != "" {
				writeError(w, http.StatusBadRequest, i18n.New("bad_request"))
				return
			}
			seenNotes = true
			notes, err := io.ReadAll(io.LimitReader(part, maxReleaseNotes*4+1))
			if err != nil {
				clientReleaseUploadError(w, err)
				return
			}
			if !utf8.Valid(notes) || utf8.RuneCount(notes) > maxReleaseNotes {
				writeError(w, http.StatusBadRequest, i18n.New("client_release_notes_too_long"))
				return
			}
			release.ReleaseNotes = string(notes)
		case "file":
			if temporary != "" || part.FileName() == "" || !strings.EqualFold(filepath.Ext(part.FileName()), ".apk") {
				writeError(w, http.StatusBadRequest, i18n.New("client_release_invalid_apk"))
				return
			}
			file, err := os.CreateTemp(clientReleaseRoot(), ".upload-*")
			if err != nil {
				writeError(w, http.StatusInternalServerError, i18n.Wrap("client_release_upload_failed", err))
				return
			}
			temporary = file.Name()
			hash := sha256.New()
			size, copyErr := io.CopyBuffer(io.MultiWriter(file, hash), io.LimitReader(part, filelimits.MaxFileBytes()+1), make([]byte, 64<<10))
			if copyErr == nil {
				copyErr = file.Sync()
			}
			closeErr := file.Close()
			if size > filelimits.MaxFileBytes() {
				writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
				return
			}
			if copyErr != nil {
				clientReleaseUploadError(w, copyErr)
				return
			}
			if closeErr != nil {
				writeError(w, http.StatusInternalServerError, i18n.Wrap("client_release_upload_failed", closeErr))
				return
			}
			release.SizeBytes = size
			release.SHA256 = hex.EncodeToString(hash.Sum(nil))
		default:
			writeError(w, http.StatusBadRequest, i18n.New("bad_request"))
			return
		}
	}
	if temporary == "" {
		writeError(w, http.StatusBadRequest, i18n.New("client_release_invalid_apk"))
		return
	}
	version, err := readAPKVersion(temporary)
	if err != nil {
		writeError(w, http.StatusBadRequest, i18n.Wrap("client_release_invalid_apk", err))
		return
	}
	release.VersionName, release.VersionCode = version.name, version.code
	release.PublishedAt = time.Now().UTC()

	s.clientReleaseMu.Lock()
	defer s.clientReleaseMu.Unlock()
	current, err := s.store.ClientReleases(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if current.Android != nil && current.Android.SHA256 != release.SHA256 && current.Android.VersionCode >= release.VersionCode {
		writeError(w, http.StatusConflict, i18n.New("client_release_version_not_newer"))
		return
	}
	created := false
	if err := os.Link(temporary, clientReleasePath(release.SHA256)); err == nil {
		created = true
	} else if !errors.Is(err, os.ErrExist) {
		writeError(w, http.StatusInternalServerError, i18n.Wrap("client_release_upload_failed", err))
		return
	}
	updated, err := s.store.SaveAndroidClientRelease(r.Context(), &release)
	if err != nil {
		if created {
			_ = os.Remove(clientReleasePath(release.SHA256))
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if current.Android != nil && current.Android.SHA256 != release.SHA256 {
		removeClientRelease(current.Android)
	}
	writeJSON(w, http.StatusOK, publicClientReleases(updated))
}

func clientReleaseUploadError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, i18n.New("payload_too_large"))
		return
	}
	writeError(w, http.StatusBadRequest, i18n.Wrap("client_release_upload_failed", err))
}

func removeClientRelease(release *storage.AndroidClientRelease) {
	if err := os.Remove(clientReleasePath(release.SHA256)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("remove unpublished Android package: %v", err)
	}
}

func (s *Server) deleteAndroidClient(w http.ResponseWriter, r *http.Request) {
	s.clientReleaseMu.Lock()
	defer s.clientReleaseMu.Unlock()
	current, err := s.store.ClientReleases(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	updated, err := s.store.SaveAndroidClientRelease(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if current.Android != nil {
		removeClientRelease(current.Android)
	}
	writeJSON(w, http.StatusOK, publicClientReleases(updated))
}

func (s *Server) updateIOSClient(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !decodeRequest(w, r, &body) {
		return
	}
	link := strings.TrimSpace(body.URL)
	var release *storage.IOSClientRelease
	if link != "" {
		value, err := url.Parse(link)
		if err != nil || len(link) > 2048 || value.Scheme != "https" || value.Hostname() == "" || value.User != nil {
			writeError(w, http.StatusBadRequest, i18n.New("client_release_invalid_ios_url"))
			return
		}
		release = &storage.IOSClientRelease{URL: link}
	}
	s.clientReleaseMu.Lock()
	defer s.clientReleaseMu.Unlock()
	updated, err := s.store.SaveIOSClientRelease(r.Context(), release)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, publicClientReleases(updated))
}

func (s *Server) downloadAndroidClient(w http.ResponseWriter, r *http.Request) {
	// Open under the same short publication lock as replacement/removal. Once
	// open, an existing stream finishes even when a newer package is published.
	s.clientReleaseMu.Lock()
	current, err := s.store.ClientReleases(r.Context())
	if err != nil {
		s.clientReleaseMu.Unlock()
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	release := current.Android
	if release == nil || r.PathValue("file") != release.SHA256+".apk" {
		s.clientReleaseMu.Unlock()
		writeError(w, http.StatusNotFound, i18n.New("not_found"))
		return
	}
	file, err := os.Open(clientReleasePath(release.SHA256))
	s.clientReleaseMu.Unlock()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, i18n.Wrap("client_release_unavailable", err))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() != release.SizeBytes {
		writeError(w, http.StatusServiceUnavailable, i18n.New("client_release_unavailable"))
		return
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": fmt.Sprintf("Ochi-%d.apk", release.VersionCode),
	}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+release.SHA256+`"`)
	http.ServeContent(w, r, "", release.PublishedAt, file)
}
