// Package i18n owns public message identities and request language negotiation.
// Business code returns message codes; translation happens at the HTTP boundary.
package i18n

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/text/language"
)

const (
	English            = "en"
	SimplifiedChinese  = "zh-CN"
	TraditionalChinese = "zh-TW"
)

var matcher = language.NewMatcher([]language.Tag{language.English, language.SimplifiedChinese, language.TraditionalChinese})

//go:embed messages.json
var catalogJSON []byte
var catalog = loadCatalog()

type message struct {
	English     string `json:"en"`
	Simplified  string `json:"zh-CN"`
	Traditional string `json:"zh-TW"`
}

func loadCatalog() map[string]message {
	var values map[string]message
	if err := json.Unmarshal(catalogJSON, &values); err != nil {
		panic(err)
	}
	for code, value := range values {
		if code == "" || value.English == "" || value.Simplified == "" || value.Traditional == "" {
			panic("incomplete public message: " + code)
		}
	}
	return values
}

// Negotiate accepts weighted BCP 47 language ranges, including Hans/Hant and
// regional aliases, and falls back to English for unsupported/invalid ranges.
func Negotiate(header string) string {
	tags, _, err := language.ParseAcceptLanguage(header)
	if err != nil || len(tags) == 0 {
		return English
	}
	_, index, _ := matcher.Match(tags...)
	return []string{English, SimplifiedChinese, TraditionalChinese}[index]
}

func ValidPreference(value string) bool {
	return value == "system" || value == English || value == SimplifiedChinese || value == TraditionalChinese
}

// Error is a safe public failure. Its cause is available for internal diagnosis,
// but neither the cause nor arbitrary upstream text is part of the response.
type Error struct {
	Code   string
	Params map[string]any
	cause  error
}

func New(code string) *Error                         { return &Error{Code: code} }
func With(code string, params map[string]any) *Error { return &Error{Code: code, Params: params} }
func Wrap(code string, cause error) *Error           { return &Error{Code: code, cause: cause} }
func WrapWith(code string, params map[string]any, cause error) *Error {
	return &Error{Code: code, Params: params, cause: cause}
}
func (e *Error) Error() string { return Text(English, e.Code, e.Params) }
func (e *Error) Unwrap() error { return e.cause }

func Details(err error) (string, map[string]any, bool) {
	var public *Error
	if errors.As(err, &public) {
		_, known := catalog[public.Code]
		if known {
			return public.Code, public.Params, true
		}
	}
	return "", nil, false
}

func Text(locale, code string, params map[string]any) string {
	value, exists := catalog[code]
	if !exists {
		value = catalog["internal_error"]
	}
	text := value.English
	if locale == SimplifiedChinese {
		text = value.Simplified
	}
	if locale == TraditionalChinese {
		text = value.Traditional
	}
	// Replace complete named placeholders in a single pass: inserted values are
	// never parsed again, so user-supplied braces cannot alter other parameters.
	var result strings.Builder
	for len(text) > 0 {
		start := strings.IndexByte(text, '{')
		if start < 0 {
			result.WriteString(text)
			break
		}
		end := strings.IndexByte(text[start:], '}')
		if end < 0 {
			result.WriteString(text)
			break
		}
		end += start
		result.WriteString(text[:start])
		key := text[start+1 : end]
		if replacement, ok := params[key]; ok {
			result.WriteString(fmt.Sprint(replacement))
		} else {
			result.WriteString(text[start : end+1])
		}
		text = text[end+1:]
	}
	return result.String()
}
