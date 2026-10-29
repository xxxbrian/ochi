package selfupdate

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"ochi/server/internal/i18n"
	"ochi/server/internal/product"
)

var (
	revisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
	sha256Pattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

const (
	maxArchiveSize = 512 << 20
	maxBinarySize  = 1 << 30
)

type Manager struct {
	mu          sync.Mutex
	state       State
	manifest    *Manifest
	disk        diskState
	targetPath  string
	manifestURL string
	platform    string
	arch        string
	client      *http.Client
	restart     func()
	restartSent bool
	stopping    bool
	now         func() time.Time
}

func New(config Config) *Manager {
	if config.GOOS == "" {
		config.GOOS = runtime.GOOS
	}
	if config.GOARCH == "" {
		config.GOARCH = runtime.GOARCH
	}
	if config.ManifestURL == "" {
		config.ManifestURL = DefaultManifestURL
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	if config.Client != nil {
		*client = *config.Client
	}
	previousRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := validateURL(req.URL.String()); err != nil {
			return err
		}
		if len(via) >= 10 {
			return i18n.New("update_redirect_limit")
		}
		if previousRedirect != nil {
			return previousRedirect(req, via)
		}
		return nil
	}
	m := &Manager{
		state:       State{Current: config.Current, Phase: "idle"},
		manifestURL: config.ManifestURL, platform: config.GOOS + "_" + config.GOARCH,
		arch: config.GOARCH, client: client, restart: config.Restart, now: config.Now,
	}
	switch {
	case config.GOOS != "linux" || (config.GOARCH != "amd64" && config.GOARCH != "arm64"):
		m.state.UnsupportedReasonCode = "update_platform_unsupported"
		m.state.UnsupportedReason = i18n.New("update_platform_unsupported").Error()
	case config.BuildType != "release" || !config.EmbeddedWeb:
		m.state.UnsupportedReasonCode = "update_development_build"
		m.state.UnsupportedReason = i18n.New("update_development_build").Error()
	case validateBuild(config.Current) != nil:
		m.state.UnsupportedReasonCode = "update_identity_missing"
		m.state.UnsupportedReason = i18n.New("update_identity_missing").Error()
	}
	if err := validateURL(m.manifestURL); err != nil {
		m.state.UnsupportedReasonCode, _, _ = i18n.Details(err)
		m.state.UnsupportedReason = err.Error()
	}
	path := config.TargetPath
	var err error
	if path == "" {
		path, err = os.Executable()
	}
	if err == nil {
		path, err = filepath.Abs(path)
	}
	if err == nil {
		path, err = filepath.EvalSymlinks(path)
	}
	if err != nil {
		m.state.UnsupportedReasonCode = "update_path_unavailable"
		m.state.UnsupportedReason = i18n.New("update_path_unavailable").Error()
	}
	// Keep the startup path: after replacement Linux may report the running inode
	// as .backup or (deleted), which must never become the next update target.
	m.targetPath = path
	m.state.Supported = m.state.UnsupportedReason == ""
	if m.state.Supported {
		if err := m.loadDisk(); err != nil {
			m.state.Supported = false
			m.state.UnsupportedReasonCode = "update_state_unreadable"
			m.state.UnsupportedReason = i18n.New("update_state_unreadable").Error()
			m.state.Phase = "failed"
			m.state.setError(i18n.New("update_state_unreadable"))
		}
	}
	return m
}

func (m *Manager) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) snapshotLocked() State {
	state := m.state
	state.Current = m.state.Current
	state.ErrorParams = maps.Clone(m.state.ErrorParams)
	if m.state.Latest != nil {
		copy := *m.state.Latest
		state.Latest = &copy
	}
	state.Pending, state.Backup = nil, nil
	if m.disk.Pending != nil {
		copy := m.disk.Pending.Build
		state.Pending = &copy
	}
	if m.disk.Backup != nil {
		copy := m.disk.Backup.Build
		state.Backup = &copy
	}
	return state
}

func (m *Manager) busyLocked() bool {
	return m.stopping || m.state.Phase == "checking" || m.state.Phase == "downloading" || m.state.Phase == "restarting" || m.disk.Pending != nil
}

func (m *Manager) Check(ctx context.Context) (State, error) {
	m.mu.Lock()
	if m.busyLocked() {
		state := m.snapshotLocked()
		m.mu.Unlock()
		return state, ErrConflict
	}
	m.state.Phase = "checking"
	m.state.setError(nil)
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	manifest, err := m.fetchManifest(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return m.snapshotLocked(), ErrConflict
	}
	m.state.CheckedAt = m.now().UTC().Format(time.RFC3339)
	if err != nil {
		m.state.Phase = "failed"
		m.state.setError(err)
		m.manifest, m.state.Latest = nil, nil
		m.state.Available, m.state.BlockedReason, m.state.BlockedReasonCode = false, "", ""
		return m.snapshotLocked(), err
	}
	m.manifest, m.state.Latest = manifest, &manifest.Build
	m.state.Available = manifest.Revision != m.state.Current.Revision
	m.state.Phase, m.state.BlockedReason, m.state.BlockedReasonCode = "idle", "", ""
	if m.state.Available && manifest.SchemaSHA256 != m.state.Current.SchemaSHA256 {
		m.state.BlockedReasonCode = "update_schema_changed"
		m.state.BlockedReason = i18n.New("update_schema_changed").Error()
	} else if m.state.Available && manifest.WorkspaceContractSHA256 != m.state.Current.WorkspaceContractSHA256 {
		m.state.BlockedReasonCode = "update_workspace_contract_changed"
		m.state.BlockedReason = i18n.New("update_workspace_contract_changed").Error()
	}
	return m.snapshotLocked(), nil
}

func (m *Manager) Apply(revision string) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.state.Supported {
		return m.snapshotLocked(), ErrUnsupported
	}
	if m.busyLocked() {
		return m.snapshotLocked(), ErrConflict
	}
	if m.manifest == nil || !m.state.Available || revision != m.manifest.Revision {
		return m.snapshotLocked(), i18n.New("update_choose_build")
	}
	if m.state.BlockedReason != "" {
		return m.snapshotLocked(), i18n.New(m.state.BlockedReasonCode)
	}
	manifest := *m.manifest
	asset := manifest.Assets[m.platform]
	m.state.Phase = "downloading"
	m.state.setError(nil)
	m.state.DownloadedBytes, m.state.TotalBytes = 0, asset.Size
	go m.apply(manifest.Build, asset)
	return m.snapshotLocked(), nil
}

func (m *Manager) apply(build Build, asset Asset) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	path, digest, err := m.download(ctx, asset)
	if path != "" {
		defer os.Remove(path)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return
	}
	if err == nil {
		err = m.install(path, binaryBuild{Build: build, SHA256: digest})
	}
	if err != nil {
		m.state.Phase = "failed"
		m.state.setError(err)
		return
	}
	m.state.Phase = "ready"
}

func (m *Manager) Rollback() (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.state.Supported {
		return m.snapshotLocked(), ErrUnsupported
	}
	if m.busyLocked() {
		return m.snapshotLocked(), ErrConflict
	}
	if m.disk.Backup == nil {
		return m.snapshotLocked(), i18n.New("update_backup_missing")
	}
	backup := *m.disk.Backup
	if backup.SchemaSHA256 != m.state.Current.SchemaSHA256 {
		return m.snapshotLocked(), i18n.New("update_backup_schema_changed")
	}
	if backup.WorkspaceContractSHA256 != m.state.Current.WorkspaceContractSHA256 {
		return m.snapshotLocked(), i18n.New("update_backup_workspace_contract_changed")
	}
	path, err := copyBinary(m.backupPath(), filepath.Dir(m.targetPath))
	if err == nil {
		defer os.Remove(path)
		var digest string
		digest, err = fileSHA256(path)
		if err == nil && digest != backup.SHA256 {
			err = i18n.New("update_backup_invalid")
		}
	}
	if err == nil {
		err = m.install(path, backup)
	}
	if err != nil {
		m.state.Phase = "failed"
		m.state.setError(err)
		return m.snapshotLocked(), err
	}
	m.state.Phase = "ready"
	m.state.setError(nil)
	return m.snapshotLocked(), nil
}

func (m *Manager) PrepareRestart() (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.state.Supported || m.restart == nil {
		return m.snapshotLocked(), ErrUnsupported
	}
	if m.stopping || m.state.Phase != "ready" || m.disk.Pending == nil {
		return m.snapshotLocked(), ErrConflict
	}
	m.state.Phase = "restarting"
	m.stopping = true
	return m.snapshotLocked(), nil
}

// TriggerRestart is called only after the accepted HTTP response is flushed.
func (m *Manager) TriggerRestart() {
	m.mu.Lock()
	restart := m.restart
	ready := m.state.Phase == "restarting" && !m.restartSent
	if ready {
		m.restartSent = true
	}
	m.mu.Unlock()
	if ready && restart != nil {
		restart()
	}
}

// StopAdmission keeps update mutations out of the process shutdown/drain window.
func (m *Manager) StopAdmission() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopping = true
	m.state.Phase = "restarting"
}

func (m *Manager) fetchManifest(ctx context.Context) (*Manifest, error) {
	if err := validateURL(m.manifestURL); err != nil {
		return nil, err
	}
	response, err := m.get(ctx, m.manifestURL)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, i18n.New("update_manifest_read_failed")
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, i18n.New("update_manifest_invalid")
	}
	if err := validateBuild(manifest.Build); err != nil {
		return nil, err
	}
	asset, ok := manifest.Assets[m.platform]
	if !ok {
		if m.platform != "linux_amd64" && m.platform != "linux_arm64" {
			return &manifest, nil
		}
		return nil, i18n.New("update_asset_missing")
	}
	if err := validateURL(asset.URL); err != nil {
		return nil, err
	}
	if !sha256Pattern.MatchString(asset.SHA256) || asset.Size <= 0 || asset.Size > maxArchiveSize {
		return nil, i18n.New("update_asset_metadata_invalid")
	}
	return &manifest, nil
}

func (m *Manager) get(ctx context.Context, target string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, i18n.New("update_url_invalid")
	}
	request.Header.Set("User-Agent", product.UserAgent())
	request.Header.Set("Accept-Encoding", "identity")
	response, err := m.client.Do(request)
	if err != nil {
		return nil, i18n.New("update_connection_failed")
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, i18n.With("update_http_error", map[string]any{"status": response.StatusCode})
	}
	return response, nil
}

func validateURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return i18n.New("update_https_required")
	}
	return nil
}

func validateBuild(build Build) error {
	_, err := time.Parse(time.RFC3339, build.BuiltAt)
	if build.Version == "" || len(build.Version) > 80 || !revisionPattern.MatchString(build.Revision) ||
		!sha256Pattern.MatchString(build.SchemaSHA256) || !sha256Pattern.MatchString(build.WorkspaceContractSHA256) || err != nil {
		return i18n.New("update_build_invalid")
	}
	return nil
}
