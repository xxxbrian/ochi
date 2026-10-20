package selfupdate

import (
	"errors"
	"net/http"
	"time"
)

const DefaultManifestURL = "https://github.com/xxxbrian/ochi/releases/download/edge/update.json"

var (
	ErrConflict    = errors.New("更新操作正在进行，或有等待重启的版本")
	ErrUnsupported = errors.New("当前部署不支持应用内更新")
)

type Build struct {
	Version      string `json:"version"`
	Revision     string `json:"revision"`
	BuiltAt      string `json:"built_at"`
	SchemaSHA256 string `json:"schema_sha256"`
}

type Asset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type Manifest struct {
	Build
	Assets map[string]Asset `json:"assets"`
}

type State struct {
	Current           Build  `json:"current"`
	Latest            *Build `json:"latest,omitempty"`
	Supported         bool   `json:"supported"`
	UnsupportedReason string `json:"unsupported_reason,omitempty"`
	Available         bool   `json:"available"`
	BlockedReason     string `json:"blocked_reason,omitempty"`
	Phase             string `json:"phase"`
	DownloadedBytes   int64  `json:"downloaded_bytes"`
	TotalBytes        int64  `json:"total_bytes"`
	Pending           *Build `json:"pending,omitempty"`
	Backup            *Build `json:"backup,omitempty"`
	Error             string `json:"error,omitempty"`
	CheckedAt         string `json:"checked_at,omitempty"`
}

type Config struct {
	Current     Build
	BuildType   string
	EmbeddedWeb bool
	ManifestURL string
	TargetPath  string
	GOOS        string
	GOARCH      string
	Client      *http.Client
	Restart     func()
	Now         func() time.Time
}

type binaryBuild struct {
	Build
	SHA256 string `json:"binary_sha256"`
}

type diskState struct {
	Pending *binaryBuild `json:"pending,omitempty"`
	Backup  *binaryBuild `json:"backup,omitempty"`
}
