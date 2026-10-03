package product

import (
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestUserAgentIdentifiesProductAndActualRuntime(t *testing.T) {
	ua := UserAgent()
	want := "Ochi/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + "; " + runtime.Version() + ")"
	if ua != want {
		t.Fatalf("User-Agent = %q, want %q", ua, want)
	}
	// RFC 9110 uses a product/version token followed by an optional comment.
	if !regexp.MustCompile("^Ochi/[!#$%&'*+.^_`|~0-9A-Za-z-]+ \\([^\\r\\n]+\\)$").MatchString(ua) || strings.ContainsAny(Version, " /()") {
		t.Fatalf("User-Agent is not a product/version and comment: %q", ua)
	}
}
