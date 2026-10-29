package i18n

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

func TestNegotiateLanguage(t *testing.T) {
	for _, test := range []struct {
		header string
		want   string
	}{
		{"", English},
		{"en-US,en;q=0.8", English},
		{"zh", SimplifiedChinese},
		{"zh-CN", SimplifiedChinese},
		{"zh-SG", SimplifiedChinese},
		{"zh-Hans", SimplifiedChinese},
		{"zh-Hans-TW", SimplifiedChinese},
		{"zh-TW", TraditionalChinese},
		{"zh-HK", TraditionalChinese},
		{"zh-MO", TraditionalChinese},
		{"zh-Hant", TraditionalChinese},
		{"zh-Hant-CN", TraditionalChinese},
		{"en;q=0.5,zh-Hant;q=0.9", TraditionalChinese},
		{"fr;q=1,zh-TW;q=0.8,en;q=0.2", TraditionalChinese},
		{"zh-CN;q=0,zh-TW;q=0.5,en;q=0.4", TraditionalChinese},
		{"fr-FR,ja;q=0.5", English},
		{"*", English},
		{"not a language;q=oops", English},
	} {
		t.Run(test.header, func(t *testing.T) {
			if got := Negotiate(test.header); got != test.want {
				t.Fatalf("Negotiate(%q) = %s, want %s", test.header, got, test.want)
			}
		})
	}
}

func TestPreferencesUseCanonicalLanguageValues(t *testing.T) {
	for _, value := range []string{"system", English, SimplifiedChinese, TraditionalChinese} {
		if !ValidPreference(value) {
			t.Fatalf("canonical language %q rejected", value)
		}
	}
	for _, value := range []string{"", "zh", "zh-Hant", "EN", "fr", " zh-CN"} {
		if ValidPreference(value) {
			t.Fatalf("non-canonical language %q accepted", value)
		}
	}
}

func TestCatalogHasEqualPlaceholders(t *testing.T) {
	key := regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	placeholder := regexp.MustCompile(`\{[a-z][a-z0-9_]*\}`)
	for code, value := range catalog {
		if !key.MatchString(code) {
			t.Errorf("message identity %q is not canonical", code)
		}
		want := placeholder.FindAllString(value.English, -1)
		slices.Sort(want)
		for _, translated := range []string{value.Simplified, value.Traditional} {
			got := placeholder.FindAllString(translated, -1)
			slices.Sort(got)
			if !slices.Equal(got, want) {
				t.Errorf("message %s has inconsistent translated placeholders", code)
			}
		}
	}
}

func TestPublicErrorIdentityAndSafeInterpolation(t *testing.T) {
	cause := errors.New("private upstream credential and response body")
	err := fmt.Errorf("operation: %w", Wrap("provider_request_failed", cause))
	code, params, ok := Details(err)
	if !ok || code != "provider_request_failed" || params != nil || !errors.Is(err, cause) {
		t.Fatal("public identity or private diagnostic cause was lost")
	}
	if got := Wrap("provider_request_failed", cause).Error(); got != Text(English, code, nil) {
		t.Fatal("private cause escaped into the public error string")
	}
	if got := Text(TraditionalChinese, "provider_model_list_rejected", map[string]any{"status": "{status}"}); got != "服務拒絕了模型清單請求（HTTP {status}）。" {
		t.Fatalf("inserted placeholders were reparsed: %s", got)
	}
	if got := Text(English, "provider_model_list_rejected", map[string]any{"status": 503}); got != "The provider rejected the model list request (HTTP 503)." {
		t.Fatalf("typed interpolation failed: %s", got)
	}
	if code, _, ok := Details(New("missing_catalog_key")); ok || code != "" {
		t.Fatal("unknown code became a public error identity")
	}
	if got := Text(TraditionalChinese, "missing_catalog_key", nil); got != Text(TraditionalChinese, "internal_error", nil) {
		t.Fatal("unknown message did not use the safe translated fallback")
	}
}

func TestPublicErrorSourceUsesKnownCodes(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Dir(filepath.Dir(source))
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			index := 0
			if pkg.Name == "i18n" && selector.Sel.Name == "Text" {
				index = 1
			}
			if len(call.Args) <= index {
				return true
			}
			literal, ok := call.Args[index].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, err := strconv.Unquote(literal.Value)
			if err != nil {
				return true
			}
			if pkg.Name == "i18n" && slices.Contains([]string{"New", "With", "Wrap", "WrapWith", "Text"}, selector.Sel.Name) {
				if _, exists := catalog[value]; !exists {
					t.Errorf("%s: unknown public message code %s", path, value)
				}
			}
			if (pkg.Name == "errors" && selector.Sel.Name == "New") || (pkg.Name == "fmt" && selector.Sel.Name == "Errorf") {
				if strings.ContainsFunc(value, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
					t.Errorf("%s: human Chinese error message must use a stable public code", path)
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
