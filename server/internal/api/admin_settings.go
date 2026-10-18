package api

import (
	"bytes"
	"encoding/json"
	"errors"

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
		return errors.New("debug_mode must be a boolean")
	}
	return nil
}
