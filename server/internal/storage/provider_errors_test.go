package storage

import (
	"errors"
	"strings"
	"testing"

	"ochi/server/internal/i18n"
)

func TestProviderDiagnosticPreservesCauseAndRedactsConfiguredSecrets(t *testing.T) {
	provider := Provider{APIKey: "fixture-api-secret", Headers: map[string]string{"X-Token": "fixture-header-secret"}}
	failure := i18n.WrapWith("image_provider_http_error", map[string]any{"status": 522},
		errors.New("HTTP 522 connection reset; key=fixture-api-secret; header=fixture-header-secret"))
	detail := SanitizeProviderError(provider, failure)
	if !strings.Contains(detail, "HTTP 522 connection reset") || !strings.Contains(detail, "[redacted]") {
		t.Fatal("the technical provider cause was erased")
	}
	if strings.Contains(detail, provider.APIKey) || strings.Contains(detail, provider.Headers["X-Token"]) {
		t.Fatal("a configured provider credential escaped in administrator diagnostics")
	}
	bounded := SanitizeProviderError(provider, errors.New(strings.Repeat("technical detail ", 1000)))
	if len(bounded) > 3000 {
		t.Fatal("administrator diagnostic is unbounded")
	}
}
