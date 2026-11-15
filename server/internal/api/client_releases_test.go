package api

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func testAPKManifest(packageID, versionName string, versionCode uint32, wide bool) []byte {
	texts := []string{"manifest", "package", packageID, "http://schemas.android.com/apk/res/android", "versionName", versionName, "versionCode"}
	return testAPKManifestWithTexts(texts, versionCode, wide)
}

func testAPKManifestWithTexts(texts []string, versionCode uint32, wide bool) []byte {
	pool := make([]byte, 28+len(texts)*4)
	binary.LittleEndian.PutUint16(pool, 1)
	binary.LittleEndian.PutUint16(pool[2:], 28)
	binary.LittleEndian.PutUint32(pool[8:], uint32(len(texts)))
	binary.LittleEndian.PutUint32(pool[20:], uint32(len(pool)))
	if !wide {
		binary.LittleEndian.PutUint32(pool[16:], 0x100)
	}
	stringsStart := len(pool)
	for i, text := range texts {
		binary.LittleEndian.PutUint32(pool[28+i*4:], uint32(len(pool)-stringsStart))
		units := utf16.Encode([]rune(text))
		if wide {
			if len(units) >= 0x8000 {
				pool = binary.LittleEndian.AppendUint16(pool, 0x8000|uint16(len(units)>>16))
			}
			pool = binary.LittleEndian.AppendUint16(pool, uint16(len(units)))
			for _, unit := range units {
				pool = binary.LittleEndian.AppendUint16(pool, unit)
			}
			pool = append(pool, 0, 0)
		} else {
			for _, length := range []int{len(units), len(text)} {
				if length >= 0x80 {
					pool = append(pool, 0x80|byte(length>>8))
				}
				pool = append(pool, byte(length))
			}
			pool = append(pool, []byte(text)...)
			pool = append(pool, 0)
		}
	}
	for len(pool)%4 != 0 {
		pool = append(pool, 0)
	}
	binary.LittleEndian.PutUint32(pool[4:], uint32(len(pool)))
	node := make([]byte, 36+3*20)
	binary.LittleEndian.PutUint16(node, 0x0102)
	binary.LittleEndian.PutUint16(node[2:], 16)
	binary.LittleEndian.PutUint32(node[4:], uint32(len(node)))
	binary.LittleEndian.PutUint32(node[16:], ^uint32(0))
	binary.LittleEndian.PutUint16(node[24:], 20)
	binary.LittleEndian.PutUint16(node[26:], 20)
	binary.LittleEndian.PutUint16(node[28:], 3)
	for i, field := range []struct {
		ns, name, value uint32
		kind            byte
	}{{^uint32(0), 1, 2, 3}, {3, 4, 5, 3}, {3, 6, versionCode, 0x10}} {
		attr := node[36+i*20:]
		binary.LittleEndian.PutUint32(attr, field.ns)
		binary.LittleEndian.PutUint32(attr[4:], field.name)
		binary.LittleEndian.PutUint32(attr[8:], ^uint32(0))
		binary.LittleEndian.PutUint16(attr[12:], 8)
		attr[15] = field.kind
		binary.LittleEndian.PutUint32(attr[16:], field.value)
	}
	result := make([]byte, 8)
	binary.LittleEndian.PutUint16(result, 3)
	binary.LittleEndian.PutUint16(result[2:], 8)
	binary.LittleEndian.PutUint32(result[4:], uint32(8+len(pool)+len(node)))
	result = append(result, pool...)
	return append(result, node...)
}

func appendTestAPKAttribute(data []byte, ns, name, value uint32, count int) []byte {
	nodeStart := 8 + int(binary.LittleEndian.Uint32(data[12:]))
	for i := 0; i < count; i++ {
		attr := make([]byte, 20)
		binary.LittleEndian.PutUint32(attr, ns)
		binary.LittleEndian.PutUint32(attr[4:], name)
		binary.LittleEndian.PutUint32(attr[8:], ^uint32(0))
		binary.LittleEndian.PutUint16(attr[12:], 8)
		attr[15] = 3
		binary.LittleEndian.PutUint32(attr[16:], value)
		data = append(data, attr...)
	}
	node := data[nodeStart:]
	binary.LittleEndian.PutUint16(node[28:], binary.LittleEndian.Uint16(node[28:])+uint16(count))
	binary.LittleEndian.PutUint32(node[4:], uint32(len(node)))
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)))
	return data
}

func testClientAPK(t *testing.T, code uint32, padding int64, packageID string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Ochi.apk")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	manifest, err := archive.Create("AndroidManifest.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = manifest.Write(testAPKManifest(packageID, "0.1.0", code, false))
	dex, err := archive.CreateHeader(&zip.FileHeader{Name: "classes.dex", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.CopyN(dex, infiniteZeros{}, padding); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

type infiniteZeros struct{}

func (infiniteZeros) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func uploadClientAPK(t *testing.T, f coreHTTPFixture, path, notes string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := os.CreateTemp(t.TempDir(), "multipart-*")
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", filepath.Base(path))
	source, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(part, source)
	source.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if err := writer.WriteField("release_notes", notes); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_, _ = body.Seek(0, io.SeekStart)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/client-releases/android", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+f.foreign)
	result := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(result, request)
	return result
}

func TestReadAPKVersion(t *testing.T) {
	for _, wide := range []bool{false, true} {
		version, err := readManifestVersion(testAPKManifest(androidPackageID, "1.2.3 测试", 42, wide))
		if err != nil || version.name != "1.2.3 测试" || version.code != 42 {
			t.Fatalf("wide=%v: %+v, %v", wide, version, err)
		}
	}
	for _, data := range [][]byte{
		nil,
		[]byte("<manifest/>"),
		testAPKManifest("example.wrong", "1.0", 1, false),
		testAPKManifest(androidPackageID, "1.0", 0, false),
		testAPKManifest(androidPackageID, "", 1, false),
	} {
		if _, err := readManifestVersion(data); err == nil {
			t.Fatal("accepted invalid release metadata")
		}
	}
	data := testAPKManifest(androidPackageID, "1.0", 1, false)
	binary.LittleEndian.PutUint32(data[12:], 0)
	if _, err := readManifestVersion(data); err == nil {
		t.Fatal("zero-sized chunk accepted")
	}
	data = testAPKManifest(androidPackageID, "1.0", 1, false)
	binary.LittleEndian.PutUint32(data[16:], ^uint32(0))
	if _, err := readManifestVersion(data); err == nil {
		t.Fatal("unbounded string count accepted")
	}
	path := testClientAPK(t, 42, 1024, androidPackageID)
	if version, err := readAPKVersion(path); err != nil || version.code != 42 {
		t.Fatalf("compiled APK: %+v, %v", version, err)
	}
}

func TestReadAPKManifestStringBudgets(t *testing.T) {
	large := strings.Repeat("x", 700000)
	for _, field := range []struct {
		name  string
		index int
	}{
		{"tag", 0},
		{"attribute_name", 1},
		{"package", 2},
		{"namespace", 3},
		{"version_name", 5},
	} {
		t.Run(field.name, func(t *testing.T) {
			texts := []string{"manifest", "package", androidPackageID, androidXMLNamespace, "versionName", "1.0", "versionCode"}
			texts[field.index] = large
			if _, err := readManifestVersion(testAPKManifestWithTexts(texts, 42, true)); err == nil {
				t.Fatal("oversized metadata string accepted")
			}
		})
	}
	for _, name := range []string{"split", "versionCode", "versionCodeMajor"} {
		t.Run(name, func(t *testing.T) {
			texts := []string{"manifest", "package", androidPackageID, androidXMLNamespace, "versionName", "1.0", "versionCode", name, large}
			data := testAPKManifestWithTexts(texts, 42, true)
			if name == "versionCode" {
				nodeStart := 8 + int(binary.LittleEndian.Uint32(data[12:]))
				attr := data[nodeStart+36+2*20:]
				attr[15] = 3
				binary.LittleEndian.PutUint32(attr[16:], 8)
			} else {
				ns := uint32(3)
				if name == "split" {
					ns = ^uint32(0)
				}
				data = appendTestAPKAttribute(data, ns, 7, 8, 1)
			}
			if _, err := readManifestVersion(data); err == nil {
				t.Fatal("oversized metadata value accepted")
			}
		})
	}

	texts := []string{"manifest", "package", androidPackageID, androidXMLNamespace, "versionName", "1.0", "versionCode", large}
	data := appendTestAPKAttribute(testAPKManifestWithTexts(texts, 42, true), ^uint32(0), 7, 5, 256)
	if _, err := readManifestVersion(data); err == nil {
		t.Fatal("repeated oversized attribute names accepted")
	}
	for _, wide := range []bool{false, true} {
		name := strings.Repeat("\U0001f680", maxAPKVersionNameRunes)
		version, err := readManifestVersion(testAPKManifest(androidPackageID, name, 42, wide))
		if err != nil || version.name != name {
			t.Fatalf("wide=%v: maximum Unicode version name rejected: %v", wide, err)
		}
		if _, err := readManifestVersion(testAPKManifest(androidPackageID, name+"x", 42, wide)); err == nil {
			t.Fatalf("wide=%v: overlong Unicode version name accepted", wide)
		}
	}
}

func TestReadAPKManifestSkipsUnrelatedValues(t *testing.T) {
	texts := []string{"manifest", "package", androidPackageID, androidXMLNamespace, "versionName", "1.0", "versionCode", "unrelated", strings.Repeat("x", 700000)}
	data := testAPKManifestWithTexts(texts, 42, true)
	data = appendTestAPKAttribute(data, 8, 7, 8, 256)
	data = appendTestAPKAttribute(data, 8, 4, 8, 256)
	version, err := readManifestVersion(data)
	if err != nil || version.name != "1.0" || version.code != 42 {
		t.Fatalf("irrelevant namespace/value changed release metadata: %+v, %v", version, err)
	}
}

func TestClientReleaseRoutesPublicationDownloadAndRemoval(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	t.Setenv("OCHI_MAX_FILE_BYTES", "67108864")
	for _, path := range []string{"/api/admin/client-releases", "/api/admin/client-releases/android", "/api/admin/client-releases/ios"} {
		method := http.MethodGet
		if strings.HasSuffix(path, "/android") {
			method = http.MethodDelete
		} else if strings.HasSuffix(path, "/ios") {
			method = http.MethodPut
		}
		f.request(t, "", method, path, "{}", http.StatusUnauthorized)
		f.request(t, f.token, method, path, "{}", http.StatusForbidden)
	}
	f.request(t, "", http.MethodGet, "/api/client-releases", "", http.StatusOK)
	path := testClientAPK(t, 20, 40<<20, androidPackageID)
	result := uploadClientAPK(t, f, path, "New build\n修复与改进")
	if result.Code != http.StatusOK {
		t.Fatalf("large APK upload: %d %s", result.Code, result.Body.String())
	}
	var catalog clientReleases
	if err := json.Unmarshal(result.Body.Bytes(), &catalog); err != nil || catalog.Android == nil {
		t.Fatalf("publication: %v", err)
	}
	first := catalog.Android
	if first.SizeBytes <= 32<<20 || first.VersionCode != 20 || first.VersionName != "0.1.0" || first.ReleaseNotes != "New build\n修复与改进" || first.PublishedAt.IsZero() {
		t.Fatalf("incomplete package metadata: %+v", first)
	}
	anonymous := f.request(t, "", http.MethodGet, "/api/client-releases", "", http.StatusOK)
	if !bytes.Equal(anonymous, result.Body.Bytes()) {
		t.Fatal("public/admin catalogs differ")
	}
	httpServer := httptest.NewServer(f.server.Handler())
	defer httpServer.Close()
	response, err := http.Get(httpServer.URL + first.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	size, err := io.Copy(hash, response.Body)
	response.Body.Close()
	if err != nil || size != first.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != first.SHA256 || response.StatusCode != http.StatusOK {
		t.Fatal("public streaming download was not the exact uploaded bytes")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, first.DownloadURL, nil)
		if method == http.MethodGet {
			request.Header.Set("Range", "bytes=4-11")
		}
		w := httptest.NewRecorder()
		f.server.Handler().ServeHTTP(w, request)
		if method == http.MethodGet && (w.Code != http.StatusPartialContent || w.Body.Len() != 8) ||
			method == http.MethodHead && (w.Code != http.StatusOK || w.Body.Len() != 0) ||
			w.Header().Get("ETag") != `"`+first.SHA256+`"` || w.Header().Get("Content-Type") != "application/vnd.android.package-archive" {
			t.Fatalf("download/range/HEAD: %s %d %v", method, w.Code, w.Header())
		}
	}
	f.request(t, f.foreign, http.MethodPut, "/api/admin/client-releases/ios", `{"url":"https://example.invalid/ochi"}`, http.StatusOK)
	invalid := testClientAPK(t, 21, 512, "example.wrong")
	if w := uploadClientAPK(t, f, invalid, ""); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"client_release_invalid_apk"`) {
		t.Fatal("wrong application ID accepted")
	}
	sameCode := testClientAPK(t, 20, 512, androidPackageID)
	if w := uploadClientAPK(t, f, sameCode, ""); w.Code != http.StatusConflict {
		t.Fatal("replacement without a new version code accepted")
	}
	var retained clientReleases
	_ = json.Unmarshal(f.request(t, "", http.MethodGet, "/api/client-releases", "", http.StatusOK), &retained)
	if retained.Android == nil || retained.Android.SHA256 != first.SHA256 || retained.IOS == nil {
		t.Fatal("failed publication replaced the current catalog")
	}
	next := testClientAPK(t, 21, 512, androidPackageID)
	if w := uploadClientAPK(t, f, next, ""); w.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(clientReleasePath(first.SHA256)); !os.IsNotExist(err) {
		t.Fatal("superseded package remained on disk")
	}
	f.request(t, "", http.MethodGet, first.DownloadURL, "", http.StatusNotFound)
	f.request(t, f.foreign, http.MethodDelete, "/api/admin/client-releases/android", "", http.StatusOK)
	var removed clientReleases
	_ = json.Unmarshal(f.request(t, "", http.MethodGet, "/api/client-releases", "", http.StatusOK), &removed)
	if removed.Android != nil || removed.IOS == nil || removed.IOS.URL != "https://example.invalid/ochi" {
		t.Fatal("unpublication changed the iOS link")
	}
	files, err := os.ReadDir(clientReleaseRoot())
	if err != nil || len(files) != 0 {
		t.Fatal("upload/replacement/removal leaked temporary or unpublished packages")
	}
}

func TestClientReleaseValidationAndTransferLimit(t *testing.T) {
	f := newCoreHTTPFixture(t)
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	for _, link := range []string{"http://example.invalid", "javascript:alert(1)", "https://u:p@example.invalid", "/relative", "https://", "https://example.invalid/" + strings.Repeat("a", 2048)} {
		f.request(t, f.foreign, http.MethodPut, "/api/admin/client-releases/ios", fmt.Sprintf(`{"url":%q}`, link), http.StatusBadRequest)
	}
	f.request(t, f.foreign, http.MethodPut, "/api/admin/client-releases/ios", `{"url":"https://testflight.apple.com/join/example"}`, http.StatusOK)
	f.request(t, f.foreign, http.MethodPut, "/api/admin/client-releases/ios", `{"url":""}`, http.StatusOK)
	if current, err := f.server.store.ClientReleases(context.Background()); err != nil || current.IOS != nil {
		t.Fatal("empty URL did not clear iOS")
	}
	path := testClientAPK(t, 25, 2048, androidPackageID)
	if w := uploadClientAPK(t, f, path, strings.Repeat("x", maxReleaseNotes+1)); w.Code != http.StatusBadRequest {
		t.Fatal("overlong notes accepted")
	}
	t.Setenv("OCHI_MAX_FILE_BYTES", "512")
	if w := uploadClientAPK(t, f, path, ""); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("configured cap: %d %s", w.Code, w.Body.String())
	}
	files, err := os.ReadDir(clientReleaseRoot())
	if err != nil || len(files) != 0 {
		t.Fatal("validation failure leaked partial package")
	}
}

func FuzzAPKManifest(f *testing.F) {
	f.Add(testAPKManifest(androidPackageID, "0.1.0", 42, false))
	f.Add(testAPKManifest(androidPackageID, "0.1.0", 42, true))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) <= 4<<20 {
			_, _ = readManifestVersion(data)
		}
	})
}
