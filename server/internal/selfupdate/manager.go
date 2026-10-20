package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

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
			return errors.New("更新下载重定向过多")
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
		m.state.UnsupportedReason = "应用内更新仅支持 Linux amd64 / arm64 发布包"
	case config.BuildType != "release" || !config.EmbeddedWeb:
		m.state.UnsupportedReason = "开发构建不支持应用内更新，请使用包含网页的正式发布镜像"
	case validateBuild(config.Current) != nil:
		m.state.UnsupportedReason = "当前构建缺少有效的发布身份"
	}
	if err := validateURL(m.manifestURL); err != nil {
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
		m.state.UnsupportedReason = "无法确定当前程序的文件路径"
	}
	// Keep the startup path: after replacement Linux may report the running inode
	// as .backup or (deleted), which must never become the next update target.
	m.targetPath = path
	m.state.Supported = m.state.UnsupportedReason == ""
	if m.state.Supported {
		if err := m.loadDisk(); err != nil {
			m.state.Supported = false
			m.state.UnsupportedReason = "更新状态无法读取，请检查部署文件：" + err.Error()
			m.state.Phase = "failed"
			m.state.Error = m.state.UnsupportedReason
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
	m.state.Phase, m.state.Error = "checking", ""
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
		m.state.Phase, m.state.Error = "failed", err.Error()
		m.manifest, m.state.Latest = nil, nil
		m.state.Available, m.state.BlockedReason = false, ""
		return m.snapshotLocked(), err
	}
	m.manifest, m.state.Latest = manifest, &manifest.Build
	m.state.Available = manifest.Revision != m.state.Current.Revision
	m.state.Phase, m.state.BlockedReason = "idle", ""
	if m.state.Available && manifest.SchemaSHA256 != m.state.Current.SchemaSHA256 {
		m.state.BlockedReason = "新构建包含数据库结构变更，需要人工维护后通过镜像部署，不能直接应用内更新"
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
		return m.snapshotLocked(), errors.New("请先检查更新，再选择已检查的构建")
	}
	if m.state.BlockedReason != "" {
		return m.snapshotLocked(), errors.New(m.state.BlockedReason)
	}
	manifest := *m.manifest
	asset := manifest.Assets[m.platform]
	m.state.Phase, m.state.Error = "downloading", ""
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
		m.state.Phase, m.state.Error = "failed", err.Error()
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
		return m.snapshotLocked(), errors.New("没有可回退的程序备份")
	}
	backup := *m.disk.Backup
	if backup.SchemaSHA256 != m.state.Current.SchemaSHA256 {
		return m.snapshotLocked(), errors.New("备份的数据库结构不同，不能直接回退程序")
	}
	path, err := copyBinary(m.backupPath(), filepath.Dir(m.targetPath))
	if err == nil {
		defer os.Remove(path)
		var digest string
		digest, err = fileSHA256(path)
		if err == nil && digest != backup.SHA256 {
			err = errors.New("程序备份校验失败，不能回退")
		}
	}
	if err == nil {
		err = m.install(path, backup)
	}
	if err != nil {
		m.state.Phase, m.state.Error = "failed", err.Error()
		return m.snapshotLocked(), err
	}
	m.state.Phase, m.state.Error = "ready", ""
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
		return nil, errors.New("更新清单读取失败或超出大小限制")
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, errors.New("更新清单格式无效")
	}
	if err := validateBuild(manifest.Build); err != nil {
		return nil, err
	}
	asset, ok := manifest.Assets[m.platform]
	if !ok {
		if m.platform != "linux_amd64" && m.platform != "linux_arm64" {
			return &manifest, nil
		}
		return nil, errors.New("更新清单没有当前平台的程序包")
	}
	if err := validateURL(asset.URL); err != nil {
		return nil, err
	}
	if !sha256Pattern.MatchString(asset.SHA256) || asset.Size <= 0 || asset.Size > maxArchiveSize {
		return nil, errors.New("更新程序包缺少有效的 SHA-256 或大小信息")
	}
	return &manifest, nil
}

func (m *Manager) get(ctx context.Context, target string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, errors.New("更新下载地址无效")
	}
	request.Header.Set("User-Agent", product.UserAgent())
	request.Header.Set("Accept-Encoding", "identity")
	response, err := m.client.Do(request)
	if err != nil {
		return nil, errors.New("无法连接更新源，请稍后重试")
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("更新源返回 HTTP %d", response.StatusCode)
	}
	return response, nil
}

func validateURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("更新源和程序包必须使用不含账号或片段的 HTTPS 地址")
	}
	return nil
}

func validateBuild(build Build) error {
	_, err := time.Parse(time.RFC3339, build.BuiltAt)
	if build.Version == "" || len(build.Version) > 80 || !revisionPattern.MatchString(build.Revision) || !sha256Pattern.MatchString(build.SchemaSHA256) || err != nil {
		return errors.New("更新清单的构建身份无效")
	}
	return nil
}
