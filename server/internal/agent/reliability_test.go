package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func writeChatAnswer(w http.ResponseWriter, text string) {
	delta := map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}, "finish_reason": "stop"}}}
	data, _ := json.Marshal(delta)
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
}

func writeToolCalls(w http.ResponseWriter, calls []toolCall) {
	items := make([]any, len(calls))
	for index, call := range calls {
		items[index] = map[string]any{"index": index, "id": call.ID, "function": call.Function}
	}
	data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": items}, "finish_reason": "tool_calls"}}})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
}

func TestFailureFingerprintIgnoresOnlyExecutionMetadata(t *testing.T) {
	before := `{"exit_code":1,"stderr":"missing file /data/work/src/main.go; log /data/logs/abc.err","stdout":"","cwd":"/data/work","duration_ms":140,"stdout_path":"/data/logs/abc.out","stderr_path":"/data/logs/abc.err"}`
	after := strings.ReplaceAll(strings.ReplaceAll(before, "abc", "xyz"), "140", "912")
	key := failureFingerprint("exec", `{"cmd":"go test","timeout_ms":1000}`, before)
	if key != failureFingerprint("exec", `{"timeout_ms":1000,"cmd":"go test"}`, after) {
		t.Fatal("elapsed time or bridge log paths changed the failure fingerprint")
	}
	for _, distinct := range []string{
		strings.Replace(before, "exit_code\":1", "exit_code\":2", 1),
		strings.Replace(before, "src/main.go", "src/other.go", 1),
		strings.Replace(before, "missing file", "permission denied", 1),
		strings.Replace(before, `"cwd":"/data/work"`, `"cwd":"/data/other"`, 1),
	} {
		if key == failureFingerprint("exec", `{"cmd":"go test","timeout_ms":1000}`, distinct) {
			t.Fatalf("distinct actual failure was normalized away: %s", distinct)
		}
	}
	if failureFingerprint("files_read", `{}`, before) == failureFingerprint("files_read", `{}`, after) {
		t.Fatal("non-exec output was incorrectly treated as bridge execution metadata")
	}
}

func TestNoProgressDetectionDoesNotConflateWritesWithReadRepeats(t *testing.T) {
	detector := loopDetector{}
	read := &ToolExecution{ReadOnly: true, ParallelSafe: true}
	call := toolCall{Function: functionCall{Name: "files_read", Arguments: `{"path":"x"}`}}
	for index := 0; index < 5; index++ {
		if reason := detector.observe(call, Step{Status: "completed", Output: "same"}, read); reason != "" {
			t.Fatalf("stopped a short legitimate re-read: %s", reason)
		}
	}
	if reason := detector.observe(call, Step{Status: "completed", Output: "same"}, read); reason != "no_progress" {
		t.Fatalf("unbounded no-progress reads: %q", reason)
	}
	detector.observe(toolCall{Function: functionCall{Name: "files_write"}}, Step{Status: "completed", Output: "same"}, nil)
	if len(detector.recent) != 0 {
		t.Fatal("successful side effect did not reset possible no-progress history")
	}
	for index := 0; index < 20; index++ {
		if reason := detector.observe(call, Step{Status: "completed", Output: fmt.Sprint(index)}, read); reason != "" {
			t.Fatal("distinct read results were treated as no progress")
		}
	}
}

func TestModelRetryClassificationAndSanitizedErrors(t *testing.T) {
	for _, test := range []struct {
		name, code string
		status     int
		retries    bool
	}{
		{"rate", "rate_limit_exceeded", 429, true}, {"overload", "server_error", 503, true},
		{"auth", "invalid_api_key", 401, false}, {"quota", "insufficient_quota", 429, false},
		{"configuration", "invalid_parameter", 400, false}, {"context", "context_length_exceeded", 400, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 || !test.retries {
					w.WriteHeader(test.status)
					fmt.Fprintf(w, `{"error":{"code":%q,"message":"secret-provider-token; https://user:pass@provider.test/?key=private"}}`, test.code)
					return
				}
				writeChatAnswer(w, "done")
			}))
			defer server.Close()
			generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
			err := generator.Generate(context.Background(), Request{}, func(Update) error { return nil })
			if test.retries {
				if err != nil || requests.Load() != 2 {
					t.Fatalf("retry err=%v requests=%d", err, requests.Load())
				}
			} else if err == nil || requests.Load() != 1 || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "pass") {
				t.Fatalf("terminal error leaked or retried: err=%v requests=%d", err, requests.Load())
			}
		})
	}
}

func TestRetryAfterDelayAndContextCancellation(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writeChatAnswer(w, "ready")
	}))
	defer server.Close()
	start := time.Now()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
	if err := generator.Generate(context.Background(), Request{}, func(Update) error { return nil }); err != nil || time.Since(start) < time.Second || requests.Load() != 2 {
		t.Fatalf("Retry-After not respected: err=%v elapsed=%s requests=%d", err, time.Since(start), requests.Load())
	}
	now := time.Now().UTC().Truncate(time.Second)
	if delay := parseRetryAfter(now.Add(3*time.Second).Format(http.TimeFormat), now); delay != 3*time.Second {
		t.Fatalf("HTTP date delay=%s", delay)
	}
	if _, retry := retryDelay(&ModelError{Class: "rate_limit", retryable: true, RetryAfter: time.Minute}, 1); retry {
		t.Fatal("long Retry-After was shortened")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start = time.Now()
	if err := waitRetry(ctx, 30*time.Second); !errors.Is(err, context.Canceled) || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("backoff ignored cancellation: %v", err)
	}
}

func TestNoRetryAfterStreamedOutputOrClientFailure(t *testing.T) {
	for _, test := range []struct {
		name, content string
		callbackError bool
	}{
		{"partial_text", `{"choices":[{"delta":{"content":"partial"}}]}`, false},
		{"partial_reasoning", `{"choices":[{"delta":{"reasoning_content":"partial reasoning"}}]}`, false},
		{"client_failure", `{"choices":[{"delta":{"content":"partial"}}]}`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				fmt.Fprintf(w, "data: %s\n\n", test.content)
			}))
			defer server.Close()
			generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
			clientErr := errors.New("client failed")
			err := generator.Generate(context.Background(), Request{}, func(Update) error {
				if test.callbackError {
					return clientErr
				}
				return nil
			})
			if err == nil || requests.Load() != 1 || test.callbackError && !errors.Is(err, clientErr) {
				t.Fatalf("unsafe replay: err=%v requests=%d", err, requests.Load())
			}
		})
	}
}

func TestStreamRetryBeforeAnyOutputDoesNotDuplicateToolEffects(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		switch requests.Add(1) {
		case 1:
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"interrupted","function":{"name":"files_read","arguments":"{"}}]}}]}`+"\n\n")
		case 2:
			writeToolCalls(w, []toolCall{{ID: "actual", Function: functionCall{Name: "files_read", Arguments: `{"path":"hello.txt"}`}}})
		default:
			writeChatAnswer(w, "done")
		}
	}))
	defer server.Close()
	tools := &testTools{}
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
	canonical := []wireMessage{}
	err := generator.Generate(context.Background(), Request{UserID: "ochi-test"}, func(update Update) error {
		if update.Canonical != nil {
			var message wireMessage
			_ = json.Unmarshal(update.Canonical.Payload, &message)
			canonical = append(canonical, message)
		}
		return nil
	})
	if err != nil || tools.calls != 1 || requests.Load() != 3 || len(canonical) != 3 || canonical[0].ToolCalls[0].ID != "actual" {
		t.Fatalf("unsafe tool replay: err=%v tools=%d requests=%d history=%+v", err, tools.calls, requests.Load(), canonical)
	}
}

type barrierTools struct {
	mu          sync.Mutex
	active      int
	maxActive   int
	writeRace   bool
	started     []string
	definitions []ToolDefinition
}

func (tools *barrierTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return tools.definitions, nil
}
func (tools *barrierTools) Call(ctx context.Context, _ string, name string, arguments json.RawMessage) (ToolResult, error) {
	var input struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(arguments, &input)
	tools.mu.Lock()
	tools.started = append(tools.started, input.ID)
	if name == "write" {
		tools.writeRace = tools.writeRace || tools.active > 0
		tools.mu.Unlock()
		return ToolResult{Output: "written"}, nil
	}
	tools.active++
	tools.maxActive = max(tools.maxActive, tools.active)
	tools.mu.Unlock()
	delay := 10 * time.Millisecond
	if input.ID == "a" || input.ID == "c" {
		delay = 30 * time.Millisecond
	}
	select {
	case <-ctx.Done():
	case <-time.After(delay):
	}
	tools.mu.Lock()
	tools.active--
	tools.mu.Unlock()
	return ToolResult{Output: input.ID}, ctx.Err()
}

func TestReadOnlyParallelBatchesKeepWritesAndCanonicalOrder(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)
	tools := &barrierTools{definitions: []ToolDefinition{
		{Name: "read", Parameters: schema, Execution: &ToolExecution{ReadOnly: true, ParallelSafe: true}},
		{Name: "write", Parameters: schema},
	}}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(string(body["tools"]), "parallel_safe") || strings.Contains(string(body["tools"]), "Execution") {
			t.Error("private execution metadata leaked into provider schemas")
		}
		if requests.Add(1) == 1 {
			calls := []toolCall{}
			for _, id := range []string{"a", "b", "w", "c", "d"} {
				name := "read"
				if id == "w" {
					name = "write"
				}
				calls = append(calls, toolCall{ID: id, Function: functionCall{Name: name, Arguments: fmt.Sprintf(`{"id":%q}`, id)}})
			}
			writeToolCalls(w, calls)
		} else {
			writeChatAnswer(w, "done")
		}
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
	order := []string{}
	err := generator.Generate(context.Background(), Request{}, func(update Update) error {
		if update.Canonical != nil {
			var message wireMessage
			_ = json.Unmarshal(update.Canonical.Payload, &message)
			if message.Role == "tool" {
				order = append(order, message.ToolCallID)
			}
		}
		return nil
	})
	if err != nil || tools.maxActive != 2 || tools.writeRace || strings.Join(order, ",") != "a,b,w,c,d" || tools.started[2] != "w" {
		t.Fatalf("batch ordering: err=%v active=%d writeRace=%v starts=%v canonical=%v", err, tools.maxActive, tools.writeRace, tools.started, order)
	}
}
