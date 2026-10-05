package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"ochi/server/internal/product"
)

func checkProviderUserAgent(t *testing.T, r *http.Request, want string) {
	t.Helper()
	if got := r.Header.Get("User-Agent"); got != want {
		t.Errorf("User-Agent = %q, want %q", got, want)
	}
	values := r.Header.Values("User-Agent")
	if want == "" && len(values) != 0 || want != "" && len(values) != 1 {
		t.Errorf("wire User-Agent values = %q", values)
	}
}

func providerUserAgentCases() []struct {
	name, key, value string
} {
	return []struct{ name, key, value string }{
		{name: "default", value: product.UserAgent()},
		{name: "explicit-mixed-case", key: "uSeR-aGeNt", value: "PrivateRelay/2.0 (administrator)"},
		{name: "explicit-empty", key: "user-agent"},
	}
}

func TestModelRequestsUseProductUserAgentAndRespectExplicitHeaders(t *testing.T) {
	for _, operation := range []string{"chat", "responses", "auxiliary-chat", "auxiliary-responses", "embedding", "probe-chat", "probe-responses"} {
		t.Run(operation, func(t *testing.T) {
			for _, header := range providerUserAgentCases() {
				t.Run(header.name, func(t *testing.T) {
					protocol, path := "openai", "/chat/completions"
					if strings.Contains(operation, "responses") {
						protocol, path = "openai-responses", "/responses"
					} else if operation == "embedding" {
						path = "/embeddings"
					}
					var calls atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						checkProviderUserAgent(t, r, header.value)
						if r.URL.Path != path || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("X-Provider") != "private" {
							t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
						}
						switch operation {
						case "chat":
							writeChatAnswer(w, "done")
						case "responses":
							fmt.Fprint(w, "data: "+`{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}`+"\n\n")
						case "embedding":
							fmt.Fprint(w, `{"data":[{"index":0,"embedding":[0.1,0.2]}]}`)
						default:
							if protocol == "openai-responses" {
								fmt.Fprint(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}`)
							} else {
								fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
							}
						}
					}))
					defer server.Close()
					config := Config{BaseURL: server.URL, APIKey: "test-key", Model: "fixture", Protocol: protocol, Headers: map[string]string{"X-Provider": "private"}}
					if header.key != "" {
						config.Headers[header.key] = header.value
					}
					var err error
					switch operation {
					case "chat", "responses":
						var generator *OpenAI
						generator, err = NewOpenAI(config)
						if err == nil {
							err = generator.Generate(context.Background(), Request{}, func(Update) error { return nil })
						}
					case "embedding":
						_, err = Embed(context.Background(), config, []string{"test"})
					case "probe-chat", "probe-responses":
						err = TestCompletion(context.Background(), config)
					default:
						_, err = Complete(context.Background(), config, "system", "user", 256)
					}
					if err != nil || calls.Load() != 1 {
						t.Fatalf("request error=%v calls=%d", err, calls.Load())
					}
				})
			}
		})
	}
}

func TestModelRetryKeepsUserAgentPolicy(t *testing.T) {
	for _, header := range providerUserAgentCases() {
		t.Run(header.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				checkProviderUserAgent(t, r, header.value)
				if calls.Add(1) == 1 {
					w.WriteHeader(http.StatusServiceUnavailable)
					fmt.Fprint(w, `{"error":{"code":"server_error"}}`)
					return
				}
				writeChatAnswer(w, "done")
			}))
			defer server.Close()
			config := Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Headers: map[string]string{}}
			if header.key != "" {
				config.Headers[header.key] = header.value
			}
			generator, err := NewOpenAI(config)
			if err != nil {
				t.Fatal(err)
			}
			if err = generator.Generate(context.Background(), Request{}, func(Update) error { return nil }); err != nil || calls.Load() != 2 {
				t.Fatalf("retry error=%v calls=%d", err, calls.Load())
			}
		})
	}
}

func TestImageRequestsUseProductUserAgentAndRespectExplicitHeaders(t *testing.T) {
	data := imageTestPNG(t)
	for _, edit := range []bool{false, true} {
		t.Run(fmt.Sprintf("edit=%t", edit), func(t *testing.T) {
			for _, header := range providerUserAgentCases() {
				t.Run(header.name, func(t *testing.T) {
					var calls atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						checkProviderUserAgent(t, r, header.value)
						path := "/images/generations"
						if edit {
							path = "/images/edits"
						}
						if r.URL.Path != path || r.Method != http.MethodPost {
							t.Errorf("unexpected image request: %s %s", r.Method, r.URL.Path)
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
					}))
					defer server.Close()
					config := Config{BaseURL: server.URL, Model: "gpt-image-2", APIKey: "test-key", Headers: map[string]string{}}
					if header.key != "" {
						config.Headers[header.key] = header.value
					}
					options := ImageOptions{Prompt: "A bird"}
					if edit {
						options.Images = []ImageInput{{Data: data}}
					}
					if _, err := GenerateImage(context.Background(), config, options); err != nil || calls.Load() != 1 {
						t.Fatalf("image error=%v calls=%d", err, calls.Load())
					}
				})
			}
		})
	}
}

func TestGeneratedImageDownloadUsesProductUserAgentWithoutProviderHeaders(t *testing.T) {
	data := imageTestPNG(t)
	var downloads atomic.Int32
	imageHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads.Add(1)
		checkProviderUserAgent(t, r, product.UserAgent())
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Provider") != "" {
			t.Error("provider secrets reached image download host")
		}
		_, _ = w.Write(data)
	}))
	defer imageHost.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkProviderUserAgent(t, r, "PrivateRelay/2.0")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"url": imageHost.URL + "/signed-image"}}})
	}))
	defer provider.Close()
	config := Config{BaseURL: provider.URL, Model: "gpt-image-2", APIKey: "private-key", Headers: map[string]string{"X-Provider": "private-value", "user-agent": "PrivateRelay/2.0"}}
	result, err := GenerateImage(context.Background(), config, ImageOptions{Prompt: "A bird"})
	if err != nil || !bytes.Equal(result.Data, data) || downloads.Load() != 1 {
		t.Fatalf("image download error=%v calls=%d", err, downloads.Load())
	}
}
