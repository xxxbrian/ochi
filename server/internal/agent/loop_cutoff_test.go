package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type cutoffTools struct {
	parallel bool
	fail     bool
	reads    atomic.Int32
	writes   atomic.Int32
}

func (tools *cutoffTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	execution := &ToolExecution{ReadOnly: true, ParallelSafe: tools.parallel}
	if !tools.parallel && tools.fail {
		execution = nil // exec is never certified safe for read parallelism.
	}
	return []ToolDefinition{
		{Name: "read", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false}`), Execution: execution},
		{Name: "write", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
	}, nil
}

func (tools *cutoffTools) Call(_ context.Context, _, name string, _ json.RawMessage) (ToolResult, error) {
	if name == "write" {
		tools.writes.Add(1)
		return ToolResult{Output: "actual write"}, nil
	}
	tools.reads.Add(1)
	if tools.fail {
		return ToolResult{Output: `{"exit_code":1,"stderr":"same error"}`}, nil
	}
	return ToolResult{Output: "same observation"}, nil
}

func TestLoopCutoffStopsUndispatchedCallsWithinOneResponse(t *testing.T) {
	for _, test := range []struct {
		name       string
		parallel   bool
		fail       bool
		calls      int
		wantReads  int32
		wantReason string
	}{
		{"serial_failure", false, true, 30, 3, "repeated_failure"},
		{"parallel_failure_drains_started_batch", true, true, 30, 4, "repeated_failure"},
		{"parallel_no_progress", true, false, 12, 8, "no_progress"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tools := &cutoffTools{parallel: test.parallel, fail: test.fail}
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 {
					calls := make([]toolCall, 0, test.calls+1)
					for i := 0; i < test.calls; i++ {
						calls = append(calls, toolCall{ID: fmt.Sprintf("read-%d", i), Function: functionCall{Name: "read", Arguments: `{}`}})
					}
					calls = append(calls, toolCall{ID: "late-write", Function: functionCall{Name: "write", Arguments: `{}`}})
					writeToolCalls(w, calls)
					return
				}
				var request struct {
					Tools []wireTool `json:"tools"`
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Tools) != 0 {
					t.Error("cutoff final request still exposes tools")
				}
				writeChatAnswer(w, "Stopped; remaining calls were not dispatched.")
			}))
			defer server.Close()
			diagnostics := []Diagnostic{}
			generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools, Observe: func(d Diagnostic) { diagnostics = append(diagnostics, d) }})
			results := []wireMessage{}
			err := generator.Generate(context.Background(), Request{}, func(update Update) error {
				if update.Canonical != nil {
					var m wireMessage
					if json.Unmarshal(update.Canonical.Payload, &m) == nil && m.Role == "tool" {
						results = append(results, m)
					}
				}
				return nil
			})
			if err != nil || requests.Load() != 2 || tools.reads.Load() != test.wantReads || tools.writes.Load() != 0 || len(results) != test.calls+1 {
				t.Fatalf("cutoff err=%v requests=%d reads=%d writes=%d results=%d", err, requests.Load(), tools.reads.Load(), tools.writes.Load(), len(results))
			}
			for index, m := range results {
				wantID := fmt.Sprintf("read-%d", index)
				if index == test.calls {
					wantID = "late-write"
				}
				text, ok := m.Content.(string)
				if !ok || m.ToolCallID != wantID || (index >= int(test.wantReads)) != strings.Contains(text, `"not_dispatched"`) {
					t.Fatal("canonical pairing lost actual vs skipped call distinction")
				}
			}
			found := false
			for _, d := range diagnostics {
				found = found || d.Kind == "loop_stopped" && d.Class == test.wantReason
			}
			if !found {
				t.Fatal("cutoff diagnostic not emitted")
			}
		})
	}
}
