package selfupdate

import (
	"net/http"
	"time"

	"ochi/server/internal/i18n"
)

const DefaultManifestURL = "https://github.com/xxxbrian/ochi/releases/download/edge/update.json"

var (
	ErrConflict    = i18n.New("update_conflict")
	ErrUnsupported = i18n.New("update_unsupported")
)

type Build struct {
	Version                 string `json:"version"`
	Revision                string `json:"revision"`
	BuiltAt                 string `json:"built_at"`
	SchemaSHA256            string `json:"schema_sha256"`
	WorkspaceContractSHA256 string `json:"workspace_contract_sha256"`
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
	Current               Build          `json:"current"`
	Latest                *Build         `json:"latest,omitempty"`
	Supported             bool           `json:"supported"`
	UnsupportedReason     string         `json:"unsupported_reason,omitempty"`
	UnsupportedReasonCode string         `json:"unsupported_reason_code,omitempty"`
	Available             bool           `json:"available"`
	BlockedReason         string         `json:"blocked_reason,omitempty"`
	BlockedReasonCode     string         `json:"blocked_reason_code,omitempty"`
	Phase                 string         `json:"phase"`
	DownloadedBytes       int64          `json:"downloaded_bytes"`
	TotalBytes            int64          `json:"total_bytes"`
	Pending               *Build         `json:"pending,omitempty"`
	Backup                *Build         `json:"backup,omitempty"`
	Error                 string         `json:"error,omitempty"`
	ErrorCode             string         `json:"error_code,omitempty"`
	ErrorParams           map[string]any `json:"error_params,omitempty"`
	CheckedAt             string         `json:"checked_at,omitempty"`
}

// Localized returns a presentation copy; the manager keeps locale-independent
// identities so changing interface language also updates an in-flight update.
func (s State) Localized(locale string) State {
	if s.UnsupportedReasonCode != "" {
		s.UnsupportedReason = i18n.Text(locale, s.UnsupportedReasonCode, nil)
	}
	if s.BlockedReasonCode != "" {
		s.BlockedReason = i18n.Text(locale, s.BlockedReasonCode, nil)
	}
	if s.ErrorCode != "" {
		s.Error = i18n.Text(locale, s.ErrorCode, s.ErrorParams)
	}
	return s
}

func (s *State) setError(err error) {
	s.Error, s.ErrorCode, s.ErrorParams = "", "", nil
	if err == nil {
		return
	}
	code, params, public := i18n.Details(err)
	if !public {
		code = "update_failed"
	}
	s.ErrorCode, s.ErrorParams = code, params
	s.Error = i18n.Text(i18n.English, code, params)
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
