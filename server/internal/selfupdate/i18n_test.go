package selfupdate

import (
	"errors"
	"strings"
	"testing"

	"ochi/server/internal/i18n"
)

func TestUpdateMessagesAreLocalizedCopiesAndClearTogether(t *testing.T) {
	state := State{
		UnsupportedReasonCode: "update_unsupported",
		UnsupportedReason:     i18n.Text("en", "update_unsupported", nil),
		BlockedReasonCode:     "update_schema_changed",
		BlockedReason:         i18n.Text("en", "update_schema_changed", nil),
	}
	state.setError(i18n.With("update_http_error", map[string]any{"status": 503}))
	for _, locale := range []string{"en", "zh-CN", "zh-TW"} {
		presented := state.Localized(locale)
		if presented.Error != i18n.Text(locale, "update_http_error", state.ErrorParams) ||
			presented.UnsupportedReason != i18n.Text(locale, "update_unsupported", nil) ||
			presented.BlockedReason != i18n.Text(locale, "update_schema_changed", nil) ||
			!strings.Contains(presented.Error, "503") {
			t.Fatal("an update response lost its locale or interpolation parameters")
		}
	}
	if state.Error != i18n.Text("en", "update_http_error", state.ErrorParams) {
		t.Fatal("presentation mutated the canonical update state")
	}
	manager := &Manager{state: state}
	snapshot := manager.State()
	snapshot.ErrorParams["status"] = 400
	if manager.State().ErrorParams["status"] != 503 {
		t.Fatal("a returned update response exposed mutable manager state")
	}
	state.setError(nil)
	if state.Error != "" || state.ErrorCode != "" || state.ErrorParams != nil {
		t.Fatal("successful update retained stale translated failure fields")
	}
	state.setError(errors.New("private filesystem path and operating system detail"))
	if state.ErrorCode != "update_failed" || strings.Contains(state.Error, "private") {
		t.Fatal("unknown update error exposed internal detail")
	}
}
