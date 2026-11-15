package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"ochi/server/internal/agent"
)

type fileTransferReader struct{}

func (fileTransferReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func TestBridgeFileStreamsAbove32MiBAndKeepsBorrowUntilClose(t *testing.T) {
	const size = int64(40<<20 + 137)
	root := t.TempDir()
	target := filepath.Join(root, "transferred.bin")
	scope := agent.RunScope{UserID: "fixture", SessionID: "conversation", RunID: "turn", CWD: "/data/work"}
	ctx := agent.WithRunScope(context.Background(), scope)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = io.WriteString(w, fixtureHealth("workspace"))
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+fixtureToken {
			t.Error("file request lost private bridge authentication")
		}
		var received agent.RunScope
		if json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &received) != nil || received.RunID != scope.RunID || received.SessionID != scope.SessionID {
			t.Error("streaming request lost file ownership scope")
		}
		if r.Method == http.MethodPut {
			if r.ContentLength != size {
				t.Error("streaming upload lost exact content length")
			}
			file, err := os.Create(target)
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			copied, err := io.Copy(file, r.Body)
			file.Close()
			if err != nil || copied != size {
				t.Error("file request did not stream exact bytes", copied, err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"written":true}`)
			return
		}
		http.ServeFile(w, r, target)
	}))
	defer server.Close()
	d := NewDocker(Config{})
	d.rememberAddress(scope.UserID, server.URL)
	if err := d.rememberBridgeToken(scope.UserID, []string{"OCHI_BRIDGE_TOKEN=" + fixtureToken}); err != nil {
		t.Fatal(err)
	}
	borrows := func() int {
		d.mu.Lock()
		defer d.mu.Unlock()
		return d.active[scope.UserID]
	}
	status, _, body, err := d.BridgeStream(ctx, scope.UserID, http.MethodPut, "/file?path=large.bin", io.LimitReader(fileTransferReader{}, size), size)
	if err != nil || status != http.StatusCreated || borrows() != 1 {
		t.Fatal("streaming upload did not retain the workspace", status, err, borrows())
	}
	_, _ = io.Copy(io.Discard, body)
	body.Close()
	body.Close()
	if borrows() != 0 {
		t.Fatal("closing a file response did not release exactly once")
	}
	status, header, body, err := d.BridgeStream(ctx, scope.UserID, http.MethodGet, "/file?path=large.bin", nil, 0)
	if err != nil || status != http.StatusOK || header.Get("Content-Length") != strconv.FormatInt(size, 10) || borrows() != 1 {
		t.Fatal("streaming download failed", status, err)
	}
	got, expected := sha256.New(), sha256.New()
	copied, err := io.Copy(got, body)
	body.Close()
	_, _ = io.Copy(expected, io.LimitReader(fileTransferReader{}, size))
	if err != nil || copied != size || !bytes.Equal(got.Sum(nil), expected.Sum(nil)) || borrows() != 0 {
		t.Fatal("large bridge download changed or retained its workspace")
	}
	if _, _, _, err := d.Bridge(ctx, scope.UserID, http.MethodGet, "/file?path=large.bin", nil); err == nil {
		t.Fatal("file bytes escaped through the in-memory control bridge")
	}
	t.Setenv("OCHI_MAX_FILE_BYTES", "1048576")
	if _, _, _, err := d.BridgeStream(ctx, scope.UserID, http.MethodPut, "/file?path=large.bin", strings.NewReader(""), size); err == nil || borrows() != 0 {
		t.Fatal("oversize upload borrowed the workspace")
	}
	if _, _, _, err := d.BridgeStream(ctx, scope.UserID, http.MethodGet, "/file?path=large.bin", nil, 0); err == nil || borrows() != 0 {
		t.Fatal("oversize download retained a borrowed workspace")
	}
}

func TestBridgeFileCancellationReleasesBorrow(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = io.WriteString(w, fixtureHealth("workspace"))
			return
		}
		w.Header().Set("Content-Length", "1048576")
		_, _ = io.WriteString(w, "started")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	d := NewDocker(Config{})
	d.rememberAddress("fixture", server.URL)
	if err := d.rememberBridgeToken("fixture", []string{"OCHI_BRIDGE_TOKEN=" + fixtureToken}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, _, body, err := d.BridgeStream(ctx, "fixture", http.MethodGet, "/file?path=cancelled.bin", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	cancel()
	_, readErr := io.Copy(io.Discard, body)
	body.Close()
	d.mu.Lock()
	active := d.active["fixture"]
	d.mu.Unlock()
	if readErr == nil || active != 0 {
		t.Fatal("cancelled transfer did not interrupt/release", readErr, active)
	}
}
