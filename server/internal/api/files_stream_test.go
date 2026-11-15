package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/filelimits"
	"ochi/server/internal/storage"
)

type fixtureFileReader struct {
	maxRead int
}

func (r *fixtureFileReader) Read(p []byte) (int, error) {
	if len(p) > 1<<20 {
		return 0, errors.New("file transfer attempted an unbounded read")
	}
	if len(p) > r.maxRead {
		r.maxRead = len(p)
	}
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func fixtureFileHash(size int64) []byte {
	hash := sha256.New()
	_, _ = io.Copy(hash, io.LimitReader(&fixtureFileReader{}, size))
	return hash.Sum(nil)
}

func artifactBytes(item storage.Artifact) ([]byte, error) {
	return artifactBytesLimited(item, filelimits.ImageReferenceBytes)
}

// Existing controlled filesystem fixtures are intentionally small and in memory.
// Real byte-transfer coverage below uses disk and HTTP instead.
func fixtureBridgeStream(ctx context.Context, source bridgeSource, userID, method, path string, body io.Reader, size int64) (int, http.Header, io.ReadCloser, error) {
	var data []byte
	var err error
	if body != nil {
		data, err = io.ReadAll(io.LimitReader(body, size+1))
		if err != nil {
			return 0, nil, nil, err
		}
	}
	status, headers, response, err := source.Bridge(ctx, userID, method, path, data)
	if err != nil {
		return status, headers, nil, err
	}
	return status, headers, io.NopCloser(bytes.NewReader(response)), nil
}

func (f *coreEvalFilesystem) BridgeStream(ctx context.Context, userID, method, path string, body io.Reader, size int64) (int, http.Header, io.ReadCloser, error) {
	return fixtureBridgeStream(ctx, f, userID, method, path, body, size)
}

func (f *scopedComputerFixture) BridgeStream(ctx context.Context, userID, method, path string, body io.Reader, size int64) (int, http.Header, io.ReadCloser, error) {
	return fixtureBridgeStream(ctx, f, userID, method, path, body, size)
}

func TestArtifactStoreStreamsLargeFilesAndBoundsMemoryConsumers(t *testing.T) {
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	const size = int64(40<<20 + 137)
	source := &fixtureFileReader{}
	key, stored, err := storeArtifactStream("fixture", "/data/files/uploads/fixture/large.bin", io.LimitReader(source, size))
	if err != nil || stored != size || source.maxRead > 1<<20 {
		t.Fatalf("large streaming store: %d %v", stored, err)
	}
	item := storage.Artifact{StorageKey: key, Size: 1}
	file, err := openArtifact(item)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hash := sha256.New()
	if copied, err := io.Copy(hash, file); err != nil || copied != size || !bytes.Equal(hash.Sum(nil), fixtureFileHash(size)) {
		t.Fatal("stored stream differs from source")
	}
	if _, err := artifactBytesLimited(item, filelimits.ModelImageBytes); !errors.Is(err, errFileTooLarge) {
		t.Fatal("context consumer trusted small metadata instead of stored bytes")
	}
	for _, invalid := range []string{"/data/../outside.bin", "/data/../../outside.bin", "data/relative.bin"} {
		if _, _, err := storeArtifactStream("fixture", invalid, strings.NewReader("x")); err == nil {
			t.Fatal("accepted an artifact outside /data", invalid)
		}
	}
}

type fixtureBrokenReader struct{}

func (fixtureBrokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestArtifactRejectedStreamsLeaveNoBytes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ARTIFACTS_ROOT", root)
	t.Setenv("OCHI_MAX_FILE_BYTES", "1048576")
	for _, source := range []io.Reader{io.LimitReader(&fixtureFileReader{}, 1<<20+1), io.MultiReader(strings.NewReader("partial"), fixtureBrokenReader{})} {
		if _, _, err := storeArtifactStream("fixture", "/data/files/uploads/failed.bin", source); err == nil {
			t.Fatal("failed stream was stored")
		}
	}
	_ = filepath.WalkDir(root, func(path string, item os.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if !item.IsDir() {
			t.Fatal("rejected transfer left bytes", path)
		}
		return nil
	})
}

func streamMultipartRequest(t *testing.T, endpoint, token string, size int64) (*http.Response, error) {
	t.Helper()
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/files", reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", form.FormDataContentType())
	done := make(chan struct{})
	go func() {
		defer close(done)
		part, err := form.CreateFormFile("file", "large.bin")
		if err == nil {
			_, err = io.Copy(part, io.LimitReader(&fixtureFileReader{}, size))
		}
		if err == nil {
			err = form.Close()
		}
		_ = writer.CloseWithError(err)
	}()
	response, err := http.DefaultClient.Do(request)
	_ = reader.Close()
	<-done
	return response, err
}

func TestFilesHTTPStreamsAbove32MiBAndSupportsOwnedRanges(t *testing.T) {
	f := newCoreHTTPFixture(t)
	root := t.TempDir()
	t.Setenv("ARTIFACTS_ROOT", root)
	api := httptest.NewServer(f.server.Handler())
	defer api.Close()
	const size = int64(40<<20 + 137)
	response, err := streamMultipartRequest(t, api.URL, f.token, size)
	if err != nil {
		t.Fatal(err)
	}
	var item storage.Artifact
	err = json.NewDecoder(response.Body).Decode(&item)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusCreated || item.Size != size {
		t.Fatalf("large upload: status=%d artifact=%+v err=%v", response.StatusCode, item, err)
	}
	for _, token := range []string{f.token, f.foreign, ""} {
		request, _ := http.NewRequest(http.MethodGet, api.URL+item.URL+"?download=1", nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if token == f.token {
			hash := sha256.New()
			copied, err := io.Copy(hash, response.Body)
			if err != nil || response.StatusCode != http.StatusOK || response.ContentLength != size || copied != size || !bytes.Equal(hash.Sum(nil), fixtureFileHash(size)) {
				t.Fatal("large download was truncated or changed")
			}
		} else if response.StatusCode != http.StatusNotFound && response.StatusCode != http.StatusUnauthorized {
			t.Fatal("file bytes escaped ownership", response.StatusCode)
		}
		response.Body.Close()
	}
	request, _ := http.NewRequest(http.MethodGet, api.URL+item.URL, nil)
	request.Header.Set("Authorization", "Bearer "+f.token)
	request.Header.Set("Range", "bytes=33554432-34603007")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	copied, copyErr := io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if copyErr != nil || response.StatusCode != http.StatusPartialContent || copied != 1<<20 || response.Header.Get("Content-Range") != fmt.Sprintf("bytes 33554432-34603007/%d", size) {
		t.Fatal("large file range response was not exact")
	}
	t.Setenv("OCHI_MAX_FILE_BYTES", strconv.FormatInt(33<<20, 10))
	response, err = streamMultipartRequest(t, api.URL, f.token, 34<<20)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal("configured single-file cap was not enforced", response.StatusCode)
	}
	files, err := f.server.store.ListArtifacts(context.Background(), f.owner)
	if err != nil || len(files) != 1 {
		t.Fatal("rejected upload persisted metadata")
	}
	var diskFiles int
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if !entry.IsDir() {
			diskFiles++
			if strings.HasPrefix(entry.Name(), ".artifact-") {
				t.Fatal("temporary upload was not cleaned", path)
			}
		}
		return nil
	})
	if diskFiles != 1 {
		t.Fatal("rejected upload left a partial stored file", diskFiles)
	}
}

func TestAttachmentImageBudgetLeavesLargeFilesUsableByPath(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	var attachments []agent.Attachment
	for index, size := range []int64{8 << 20, 8 << 20, 8 << 20, 8 << 20, 8 << 20, 40 << 20} {
		path := fmt.Sprintf("/data/files/uploads/budget/%d.png", index)
		key, stored, err := storeArtifactStream(f.owner, path, io.LimitReader(&fixtureFileReader{}, size))
		if err != nil {
			t.Fatal(err)
		}
		item, err := f.server.store.SaveArtifact(context.Background(), storage.Artifact{UserID: f.owner, Name: fmt.Sprintf("%d.png", index), Path: path, MIMEType: "image/png", Size: stored, StorageKey: key})
		if err != nil {
			t.Fatal(err)
		}
		attachments = append(attachments, item.Attachment())
	}
	if err := f.server.prepareAttachmentImages(context.Background(), f.owner, attachments); err != nil {
		t.Fatal(err)
	}
	for index, item := range attachments {
		if (item.DataURL != "") != (index < 4) || item.Path == "" {
			t.Fatal("image inline budget did not preserve path-only attachments", index)
		}
	}
}

func TestInvalidMultipartUploadRemovesStoredBytesAndMetadata(t *testing.T) {
	f := newCoreHTTPFixture(t)
	root := t.TempDir()
	t.Setenv("ARTIFACTS_ROOT", root)
	oversize := httptest.NewRequest(http.MethodPost, "/api/files", nil)
	oversize.Header.Set("Authorization", "Bearer "+f.token)
	oversize.ContentLength = filelimits.MaxFileBytes() + filelimits.MultipartOverheadBytes + 1
	rejected := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(rejected, oversize)
	if rejected.Code != http.StatusRequestEntityTooLarge {
		t.Fatal("known oversize request was read before rejection")
	}
	for _, duplicate := range []bool{false, true} {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, _ := form.CreateFormFile("file", "first.txt")
		_, _ = io.WriteString(part, "complete first file")
		if duplicate {
			part, _ = form.CreateFormFile("file", "second.txt")
			_, _ = io.WriteString(part, "second file")
			_ = form.Close()
		}
		request := httptest.NewRequest(http.MethodPost, "/api/files", bytes.NewReader(body.Bytes()))
		request.Header.Set("Authorization", "Bearer "+f.token)
		request.Header.Set("Content-Type", form.FormDataContentType())
		response := httptest.NewRecorder()
		f.server.Handler().ServeHTTP(response, request)
		if response.Code == http.StatusCreated {
			t.Fatal("incomplete/duplicate multipart request was accepted")
		}
	}
	items, err := f.server.store.ListArtifacts(context.Background(), f.owner)
	if err != nil || len(items) != 0 {
		t.Fatal("invalid multipart upload left metadata")
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if !entry.IsDir() {
			t.Fatal("invalid multipart upload left bytes", path)
		}
		return nil
	})
}

type diskFileBridge struct {
	jobFixtureTools
	root string
}

func (f *diskFileBridge) filePath(ctx context.Context, name string) string {
	scope, _ := agent.ScopeFromContext(ctx)
	environment := "desktop"
	if scope.ComputeOnly {
		environment = "compute"
	}
	return filepath.Join(f.root, environment, strings.TrimPrefix(name, "/"))
}

func (f *diskFileBridge) Bridge(ctx context.Context, _ string, method, route string, body []byte) (int, http.Header, []byte, error) {
	if method != http.MethodPost || route != "/publish" {
		return 0, nil, nil, errors.New("file transfer reached the in-memory bridge")
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return 0, nil, nil, err
	}
	path := f.filePath(ctx, input.Path)
	file, err := os.Open(path)
	if err != nil {
		return 0, nil, nil, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return 0, nil, nil, err
	}
	published := "/data/published/fixture/" + fmt.Sprintf("%x", hash.Sum(nil)[:10]) + "/" + filepath.Base(input.Path)
	target := f.filePath(ctx, published)
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return 0, nil, nil, err
	}
	if err := os.Link(path, target); err != nil && !errors.Is(err, os.ErrExist) {
		return 0, nil, nil, err
	}
	result, _ := json.Marshal(storage.Artifact{Path: published, Name: filepath.Base(input.Path), SourcePath: input.Path, MIMEType: "application/octet-stream", Size: size})
	return http.StatusCreated, nil, result, nil
}

func (f *diskFileBridge) BridgeStream(ctx context.Context, _ string, method, route string, body io.Reader, size int64) (int, http.Header, io.ReadCloser, error) {
	query, _ := url.Parse(route)
	path := f.filePath(ctx, query.Query().Get("path"))
	if method == http.MethodGet {
		file, err := os.Open(path)
		if err != nil {
			return 0, nil, nil, err
		}
		info, _ := file.Stat()
		return http.StatusOK, http.Header{"Content-Length": {strconv.FormatInt(info.Size(), 10)}}, file, nil
	}
	if method != http.MethodPut {
		return 0, nil, nil, errors.New("unexpected file method")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return 0, nil, nil, err
	}
	file, err := os.Create(path)
	if err != nil {
		return 0, nil, nil, err
	}
	copied, err := io.Copy(file, body)
	file.Close()
	if err == nil && copied != size {
		err = errors.New("file transfer size changed")
	}
	return http.StatusCreated, nil, io.NopCloser(strings.NewReader(`{"written":true}`)), err
}

func TestArtifactStagingPublicationAndEnvironmentCopyStreamLargeFiles(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	t.Setenv("TMPDIR", t.TempDir())
	const size = int64(40<<20 + 137)
	bridge := &diskFileBridge{root: t.TempDir()}
	f.server.SetTools(bridge)
	ctx := context.Background()
	if _, err := f.server.store.SetSessionComputer(ctx, f.owner, f.session.ID, true, false); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, CWD: f.session.WorkspacePath, ComputeOnly: true, ExecutionEnvironment: "compute"}
	key, _, err := storeArtifactStream(f.owner, "/data/files/uploads/fixture/large.bin", io.LimitReader(&fixtureFileReader{}, size))
	if err != nil {
		t.Fatal(err)
	}
	item := storage.Artifact{UserID: f.owner, Path: "/data/files/uploads/fixture/large.bin", Name: "large.bin", StorageKey: key, Size: size, MIMEType: "application/octet-stream"}
	if _, err := f.server.stageArtifact(ctx, scope, item, bridge); err != nil {
		t.Fatal("large attachment staging failed", err)
	}
	scoped := agent.WithRunScope(ctx, scope)
	published, err := f.server.publishArtifact(scoped, f.owner, f.session.ID, f.run.RunID, item.Path)
	if err != nil || published.Size != size || published.ID == "" {
		t.Fatal("large explicit publication failed", published, err)
	}
	for _, suffix := range []string{":computer", ":compute"} {
		f.server.preparedScopes.Store(scope.RunID+suffix, true)
	}
	result, err := f.server.copyWorkspaceFile(scoped, scope, json.RawMessage(`{"source_environment":"compute","source_path":"/data/files/uploads/fixture/large.bin","destination_environment":"desktop","destination_path":"/data/work/copied.bin"}`))
	if err != nil || !strings.Contains(result.Output, `"written":true`) {
		t.Fatal("large selected environment copy failed", result.Output, err)
	}
	destination := scope
	destination.ComputeOnly = false
	file, err := os.Open(bridge.filePath(agent.WithRunScope(ctx, destination), "/data/work/copied.bin"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hash := sha256.New()
	if copied, err := io.Copy(hash, file); err != nil || copied != size || !bytes.Equal(hash.Sum(nil), fixtureFileHash(size)) {
		t.Fatal("cross-environment file bytes changed")
	}
	temporaries, err := os.ReadDir(os.TempDir())
	if err != nil || len(temporaries) != 0 {
		t.Fatal("environment copy left temporary bytes", err)
	}
}
