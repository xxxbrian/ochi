package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/product"
)

func fixtureBuild(revision string) Build {
	return Build{Version: "0.1.0", Revision: strings.Repeat(revision, 40), BuiltAt: "2026-01-01T00:00:00Z", SchemaSHA256: strings.Repeat("a", 64)}
}

func fixtureBinary(arch, marker string) []byte {
	header := elf.Header64{
		Ident: [elf.EI_NIDENT]byte{0x7f, 'E', 'L', 'F', byte(elf.ELFCLASS64), byte(elf.ELFDATA2LSB), byte(elf.EV_CURRENT)},
		Type:  uint16(elf.ET_EXEC), Machine: uint16(elf.EM_X86_64), Version: uint32(elf.EV_CURRENT), Ehsize: 64,
	}
	if arch == "arm64" {
		header.Machine = uint16(elf.EM_AARCH64)
	}
	var output bytes.Buffer
	_ = binary.Write(&output, binary.LittleEndian, header)
	output.WriteString(marker)
	return output.Bytes()
}

func fixtureArchive(t *testing.T, data []byte, name string, extra bool) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	archive := tar.NewWriter(gzipWriter)
	if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Typeflag: tar.TypeReg, Size: int64(len(data))}); err != nil {
		t.Fatal(err)
	}
	_, _ = archive.Write(data)
	if extra {
		_ = archive.WriteHeader(&tar.Header{Name: "unexpected", Mode: 0o644, Typeflag: tar.TypeReg})
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

type updateFixture struct {
	config   Config
	manager  *Manager
	manifest *Manifest
	server   *httptest.Server
	archive  []byte
	old      []byte
	next     []byte
}

func newUpdateFixture(t *testing.T, assetHandler http.HandlerFunc) *updateFixture {
	t.Helper()
	f := &updateFixture{old: fixtureBinary("amd64", "original"), next: fixtureBinary("amd64", "updated")}
	f.archive = fixtureArchive(t, f.next, "ochi-server", false)
	sum := sha256.Sum256(f.archive)
	f.manifest = &Manifest{Build: fixtureBuild("2"), Assets: map[string]Asset{}}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != product.UserAgent() {
			t.Errorf("unexpected User-Agent %q", r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/update.json":
			_ = json.NewEncoder(w).Encode(f.manifest)
		case "/asset.tar.gz":
			if assetHandler != nil {
				assetHandler(w, r)
				return
			}
			_, _ = w.Write(f.archive)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	f.manifest.Assets["linux_amd64"] = Asset{URL: f.server.URL + "/asset.tar.gz", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(f.archive))}
	target := filepath.Join(t.TempDir(), "ochi-server")
	if err := os.WriteFile(target, f.old, 0o755); err != nil {
		t.Fatal(err)
	}
	f.config = Config{Current: fixtureBuild("1"), BuildType: "release", EmbeddedWeb: true, TargetPath: target, ManifestURL: f.server.URL + "/update.json", GOOS: "linux", GOARCH: "amd64", Client: f.server.Client(), Restart: func() {}}
	f.manager = New(f.config)
	if !f.manager.State().Supported {
		t.Fatalf("fixture unsupported: %+v", f.manager.State())
	}
	return f
}

func waitForPhase(t *testing.T, manager *Manager, phases ...string) State {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state := manager.State()
		for _, phase := range phases {
			if state.Phase == phase {
				return state
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("update did not reach %v: %+v", phases, manager.State())
	return State{}
}

func requireFile(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("file %s: read error %v, got %q, want %q", filepath.Base(path), err, got, want)
	}
}

func TestUpdateInstallRestartAndRollback(t *testing.T) {
	f := newUpdateFixture(t, nil)
	if _, err := f.manager.Apply(f.manifest.Revision); err == nil {
		t.Fatal("apply did not require a checked manifest")
	}
	state, err := f.manager.Check(context.Background())
	if err != nil || !state.Available || state.Latest == nil || state.Latest.Revision != f.manifest.Revision || state.CheckedAt == "" {
		t.Fatalf("check: %+v %v", state, err)
	}
	state.Latest.Revision = "mutated snapshot"
	if f.manager.State().Latest.Revision != f.manifest.Revision {
		t.Fatal("state exposes mutable manager pointers")
	}
	if _, err := f.manager.Apply(f.manifest.Revision); err != nil {
		t.Fatal(err)
	}
	state = waitForPhase(t, f.manager, "ready", "failed")
	if state.Phase != "ready" || state.Pending == nil || *state.Pending != f.manifest.Build || state.Backup == nil || *state.Backup != f.config.Current {
		t.Fatalf("prepared state: %+v", state)
	}
	if state.Current != f.config.Current || state.DownloadedBytes != state.TotalBytes || state.TotalBytes != int64(len(f.archive)) {
		t.Fatalf("actual current identity or download count changed: %+v", state)
	}
	requireFile(t, f.config.TargetPath, f.next)
	requireFile(t, f.manager.backupPath(), f.old)
	if _, err := f.manager.Check(context.Background()); !errors.Is(err, ErrConflict) {
		t.Fatalf("check was allowed over pending update: %v", err)
	}
	var restarted atomic.Int32
	f.manager.restart = func() { restarted.Add(1) }
	if _, err := f.manager.PrepareRestart(); err != nil {
		t.Fatal(err)
	}
	if restarted.Load() != 0 {
		t.Fatal("preparing restart notified the process before HTTP response")
	}
	f.manager.TriggerRestart()
	f.manager.TriggerRestart()
	if restarted.Load() != 1 {
		t.Fatal("restart notification was not exactly once")
	}
	if _, err := f.manager.Rollback(); !errors.Is(err, ErrConflict) {
		t.Fatalf("rollback admitted during drain: %v", err)
	}
	f.config.Current = f.manifest.Build
	updated := New(f.config)
	state = updated.State()
	if !state.Supported || state.Phase != "idle" || state.Pending != nil || state.Backup == nil || *state.Backup != fixtureBuild("1") {
		t.Fatalf("startup confirmation: %+v", state)
	}
	state, err = updated.Rollback()
	if err != nil || state.Phase != "ready" || state.Pending == nil || *state.Pending != fixtureBuild("1") || state.Backup == nil || *state.Backup != fixtureBuild("2") {
		t.Fatalf("rollback preparation: %+v %v", state, err)
	}
	requireFile(t, f.config.TargetPath, f.old)
	requireFile(t, updated.backupPath(), f.next)
	f.config.Current = fixtureBuild("1")
	rolledBack := New(f.config).State()
	if !rolledBack.Supported || rolledBack.Phase != "idle" || rolledBack.Pending != nil || rolledBack.Current.Revision != fixtureBuild("1").Revision {
		t.Fatalf("rollback startup: %+v", rolledBack)
	}
}

func TestSchemaChangeBlocksApplyWithoutTouchingFiles(t *testing.T) {
	f := newUpdateFixture(t, nil)
	f.manifest.SchemaSHA256 = strings.Repeat("b", 64)
	state, err := f.manager.Check(context.Background())
	if err != nil || !state.Available || state.BlockedReason == "" {
		t.Fatalf("schema change not disclosed: %+v %v", state, err)
	}
	if _, err := f.manager.Apply(f.manifest.Revision); err == nil {
		t.Fatal("applied incompatible schema")
	}
	requireFile(t, f.config.TargetPath, f.old)
	if _, err := os.Stat(f.manager.statePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("schema mismatch wrote update metadata")
	}
}

func TestConcurrentUpdateAdmissionAndDetachedDownload(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	f := newUpdateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write(fixtureArchive(t, fixtureBinary("amd64", "updated"), "ochi-server", false))
	})
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := f.manager.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.Apply(f.manifest.Revision); err != nil {
		t.Fatal(err)
	}
	<-started
	cancel()
	var group sync.WaitGroup
	for range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := f.manager.Apply(f.manifest.Revision); !errors.Is(err, ErrConflict) {
				t.Errorf("second apply admitted: %v", err)
			}
			if _, err := f.manager.Check(context.Background()); !errors.Is(err, ErrConflict) {
				t.Errorf("check admitted during download: %v", err)
			}
			if _, err := f.manager.Rollback(); !errors.Is(err, ErrConflict) {
				t.Errorf("rollback admitted during download: %v", err)
			}
		}()
	}
	group.Wait()
	close(release)
	if state := waitForPhase(t, f.manager, "ready", "failed"); state.Phase != "ready" {
		t.Fatalf("request cancellation stopped detached download: %+v", state)
	}
}

func TestDownloadValidationLeavesOriginalUntouched(t *testing.T) {
	for _, test := range []string{"digest", "size", "truncated", "wrong-architecture", "not-elf", "path", "extra-file", "gzip-checksum"} {
		t.Run(test, func(t *testing.T) {
			f := newUpdateFixture(t, nil)
			asset := f.manifest.Assets["linux_amd64"]
			switch test {
			case "digest":
				asset.SHA256 = strings.Repeat("f", 64)
			case "size":
				asset.Size++
			case "truncated":
				f.archive = f.archive[:len(f.archive)/2]
			case "wrong-architecture":
				f.archive = fixtureArchive(t, fixtureBinary("arm64", "updated"), "ochi-server", false)
			case "not-elf":
				f.archive = fixtureArchive(t, []byte("not executable"), "ochi-server", false)
			case "path":
				f.archive = fixtureArchive(t, f.next, "../ochi-server", false)
			case "extra-file":
				f.archive = fixtureArchive(t, f.next, "ochi-server", true)
			case "gzip-checksum":
				f.archive[len(f.archive)-8] ^= 0xff
			}
			if test != "digest" && test != "size" && test != "truncated" {
				sum := sha256.Sum256(f.archive)
				asset.SHA256, asset.Size = hex.EncodeToString(sum[:]), int64(len(f.archive))
			}
			f.manifest.Assets["linux_amd64"] = asset
			if _, err := f.manager.Check(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := f.manager.Apply(f.manifest.Revision); err != nil {
				t.Fatal(err)
			}
			state := waitForPhase(t, f.manager, "ready", "failed")
			if state.Phase != "failed" || state.Error == "" || state.Pending != nil {
				t.Fatalf("invalid archive accepted: %+v", state)
			}
			requireFile(t, f.config.TargetPath, f.old)
			files, _ := os.ReadDir(filepath.Dir(f.config.TargetPath))
			if len(files) != 1 {
				t.Fatalf("failed download left temporary files: %v", files)
			}
		})
	}
}

func TestInvalidManifestIsRejected(t *testing.T) {
	for _, test := range []string{"revision", "date", "schema", "asset-http", "asset-user", "asset-hash", "asset-size", "asset-oversize", "missing-platform"} {
		t.Run(test, func(t *testing.T) {
			f := newUpdateFixture(t, nil)
			asset := f.manifest.Assets["linux_amd64"]
			switch test {
			case "revision":
				f.manifest.Revision = "edge"
			case "date":
				f.manifest.BuiltAt = "now"
			case "schema":
				f.manifest.SchemaSHA256 = "unknown"
			case "asset-http":
				asset.URL = "http://example.invalid/asset.tar.gz"
			case "asset-user":
				asset.URL = "https://secret@example.invalid/asset.tar.gz"
			case "asset-hash":
				asset.SHA256 = ""
			case "asset-size":
				asset.Size = 0
			case "asset-oversize":
				asset.Size = maxArchiveSize + 1
			case "missing-platform":
				delete(f.manifest.Assets, "linux_amd64")
			}
			if test != "missing-platform" {
				f.manifest.Assets["linux_amd64"] = asset
			}
			state, err := f.manager.Check(context.Background())
			if err == nil || state.Phase != "failed" || state.Available || state.Latest != nil {
				t.Fatalf("invalid manifest accepted: %+v %v", state, err)
			}
			requireFile(t, f.config.TargetPath, f.old)
		})
	}
}

func TestUnsupportedBuildsCannotMutateOrRestart(t *testing.T) {
	for _, test := range []string{"development", "unbundled", "darwin", "unknown-arch", "identity", "feed-http"} {
		t.Run(test, func(t *testing.T) {
			f := newUpdateFixture(t, nil)
			config := f.config
			switch test {
			case "development":
				config.BuildType = "development"
			case "unbundled":
				config.EmbeddedWeb = false
			case "darwin":
				config.GOOS = "darwin"
			case "unknown-arch":
				config.GOARCH = "386"
			case "identity":
				config.Current.Revision = "dev"
			case "feed-http":
				config.ManifestURL = "http://example.invalid/update.json"
			}
			manager := New(config)
			if state := manager.State(); state.Supported || state.UnsupportedReason == "" {
				t.Fatalf("unsupported state missing: %+v", state)
			}
			if _, err := manager.Apply(f.manifest.Revision); !errors.Is(err, ErrUnsupported) {
				t.Fatalf("unsupported apply: %v", err)
			}
			if _, err := manager.Rollback(); !errors.Is(err, ErrUnsupported) {
				t.Fatalf("unsupported rollback: %v", err)
			}
			if _, err := manager.PrepareRestart(); !errors.Is(err, ErrUnsupported) {
				t.Fatalf("unsupported restart: %v", err)
			}
			if test == "darwin" {
				if state, err := manager.Check(context.Background()); err != nil || state.Latest == nil {
					t.Fatalf("unsupported platform cannot inspect available build: %+v %v", state, err)
				}
			}
			requireFile(t, config.TargetPath, f.old)
		})
	}
}

func TestInstallFailureRestoresPreviousBackupAndMetadata(t *testing.T) {
	f := newUpdateFixture(t, nil)
	previous := fixtureBinary("amd64", "previous backup")
	_ = os.WriteFile(f.manager.backupPath(), previous, 0o755)
	digest := sha256.Sum256(previous)
	backup := binaryBuild{Build: fixtureBuild("0"), SHA256: hex.EncodeToString(digest[:])}
	f.manager.disk = diskState{Backup: &backup}
	if err := f.manager.saveDisk(f.manager.disk); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.install(filepath.Join(t.TempDir(), "missing-binary"), binaryBuild{Build: f.manifest.Build, SHA256: strings.Repeat("a", 64)}); err == nil {
		t.Fatal("installing a missing binary succeeded")
	}
	requireFile(t, f.config.TargetPath, f.old)
	requireFile(t, f.manager.backupPath(), previous)
	reloaded := New(f.config).State()
	if !reloaded.Supported || reloaded.Pending != nil || reloaded.Backup == nil || *reloaded.Backup != backup.Build {
		t.Fatalf("failure did not restore metadata: %+v", reloaded)
	}
}

func TestStartupDetectsInterruptedReplacementAndInvalidMetadata(t *testing.T) {
	f := newUpdateFixture(t, nil)
	digest := sha256.Sum256(f.old)
	state := diskState{
		Pending: &binaryBuild{Build: f.manifest.Build, SHA256: strings.Repeat("f", 64)},
		Backup:  &binaryBuild{Build: f.config.Current, SHA256: hex.EncodeToString(digest[:])},
	}
	if err := f.manager.saveDisk(state); err != nil {
		t.Fatal(err)
	}
	manager := New(f.config)
	if state := manager.State(); !state.Supported || state.Phase != "failed" || state.Pending != nil || state.Backup != nil || state.Error == "" {
		t.Fatalf("interrupted atomic rename not recovered: %+v", state)
	}
	if _, err := manager.Check(context.Background()); err != nil {
		t.Fatal("recovery must allow another check")
	}
	_ = os.WriteFile(manager.statePath(), []byte(`{"pending":`), 0o600)
	if state := New(f.config).State(); state.Supported || state.Phase != "failed" || state.UnsupportedReason == "" {
		t.Fatalf("corrupt update metadata was ignored: %+v", state)
	}
}

func TestStartupDiscardsUnavailableBackupAfterCurrentIsConfirmed(t *testing.T) {
	for _, pending := range []bool{false, true} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("pending=%t/missing=%t", pending, missing), func(t *testing.T) {
				f := newUpdateFixture(t, nil)
				previous := fixtureBinary("amd64", "previous backup")
				previousDigest := sha256.Sum256(previous)
				state := diskState{Backup: &binaryBuild{Build: fixtureBuild("0"), SHA256: hex.EncodeToString(previousDigest[:])}}
				if pending {
					currentDigest := sha256.Sum256(f.old)
					state.Pending = &binaryBuild{Build: f.config.Current, SHA256: hex.EncodeToString(currentDigest[:])}
				}
				if err := f.manager.saveDisk(state); err != nil {
					t.Fatal(err)
				}
				if !missing {
					// Simulate replacement of the old backup before install saved its
					// new metadata; the actual running program was never replaced.
					if err := os.WriteFile(f.manager.backupPath(), f.old, 0o755); err != nil {
						t.Fatal(err)
					}
				}
				manager := New(f.config)
				recovered := manager.State()
				if !recovered.Supported || recovered.UnsupportedReason != "" || recovered.Phase != "failed" || recovered.Error == "" || recovered.Pending != nil || recovered.Backup != nil {
					t.Fatalf("unavailable backup blocked current program: %+v", recovered)
				}
				requireFile(t, f.config.TargetPath, f.old)
				if state := New(f.config).State(); !state.Supported || state.Pending != nil || state.Backup != nil || state.Phase != "idle" {
					t.Fatalf("backup cleanup was not persisted: %+v", state)
				}
				if _, err := manager.Check(context.Background()); err != nil {
					t.Fatal(err)
				}
				if _, err := manager.Apply(f.manifest.Revision); err != nil {
					t.Fatal(err)
				}
				if state := waitForPhase(t, manager, "ready", "failed"); state.Phase != "ready" {
					t.Fatalf("recovery did not allow another update: %+v", state)
				}
			})
		}
	}
}

func TestUnavailableBackupDoesNotBypassPendingIdentityMismatch(t *testing.T) {
	f := newUpdateFixture(t, nil)
	state := diskState{
		Pending: &binaryBuild{Build: fixtureBuild("2"), SHA256: strings.Repeat("e", 64)},
		Backup:  &binaryBuild{Build: fixtureBuild("0"), SHA256: strings.Repeat("f", 64)},
	}
	if err := f.manager.saveDisk(state); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(f.manager.statePath())
	if err != nil {
		t.Fatal(err)
	}
	manager := New(f.config)
	if state := manager.State(); state.Supported || state.UnsupportedReason == "" || state.Pending == nil || state.Backup == nil {
		t.Fatalf("pending mismatch was guessed away: %+v", state)
	}
	requireFile(t, f.manager.statePath(), before)
	requireFile(t, f.config.TargetPath, f.old)
	if _, err := manager.Apply(f.manifest.Revision); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("pending mismatch allowed update: %v", err)
	}
}

func TestShutdownPreventsInFlightDownloadFromReplacingBinary(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	f := newUpdateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write(fixtureArchive(t, fixtureBinary("amd64", "updated"), "ochi-server", false))
	})
	_, _ = f.manager.Check(context.Background())
	done := make(chan struct{})
	f.manager.state.Phase = "downloading"
	go func() {
		f.manager.apply(f.manifest.Build, f.manifest.Assets["linux_amd64"])
		close(done)
	}()
	<-started
	f.manager.StopAdmission()
	close(release)
	<-done
	for _, operation := range []func() (State, error){
		func() (State, error) { return f.manager.Check(context.Background()) },
		func() (State, error) { return f.manager.Apply(f.manifest.Revision) },
		f.manager.Rollback, f.manager.PrepareRestart,
	} {
		if _, err := operation(); !errors.Is(err, ErrConflict) {
			t.Fatalf("operation admitted during shutdown: %v", err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(filepath.Dir(f.config.TargetPath), ".ochi-*"))
	if len(files) != 0 {
		t.Fatalf("shutdown download left temporary files: %v", files)
	}
	requireFile(t, f.config.TargetPath, f.old)
	if state := f.manager.State(); state.Phase != "restarting" || state.Pending != nil {
		t.Fatalf("download overrode shutdown state: %+v", state)
	}
}

func TestHTTPRedirectMustStayHTTPS(t *testing.T) {
	f := newUpdateFixture(t, nil)
	httpSource := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("updater followed an insecure redirect")
	}))
	defer httpSource.Close()
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, httpSource.URL, http.StatusFound)
	}))
	defer redirect.Close()
	f.config.ManifestURL, f.config.Client = redirect.URL, redirect.Client()
	if state, err := New(f.config).Check(context.Background()); err == nil || state.Phase != "failed" {
		t.Fatalf("insecure redirect accepted: %+v %v", state, err)
	}
}

func ExampleManifest() {
	manifest := Manifest{Build: fixtureBuild("1"), Assets: map[string]Asset{"linux_amd64": {URL: "https://example.invalid/ochi.tar.gz", SHA256: strings.Repeat("a", 64), Size: 123}}}
	data, _ := json.Marshal(manifest)
	fmt.Println(strings.Contains(string(data), `"revision":`), strings.Contains(string(data), `"assets":`))
	// Output: true true
}
