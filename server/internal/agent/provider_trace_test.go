package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type traceRecorder struct {
	mu     sync.Mutex
	traces []ProviderTrace
}

func (r *traceRecorder) observe(trace ProviderTrace) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.traces = append(r.traces, trace)
}

func (r *traceRecorder) all() []ProviderTrace {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ProviderTrace(nil), r.traces...)
}

func (r *traceRecorder) one(t *testing.T) ProviderTrace {
	t.Helper()
	traces := r.all()
	if len(traces) != 1 {
		t.Fatalf("got %d provider traces, want exactly one", len(traces))
	}
	return traces[0]
}

func traceTestConfig(location string, recorder *traceRecorder) Config {
	return Config{BaseURL: location, APIKey: "sk-debug-test-credential", Model: "trace-model", ProviderID: "provider-id", ModelID: "model-id", DebugEnabled: func() bool { return true }, ObserveProvider: recorder.observe}
}

func traceTestRunner(t *testing.T, config Config) *OpenAI {
	t.Helper()
	g, err := NewOpenAI(config)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func traceWire(trace ProviderTrace) string {
	var result strings.Builder
	for _, chunk := range trace.StreamChunks {
		result.WriteString(chunk.Data)
	}
	return result.String()
}

const traceChatSuccess = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"

func TestProviderTraceDisabledLeavesRequestsUntouched(t *testing.T) {
	var recorder traceRecorder
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer sk-debug-test-credential" || req.Header.Get("X-Relay") != "relay-private-value" {
			t.Error("capture changed provider credentials")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, traceChatSuccess)
	}))
	defer server.Close()
	for _, enabled := range []func() bool{nil, func() bool { return false }} {
		config := traceTestConfig(server.URL, &recorder)
		config.DebugEnabled = enabled
		config.Headers = map[string]string{"X-Relay": "relay-private-value"}
		g := traceTestRunner(t, config)
		message, _, err := g.streamChat(context.Background(), nil, nil, "round-off", func(Update) error { return nil })
		if err != nil || message.Content != "hello" {
			t.Fatalf("disabled debug changed completion: %+v, %v", message, err)
		}
	}
	if len(recorder.all()) != 0 {
		t.Fatal("disabled debug emitted a provider trace")
	}
}

func TestProviderTraceChatWireOrderUsageAndSemanticCompletion(t *testing.T) {
	var recorder traceRecorder
	prefix := ": ping\r\nevent: completion\r\ndata: { \"choices\": [{\"delta\": {\"content\": \"hello\"}}] }\r\n\r\n"
	suffix := "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3,\"total_tokens\":12,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\ndata: [DONE]\n\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-ID", "upstream-request-id")
		w.Header().Set("Set-Cookie", "session=response-private-cookie")
		_, _ = io.WriteString(w, prefix)
		w.(http.Flusher).Flush()
		time.Sleep(5 * time.Millisecond)
		_, _ = io.WriteString(w, suffix)
	}))
	defer server.Close()
	g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
	ctx := WithRunScope(context.Background(), RunScope{RunID: "run-id", SessionID: "session-id"})
	message, usage, err := g.stream(ctx, []wireMessage{{Role: "user", Content: "say hello"}}, nil, "round-3", func(Update) error {
		if len(recorder.all()) != 0 {
			t.Error("trace callback ran on the token path before semantic parsing finished")
		}
		return nil
	})
	if err != nil || message.Content != "hello" || usage == nil || usage.TotalTokens != 12 {
		t.Fatalf("completion=%+v usage=%+v err=%v", message, usage, err)
	}
	trace := recorder.one(t)
	if trace.RunID != "run-id" || trace.SessionID != "session-id" || trace.Round != "round-3" || trace.Attempt != 1 || trace.Purpose != "chat" || trace.Protocol != "openai" || trace.ProviderID != "provider-id" || trace.ModelID != "model-id" {
		t.Fatalf("missing request scope: %+v", trace)
	}
	if id, err := hex.DecodeString(trace.ID); err != nil || len(id) != 16 {
		t.Fatalf("trace id is not a PostgreSQL-compatible UUID: %q", trace.ID)
	}
	if traceWire(trace) != prefix+suffix {
		t.Fatalf("SSE line order/format changed: %q", traceWire(trace))
	}
	if !trace.Stream || !trace.SawDone || trace.FinishReason != "stop" || trace.ErrorClass != "" || trace.StatusCode != 200 || trace.RequestID != "upstream-request-id" || trace.Truncated {
		t.Fatalf("incorrect successful trace: %+v", trace)
	}
	if trace.Usage == nil || trace.Usage.TotalTokens != 12 || trace.Usage.CachedTokens == nil || *trace.Usage.CachedTokens != 2 || trace.Usage.ReasoningTokens == nil || *trace.Usage.ReasoningTokens != 1 {
		t.Fatalf("trace lost usage metadata: %+v", trace.Usage)
	}
	if trace.RequestBytes == 0 || trace.ResponseBytes != int64(len(prefix+suffix)) || trace.CapturedBytes != len(prefix+suffix) || trace.FirstByteAt == nil || trace.FirstTokenAt == nil || trace.LastDataAt == nil || trace.TTFBMS == nil || trace.TTFTMS == nil || trace.FinishedAt.Before(*trace.FirstTokenAt) {
		t.Fatalf("trace lost byte/timing metadata: %+v", trace)
	}
	for i, chunk := range trace.StreamChunks {
		if chunk.Sequence != i+1 || chunk.AtMS < 0 || i > 0 && chunk.AtMS < trace.StreamChunks[i-1].AtMS {
			t.Fatalf("invalid wire sequence/timing: %+v", trace.StreamChunks)
		}
	}
	if trace.RequestHeaders.Get("Authorization") != "[REDACTED]" || trace.ResponseHeaders.Get("Set-Cookie") != "[REDACTED]" || !trace.Redacted {
		t.Fatal("request/response credentials were not redacted")
	}
}

func TestProviderTraceStreamFailures(t *testing.T) {
	for _, test := range []struct {
		name, body, class, finish, upstream string
		usage                               int64
	}{
		{name: "EOF", body: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", class: "stream"},
		{name: "malformed", body: "data: {broken}\n\n", class: "invalid_stream"},
		{name: "upstream", body: "data: {\"error\":{\"code\":\"permission_denied\",\"type\":\"policy\",\"message\":\"access denied\"}}\n\n", class: "permission", upstream: "permission_denied"},
		{name: "length", body: "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n", class: "output_limit", finish: "length", usage: 7},
		{name: "tool protocol", body: "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", class: "tool_protocol", finish: "tool_calls"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var recorder traceRecorder
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
			_, _, err := g.streamChat(context.Background(), nil, nil, "failure", func(Update) error { return nil })
			if err == nil {
				t.Fatal("expected semantic stream failure")
			}
			trace := recorder.one(t)
			if trace.ErrorClass != test.class || trace.FinishReason != test.finish || trace.UpstreamErrorCode != test.upstream || traceWire(trace) != test.body {
				t.Fatalf("failure trace=%+v err=%v", trace, err)
			}
			if test.usage > 0 && (trace.Usage == nil || trace.Usage.TotalTokens != test.usage) {
				t.Fatalf("terminal error lost usage: %+v", trace)
			}
			if test.name == "EOF" && (!trace.SawEOF || trace.SawDone) {
				t.Fatalf("EOF is confused with [DONE]: %+v", trace)
			}
			if test.name == "malformed" && !strings.Contains(trace.Error, "invalid character") {
				t.Fatalf("malformed stream lost the parse error: %s", trace.Error)
			}
		})
	}
}

func TestProviderTraceHTTPPermissionAndRetryAttempts(t *testing.T) {
	t.Run("403", func(t *testing.T) {
		var recorder traceRecorder
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Request-ID", "denied-request")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":{"code":"permission_denied","type":"policy","message":"denied for sk-debug-test-credential"}}`)
		}))
		defer server.Close()
		g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
		_, _, err := g.stream(context.Background(), nil, nil, "denied", func(Update) error { return nil })
		trace := recorder.one(t)
		if err == nil || requests.Load() != 1 || trace.StatusCode != 403 || trace.RequestID != "denied-request" || trace.ErrorClass != "permission" || trace.UpstreamErrorCode != "permission_denied" || trace.UpstreamErrorType != "policy" || len(trace.StreamChunks) != 0 || trace.ResponseBody == "" {
			t.Fatalf("incorrect permission attempt: %+v err=%v requests=%d", trace, err, requests.Load())
		}
		assertTraceNoSecrets(t, trace, "sk-debug-test-credential")
	})
	t.Run("retry", func(t *testing.T) {
		var recorder traceRecorder
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if requests.Add(1) == 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, `{"error":{"code":"server_error","message":"retry later"}}`)
				return
			}
			if len(recorder.all()) != 1 {
				t.Error("failed attempt was not finalized before retry")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, traceChatSuccess)
		}))
		defer server.Close()
		g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
		_, _, err := g.stream(context.Background(), nil, nil, "retry-round", func(Update) error { return nil })
		traces := recorder.all()
		if err != nil || len(traces) != 2 || traces[0].Attempt != 1 || traces[1].Attempt != 2 || traces[0].Round != "retry-round" || traces[1].Round != "retry-round" || traces[0].ErrorClass != "unavailable" || traces[1].ErrorClass != "" || traces[0].ID == traces[1].ID {
			t.Fatalf("retry attempts=%+v err=%v", traces, err)
		}
	})
}

func TestProviderTraceChecksDebugAtEachAttempt(t *testing.T) {
	var recorder traceRecorder
	var enabled atomic.Bool
	enabled.Store(true)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"error":{"code":"server_error","message":"retry"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, traceChatSuccess)
	}))
	defer server.Close()
	config := traceTestConfig(server.URL, &recorder)
	config.DebugEnabled = enabled.Load
	config.ObserveProvider = func(trace ProviderTrace) {
		recorder.observe(trace)
		enabled.Store(false)
	}
	g := traceTestRunner(t, config)
	_, _, err := g.stream(context.Background(), nil, nil, "toggle-round", func(Update) error { return nil })
	trace := recorder.one(t)
	if err != nil || requests.Load() != 2 || trace.Attempt != 1 || trace.StatusCode != 503 {
		t.Fatalf("debug toggle was not checked for each retry: trace=%+v requests=%d err=%v", trace, requests.Load(), err)
	}
}

func TestProviderTraceUnderlyingReadAndConnectionErrors(t *testing.T) {
	for _, headers := range []bool{false, true} {
		t.Run(fmt.Sprintf("headers=%v", headers), func(t *testing.T) {
			var recorder traceRecorder
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				conn, buffered, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				if headers {
					_, _ = buffered.WriteString("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 9999\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
					_ = buffered.Flush()
				}
			}))
			defer server.Close()
			g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
			_, _, err := g.streamChat(context.Background(), nil, nil, "network", func(Update) error { return nil })
			trace := recorder.one(t)
			if err == nil || !strings.Contains(trace.Error, "EOF") || headers && (!strings.Contains(trace.ReadError, "unexpected EOF") || !trace.ResponseTruncated) || !headers && trace.ErrorClass != "connection" {
				t.Fatalf("lost underlying HTTP error: %+v err=%v", trace, err)
			}
		})
	}
}

func TestProviderTraceResponsesSemantics(t *testing.T) {
	for _, test := range []struct{ name, terminal, class, reason, status string }{
		{name: "completed", terminal: `{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"snapshot answer"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}`, status: "completed"},
		{name: "incomplete", terminal: `{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}`, class: "output_limit", reason: "max_output_tokens", status: "incomplete"},
		{name: "tool protocol", terminal: `{"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"","name":"missing_id","arguments":"{}"}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}`, class: "tool_protocol", status: "completed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var recorder traceRecorder
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path != "/responses" {
					t.Error("Responses used the wrong endpoint")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "event: "+test.status+"\ndata: "+test.terminal+"\n\n")
			}))
			defer server.Close()
			config := traceTestConfig(server.URL, &recorder)
			config.Protocol = "openai-responses"
			g := traceTestRunner(t, config)
			_, usage, err := g.streamResponses(context.Background(), nil, nil, "responses-round", func(Update) error {
				if len(recorder.all()) != 0 {
					t.Error("Responses callback ran before complete semantic validation")
				}
				return nil
			})
			trace := recorder.one(t)
			if (err == nil) != (test.class == "") || usage == nil || usage.TotalTokens != 6 || trace.ErrorClass != test.class || trace.FinishReason != test.reason || trace.ResponseStatus != test.status || trace.SawCompleted != (test.status == "completed") || trace.Usage == nil || trace.Usage.TotalTokens != 6 {
				t.Fatalf("Responses trace=%+v err=%v", trace, err)
			}
			if test.name == "completed" && trace.FirstTokenAt == nil {
				t.Fatal("terminal-only Responses output lost first-token time")
			}
		})
	}
}

func TestProviderTraceAuxiliaryAndEmbeddings(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-responses"} {
		t.Run(protocol, func(t *testing.T) {
			var recorder traceRecorder
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if protocol == "openai-responses" {
					_, _ = io.WriteString(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"a title"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}`)
				} else {
					_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"a title"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`)
				}
			}))
			defer server.Close()
			config := traceTestConfig(server.URL, &recorder)
			config.Protocol = protocol
			ctx := WithRunScope(WithProviderTracePurpose(context.Background(), "title"), RunScope{RunID: "aux-run", SessionID: "aux-session"})
			text, usage, err := CompleteWithUsage(ctx, config, "write title", "hello", 64)
			trace := recorder.one(t)
			if err != nil || text != "a title" || usage == nil || usage.TotalTokens != 5 || trace.Usage == nil || trace.Usage.TotalTokens != 5 || trace.Purpose != "title" || trace.RunID != "aux-run" || trace.SessionID != "aux-session" || trace.Stream || trace.ResponseBody == "" || trace.FirstTokenAt == nil {
				t.Fatalf("auxiliary trace=%+v text=%q err=%v", trace, text, err)
			}
		})
	}
	t.Run("embedding", func(t *testing.T) {
		var recorder traceRecorder
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path != "/embeddings" {
				t.Error("embedding used wrong endpoint")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"index":0,"embedding":[0.1234567,0.7654321]}],"usage":{"prompt_tokens":2,"total_tokens":2}}`)
		}))
		defer server.Close()
		vectors, err := Embed(context.Background(), traceTestConfig(server.URL, &recorder), []string{"text"})
		trace := recorder.one(t)
		if err != nil || len(vectors) != 1 || len(vectors[0]) != 2 || trace.Purpose != "embedding" || trace.FirstTokenAt != nil || trace.Usage == nil || trace.Usage.TotalTokens != 2 || strings.Contains(trace.ResponseBody, "0.1234567") || !strings.Contains(trace.ResponseBody, "[binary payload omitted]") {
			t.Fatalf("embedding trace=%+v vectors=%v err=%v", trace, vectors, err)
		}
	})
}

func assertTraceNoSecrets(t *testing.T, trace ProviderTrace, secrets ...string) {
	t.Helper()
	encoded, _ := json.Marshal(trace)
	for _, secret := range secrets {
		escaped, _ := json.Marshal(secret)
		for _, forbidden := range []string{secret, string(escaped[1 : len(escaped)-1]), url.QueryEscape(secret), url.PathEscape(secret)} {
			if strings.Contains(string(encoded), forbidden) {
				t.Fatalf("provider trace leaked credential %q: %s", secret, encoded)
			}
		}
	}
}

func TestProviderTraceRedactsHeadersURLBodiesAndErrorCauses(t *testing.T) {
	var recorder traceRecorder
	config := traceTestConfig("https://provider.invalid", &recorder)
	config.APIKey = `sk-private-\"-credential`
	config.Headers = map[string]string{"X-Unusual-Relay": "custom-relay-secret", "Cookie": "cookie=request-cookie-secret"}
	req := httptest.NewRequest(http.MethodPost, "https://url-user:url-password@provider.invalid/v1?api_key=query-private-secret&visible=ok", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	for key, value := range config.Headers {
		req.Header.Set(key, value)
	}
	payload, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"content": "echo " + config.APIKey + " custom-relay-secret", "image_url": map[string]any{"url": "data:image/png;base64,aW1hZ2VieXRlcw=="}}}, "api_key": "unknown-request-key", "arguments": `{"password":"nested-password-secret"}`})
	capture := newProviderTrace(config, req, payload)
	responseBody, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "permission_denied", "message": "echo " + config.APIKey + " custom-relay-secret response-cookie-secret unknown-response-token nested-password-secret signed-url-secret"}, "access_token": "unknown-response-token", "b64_json": "aW1hZ2VieXRlcw==", "url": "https://image.invalid/download?X-Amz-Signature=signed-url-secret&path=ok"})
	response := &http.Response{StatusCode: 403, ContentLength: int64(len(responseBody)), Header: http.Header{"Content-Type": {"application/json"}, "Set-Cookie": {"session=response-cookie-secret"}}, Body: io.NopCloser(bytes.NewReader(responseBody))}
	capture.responseHeaders(response)
	_, _ = io.ReadAll(response.Body)
	capture.finish(nil, fmt.Errorf("outer %s: %w", config.APIKey, errors.New("socket reset custom-relay-secret")))
	capture.finish(nil, nil)
	trace := recorder.one(t)
	assertTraceNoSecrets(t, trace, config.APIKey, "custom-relay-secret", "request-cookie-secret", "response-cookie-secret", "url-user", "url-password", "query-private-secret", "unknown-request-key", "nested-password-secret", "unknown-response-token", "signed-url-secret", "aW1hZ2VieXRlcw==")
	if trace.RequestHeaders.Get("X-Unusual-Relay") != "[REDACTED]" || !trace.Redacted || !strings.Contains(trace.Error, "socket reset") || !strings.Contains(trace.URL, "visible=ok") || !json.Valid([]byte(trace.RequestBody)) || !json.Valid([]byte(trace.ResponseBody)) {
		t.Fatalf("redaction destroyed diagnostics: %+v", trace)
	}
}

func TestProviderTraceLimitsDoNotLimitActualOutput(t *testing.T) {
	for _, chunks := range []bool{false, true} {
		t.Run(fmt.Sprintf("chunks=%v", chunks), func(t *testing.T) {
			var recorder traceRecorder
			content := strings.Repeat("x", 2*providerTraceBodyLimit)
			var received atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				data, _ := io.ReadAll(req.Body)
				received.Store(int64(len(data)))
				w.Header().Set("Content-Type", "text/event-stream")
				if chunks {
					_, _ = io.WriteString(w, strings.Repeat(": ping\n", providerTraceChunkLimit+20))
					_, _ = io.WriteString(w, traceChatSuccess)
				} else {
					part, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": content}}}})
					_, _ = fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\ndata: [DONE]\n\n", part)
				}
			}))
			defer server.Close()
			g := traceTestRunner(t, traceTestConfig(server.URL, &recorder))
			var output strings.Builder
			message, _, err := g.streamChat(context.Background(), []wireMessage{{Role: "user", Content: content}}, nil, "limits", func(update Update) error { output.WriteString(update.Text); return nil })
			trace := recorder.one(t)
			want := content
			if chunks {
				want = "hello"
			}
			if err != nil || message.Content != want || output.String() != want || received.Load() <= providerTraceBodyLimit || !trace.RequestTruncated || !trace.ResponseTruncated || !trace.Truncated || trace.CapturedBytes > providerTraceBodyLimit || len(traceWire(trace)) > providerTraceBodyLimit || len(trace.StreamChunks) > providerTraceChunkLimit {
				t.Fatalf("capture bounds affected actual protocol: trace=%+v output=%d want=%d err=%v", trace, output.Len(), len(want), err)
			}
			if !chunks && (trace.Usage == nil || trace.Usage.TotalTokens != 5 || trace.FinishReason != "stop") {
				t.Fatal("truncated diagnostic capture lost parsed terminal metadata")
			}
		})
	}
}

type traceByteReader struct{ io.Reader }

func (r traceByteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:min(1, len(p))]) }

func TestProviderTraceTinyReadsDoNotConsumeChunkBudget(t *testing.T) {
	var recorder traceRecorder
	req := httptest.NewRequest(http.MethodPost, "http://provider.invalid/chat/completions", nil)
	capture := newProviderTrace(traceTestConfig("http://provider.invalid", &recorder), req, []byte(`{"stream":true}`))
	raw := ": " + strings.Repeat("x", providerTraceChunkLimit+5) + "\n" + traceChatSuccess
	response := &http.Response{StatusCode: 200, ContentLength: int64(len(raw)), Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(traceByteReader{strings.NewReader(raw)})}
	capture.responseHeaders(response)
	_, _ = io.ReadAll(response.Body)
	capture.finish(nil, nil)
	trace := recorder.one(t)
	if trace.ResponseTruncated || traceWire(trace) != raw {
		t.Fatalf("read operations were counted as SSE chunks: %+v", trace)
	}
}

func TestProviderTraceImageSemanticErrorsAndBinaryOmission(t *testing.T) {
	for _, valid := range []bool{false, true} {
		t.Run(fmt.Sprintf("valid=%v", valid), func(t *testing.T) {
			var recorder traceRecorder
			encoded := base64.StdEncoding.EncodeToString(imageTestPNG(t))
			if !valid {
				encoded = "not-base64-image!"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if !strings.HasPrefix(req.Header.Get("Content-Type"), "multipart/") {
					t.Error("image edits stopped using multipart")
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"b64_json": encoded}}, "usage": map[string]int{"input_tokens": 2, "output_tokens": 3, "total_tokens": 5}})
			}))
			defer server.Close()
			config := traceTestConfig(server.URL, &recorder)
			config.Model = "gpt-image-2"
			_, err := GenerateImage(context.Background(), config, ImageOptions{Prompt: "a bird", Images: []ImageInput{{Data: imageTestPNG(t)}}})
			trace := recorder.one(t)
			if (err == nil) != valid || (trace.ErrorClass == "") != valid || trace.Purpose != "image" || trace.Usage == nil || trace.Usage.TotalTokens != 5 || !strings.Contains(trace.RequestBody, "multipart image input omitted") || strings.Contains(trace.ResponseBody, encoded) || !strings.Contains(trace.ResponseBody, "binary payload omitted") {
				t.Fatalf("image trace finalized before validation or retained binary: %+v err=%v", trace, err)
			}
		})
	}
}

func TestProviderTraceImageDownloadHasNoCredentialsOrBinary(t *testing.T) {
	var recorder traceRecorder
	data := imageTestPNG(t)
	imageHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "" || req.Header.Get("X-Relay") != "" || req.URL.Query().Get("X-Amz-Signature") != "signed-download-private" {
			t.Error("image download request changed or inherited credentials")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	}))
	defer imageHost.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"url": imageHost.URL + "/image?X-Amz-Signature=signed-download-private"}}})
	}))
	defer provider.Close()
	config := traceTestConfig(provider.URL, &recorder)
	config.Model = "gpt-image-2"
	config.Headers = map[string]string{"X-Relay": "private-image-relay"}
	result, err := GenerateImage(context.Background(), config, ImageOptions{Prompt: "a bird"})
	traces := recorder.all()
	if err != nil || !bytes.Equal(result.Data, data) || len(traces) != 2 || traces[0].Purpose != "image_download" || traces[0].Method != http.MethodGet || traces[0].ResponseBody != "[binary payload omitted]" || traces[0].ResponseBytes != int64(len(data)) || traces[0].CapturedBytes != 0 {
		t.Fatalf("image download traces=%+v err=%v", traces, err)
	}
	for _, trace := range traces {
		assertTraceNoSecrets(t, trace, "signed-download-private", "private-image-relay", "sk-debug-test-credential")
	}
}
