package api

import (
	"bytes"
	"encoding/json"

	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
)

// Keep partial settings updates, but reject null or string values for the
// diagnostic switch rather than silently leaving the old value in place.
type adminSettingsPatch struct {
	*storage.Settings
	DebugMode json.RawMessage `json:"debug_mode"`
}

func (p adminSettingsPatch) applyDebugMode() error {
	if p.DebugMode == nil {
		return nil
	}
	switch string(bytes.TrimSpace(p.DebugMode)) {
	case "true":
		p.Settings.DebugMode = true
	case "false":
		p.Settings.DebugMode = false
	default:
		return i18n.New("debug_mode_invalid")
	}
	return nil
}
