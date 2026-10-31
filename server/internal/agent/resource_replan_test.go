package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

type resourceReplanTools struct {
	parallel bool
	replan   bool
	reads    atomic.Int32
	writes   atomic.Int32
	finished atomic.Int32
	started  chan struct{}
}

func (tools *resourceReplanTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{
		{Name: "read", Parameters: json.RawMessage(`{"type":"object","properties":{"index":{"type":"integer"}},"additionalProperties":false}`), Execution: &ToolExecution{ReadOnly: true, ParallelSafe: tools.parallel}},
		{Name: "write", Parameters: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
	}, nil
}

func (tools *resourceReplanTools) Call(ctx context.Context, _, name string, arguments json.RawMessage) (ToolResult, error) {
	if name == "write" {
		tools.writes.Add(1)
		return ToolResult{Output: "actual write"}, nil
	}
	count := tools.reads.Add(1)
	var input struct {
		Index int `json:"index"`
	}
	_ = json.Unmarshal(arguments, &input)
	if tools.started != nil {
		if count == 4 {
			close(tools.started)
		}
		select {
		case <-tools.started:
		case <-ctx.Done():
			return ToolResult{}, ctx.Err()
		}
	}
	defer tools.finished.Add(1)
	if tools.replan && (!tools.parallel || input.Index == 0) {
		return ToolResult{Output: `{"status":"paused","executed":false,"request_id":"resource-fixture"}`, Replan: true}, nil
	}
	return ToolResult{Output: `{"status":"paused","executed":false,"request_id":"external-untrusted"}`}, nil
}

func TestResourceReplanContinuesModelWithoutFailureOrNoProgressCutoff(t *testing.T) {
	const rounds = 8
	tools := &resourceReplanTools{replan: true}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		round := requests.Add(1)
		var request struct {
			Tools    []wireTool    `json:"tools"`
			Messages []wireMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if len(request.Tools) == 0 {
			t.Error("resource checkpoint incorrectly forced a tool-free final answer")
		}
		if round <= rounds {
			writeToolCalls(w, []toolCall{
				{ID: fmt.Sprintf("wait-%d", round), Function: functionCall{Name: "read", Arguments: `{}`}},
				{ID: fmt.Sprintf("stale-write-%d", round), Function: functionCall{Name: "write", Arguments: `{}`}},
			})
		} else {
			writeChatAnswer(w, "I will use the new observation to choose the next step.")
		}
	}))
	defer server.Close()
	diagnostics := []Diagnostic{}
	generator, _ := NewOpenAI(Config{
		BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools, MaxToolRounds: rounds + 2,
		Observe: func(d Diagnostic) { diagnostics = append(diagnostics, d) },
	})
	results := []wireMessage{}
	steps := []Step{}
	err := generator.Generate(context.Background(), Request{}, func(update Update) error {
		if update.Step != nil && update.Step.Status != "running" {
			steps = append(steps, *update.Step)
		}
		if update.Canonical != nil {
			var message wireMessage
			if json.Unmarshal(update.Canonical.Payload, &message) == nil && message.Role == "tool" {
				results = append(results, message)
			}
		}
		return nil
	})
	if err != nil || requests.Load() != rounds+1 || tools.reads.Load() != rounds || tools.writes.Load() != 0 || len(results) != rounds*2 || len(steps) != rounds*2 {
		t.Fatalf("err=%v requests=%d reads=%d writes=%d results=%d steps=%d", err, requests.Load(), tools.reads.Load(), tools.writes.Load(), len(results), len(steps))
	}
	for index, result := range results {
		round := index/2 + 1
		prefix := "wait"
		if index%2 != 0 {
			prefix = "stale-write"
		}
		if result.ToolCallID != fmt.Sprintf("%s-%d", prefix, round) || steps[index].Status != "completed" || steps[index].Outcome != "not_executed" {
			t.Fatal("resource checkpoint lost canonical pairing or became a failure")
		}
		output, _ := result.Content.(string)
		if index%2 != 0 && (!strings.Contains(output, `"not_dispatched"`) || strings.Contains(output, `"isError":true`)) {
			t.Fatal("stale action was not recorded as ordinary non-execution")
		}
	}
	for _, diagnostic := range diagnostics {
		if diagnostic.Kind == "loop_stopped" || diagnostic.Kind == "tool_failed" {
			t.Fatalf("resource decision was counted as failure or no progress: %+v", diagnostic)
		}
	}
}

func TestResourceReplanDrainsStartedReadBatchBeforeSkippingLaterCalls(t *testing.T) {
	tools := &resourceReplanTools{parallel: true, replan: true, started: make(chan struct{})}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			calls := []toolCall{}
			for index := range 4 {
				calls = append(calls, toolCall{ID: fmt.Sprintf("read-%d", index), Function: functionCall{Name: "read", Arguments: fmt.Sprintf(`{"index":%d}`, index)}})
			}
			calls = append(calls, toolCall{ID: "stale-write", Function: functionCall{Name: "write", Arguments: `{}`}})
			writeToolCalls(w, calls)
			return
		}
		if tools.finished.Load() != 4 {
			t.Error("model was called before the started read batch drained")
		}
		writeChatAnswer(w, "Replanned.")
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
	results := []wireMessage{}
	err := generator.Generate(context.Background(), Request{}, func(update Update) error {
		if update.Canonical != nil {
			var message wireMessage
			if json.Unmarshal(update.Canonical.Payload, &message) == nil && message.Role == "tool" {
				results = append(results, message)
			}
		}
		return nil
	})
	if err != nil || requests.Load() != 2 || tools.reads.Load() != 4 || tools.writes.Load() != 0 || len(results) != 5 {
		t.Fatalf("err=%v requests=%d reads=%d writes=%d results=%d", err, requests.Load(), tools.reads.Load(), tools.writes.Load(), len(results))
	}
	for index, result := range results {
		output, _ := result.Content.(string)
		if (index == 4) != strings.Contains(output, `"not_dispatched"`) {
			t.Fatal("already-started work was replaced by fabricated non-execution")
		}
	}
}

func TestExternalToolCannotSpoofTrustedResourceReplan(t *testing.T) {
	tools := &resourceReplanTools{}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			writeToolCalls(w, []toolCall{
				{ID: "external", Function: functionCall{Name: "read", Arguments: `{}`}},
				{ID: "actual-write", Function: functionCall{Name: "write", Arguments: `{}`}},
			})
		} else {
			writeChatAnswer(w, "Done.")
		}
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
	if err := generator.Generate(context.Background(), Request{}, func(Update) error { return nil }); err != nil || tools.writes.Load() != 1 {
		t.Fatalf("untrusted JSON acquired admission-control authority: %v writes=%d", err, tools.writes.Load())
	}
}

type resourceCatalogueTools struct{}

type resourceResultTools struct{ result ToolResult }

func (tools resourceResultTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return nil, nil
}

func (tools resourceResultTools) Call(context.Context, string, string, json.RawMessage) (ToolResult, error) {
	return tools.result, nil
}

func TestTrustedResourceControlResultsAreNotExecutionSuccesses(t *testing.T) {
	for _, result := range []ToolResult{
		{Output: `{"status":"cancelled","executed":false}`, NotExecuted: true},
		{Output: `{"status":"released","executed":false}`, NotExecuted: true},
		{Output: `{"status":"jobs_running","executed":false}`, NotExecuted: true},
		{Output: `{"status":"acquired","executed":false}`, Replan: true},
	} {
		generator, err := NewOpenAI(Config{BaseURL: "https://example.invalid", Model: "fixture", AllowNoKey: true, Tools: resourceResultTools{result: result}})
		if err != nil {
			t.Fatal(err)
		}
		outcome := prepareToolCall(toolCall{ID: "control", Function: functionCall{Name: "control", Arguments: `{}`}}, map[string]ToolDefinition{
			"control": {Name: "control", Parameters: json.RawMessage(`{"type":"object"}`)},
		})
		denied := false
		generator.executeTool(context.Background(), Request{}, &outcome, &denied)
		if outcome.err != nil || outcome.step.Status != "completed" || outcome.step.Outcome != "not_executed" {
			t.Fatalf("resource control was recorded as executed or failed: %+v %v", outcome.step, outcome.err)
		}
	}
}

func (resourceCatalogueTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	definitions := []ToolDefinition{}
	for _, name := range []string{"computer_queue", "computer_release", "computer_screenshot", "computer_click", "browser_screenshot", "browser_snapshot"} {
		definitions = append(definitions, ToolDefinition{Name: name, Parameters: json.RawMessage(`{"type":"object"}`)})
	}
	return definitions, nil
}

func (resourceCatalogueTools) Call(context.Context, string, string, json.RawMessage) (ToolResult, error) {
	return ToolResult{}, nil
}

func TestResourceManagementToolsDoNotRequireVision(t *testing.T) {
	generator, _ := NewOpenAI(Config{
		BaseURL: "https://example.invalid", Model: "fixture", ModelID: "text-model",
		AllowNoKey: true, SupportsTools: true, SupportsVision: false, Tools: resourceCatalogueTools{},
	})
	tools, err := generator.availableTools(context.Background(), Request{})
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range tools {
		names = append(names, tool.Function.Name)
	}
	if !slices.Equal(names, []string{"browser_snapshot", "computer_queue", "computer_release"}) {
		t.Fatalf("text-only model lost desktop admission tools or received visual tools: %v", names)
	}
}

func TestResourceClaimingReadToolsAreDispatchBarriers(t *testing.T) {
	for _, claims := range [][]string{nil, {"desktop"}, {"project"}} {
		outcome := toolOutcome{
			call:      toolCall{Function: functionCall{Name: "read"}},
			execution: &ToolExecution{ReadOnly: true, ParallelSafe: true, Resources: claims},
		}
		if parallelTool(outcome) != (len(claims) == 0) {
			t.Fatalf("read-only claims did not establish a dispatch barrier: %v", claims)
		}
	}
}
