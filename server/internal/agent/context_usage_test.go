package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestContextBudgetAnchorsActualInputAndEstimatesOnlyGrowth(t *testing.T) {
	g := &OpenAI{config: Config{Model: "fixture", ModelID: "owned-model", Protocol: "openai", ContextWindow: 32768}}
	history := []wireMessage{{Role: "system", Content: "Stable rules"}, {Role: "user", Content: strings.Repeat("text ", 100)}}
	tools := []wireTool{{Type: "function", Function: ToolDefinition{Name: "read", Parameters: json.RawMessage(`{"type":"object"}`)}}}
	heuristic := g.budgetForInput(history, history, tools)
	for _, actual := range []int64{100, 2400} {
		g.recordContextUsage(history, history, tools, &Usage{PromptTokens: actual, CompletionTokens: 99000, TotalTokens: 199000})
		budget := g.budgetForInput(history, history, tools)
		if budget.EstimateSource != "provider_usage" || budget.InputTokens != int(actual) || budget.HeuristicInputTokens != heuristic.InputTokens {
			t.Fatalf("measured input was replaced by heuristic/billable total: %+v", budget)
		}
		grown := append(append([]wireMessage(nil), history...), wireMessage{Role: "assistant", Content: "New output"}, wireMessage{Role: "user", Content: "Continue"})
		budget = g.budgetForInput(grown, grown, tools)
		growth := budget.HeuristicInputTokens - heuristic.InputTokens
		want := int(actual) + growth + (growth+9)/10
		if budget.InputTokens != want || growth <= 0 {
			t.Fatalf("appended input was not estimated from measured prefix: %+v want %d", budget, want)
		}
	}
	g.recordContextUsage(history, history, tools, &Usage{PromptTokens: 350})
	if got := g.budgetForInput(history, history, tools); got.UsageAnchorTokens != 350 {
		t.Fatal("last actual request was added to previous usage instead of replacing it")
	}
}

func TestContextUsageInvalidatesChangedInputIdentity(t *testing.T) {
	for _, change := range []string{"model", "protocol", "tool", "rewrite", "compact", "system", "dynamic"} {
		t.Run(change, func(t *testing.T) {
			g := &OpenAI{config: Config{Model: "fixture", Protocol: "openai"}}
			history := []wireMessage{{Role: "system", Content: "Rules"}, {Role: "user", Content: "Question"}}
			tools := []wireTool{{Type: "function", Function: ToolDefinition{Name: "read"}}}
			input := append(append([]wireMessage(nil), history...), wireMessage{Role: "system", Content: "current task", contextSignature: "task-1"})
			g.recordContextUsage(history, input, tools, &Usage{PromptTokens: 400})
			switch change {
			case "model":
				g.config.Model = "other"
			case "protocol":
				g.config.Protocol = "openai-responses"
			case "tool":
				tools[0].Function.Name = "write"
			case "rewrite":
				history[1].Content = "Revised question"
				input[1] = history[1]
			case "compact":
				history = history[:1]
				input = append(append([]wireMessage(nil), history...), input[2])
			case "system":
				history[0].Content = "Changed rules"
				input[0] = history[0]
			case "dynamic":
				input[2].contextSignature = "task-2"
			}
			if got := g.budgetForInput(history, input, tools); got.EstimateSource != "heuristic" || got.UsageAnchorTokens != 0 {
				t.Fatalf("stale measurement applied after %s: %+v", change, got)
			}
		})
	}
}

func TestContextClockDoesNotInvalidateSemanticAnchor(t *testing.T) {
	g := &OpenAI{config: Config{MemoryContext: "User background"}}
	history := []wireMessage{{Role: "system", Content: "Rules"}, {Role: "user", Content: "Question"}}
	input, err := g.runMessages(context.Background(), Request{Timezone: "UTC", TaskContext: "Task one"}, history)
	if err != nil {
		t.Fatal(err)
	}
	g.recordContextUsage(history, input, nil, &Usage{PromptTokens: 700})
	next := append([]wireMessage(nil), input...)
	last := len(next) - 1
	next[last].Content = strings.Replace(next[last].Content.(string), "当前本地时间：", "当前本地时间： ", 1)
	if got := g.budgetForInput(history, next, nil); got.EstimateSource != "provider_usage" {
		t.Fatal("a changing clock discarded actual input usage")
	}
	changed, _ := g.runMessages(context.Background(), Request{Timezone: "UTC", TaskContext: "Task two"}, history)
	if got := g.budgetForInput(history, changed, nil); got.EstimateSource != "heuristic" {
		t.Fatal("different task context inherited an unrelated measurement")
	}
	g.config.MemoryContext = "Changed background"
	changed, _ = g.runMessages(context.Background(), Request{Timezone: "UTC", TaskContext: "Task one"}, history)
	if got := g.budgetForInput(history, changed, nil); got.EstimateSource != "heuristic" {
		t.Fatal("changed retrieved memory inherited an unrelated measurement")
	}
}

func TestStreamContextAnchorExcludesRetryBilling(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":900,\"completion_tokens\":0,\"total_tokens\":900}}\n\n")
			fmt.Fprint(w, "data: {\"error\":{\"code\":\"server_error\",\"message\":\"retry\"}}\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":600,\"completion_tokens\":2,\"total_tokens\":602}}\n\n")
		writeChatAnswer(w, "done")
	}))
	defer provider.Close()
	g, _ := NewOpenAI(Config{BaseURL: provider.URL, Model: "fixture", AllowNoKey: true})
	history := []wireMessage{{Role: "user", Content: "Question"}}
	_, usage, err := g.streamRun(context.Background(), Request{Budget: NewExecutionBudget(3)}, history, nil, "round-1", func(Update) error { return nil })
	if err != nil || requests.Load() != 2 || usage == nil || usage.PromptTokens != 1500 {
		t.Fatalf("retry fixture: requests=%d usage=%+v err=%v", requests.Load(), usage, err)
	}
	budget := g.budgetForInput(history, history, nil)
	if budget.UsageAnchorTokens != 600 || budget.InputTokens != 600 {
		t.Fatalf("context used billable aggregate instead of the final actual request: %+v", budget)
	}
}

func TestMeasuredImageContextAndNextRoundInspection(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":800,\"completion_tokens\":10,\"total_tokens\":810}}\n\n")
		if requests.Add(1) == 1 {
			writeToolCalls(w, []toolCall{{ID: "read", Function: functionCall{Name: "files_read", Arguments: `{"path":"hello.txt"}`}}})
		} else {
			writeChatAnswer(w, "done")
		}
	}))
	defer provider.Close()
	g, _ := NewOpenAI(Config{BaseURL: provider.URL, Model: "fixture", AllowNoKey: true, ContextWindow: 32768, Tools: &testTools{}})
	var inspections []ContextInspection
	err := g.Generate(context.Background(), Request{
		UserID:         "ochi-test",
		History:        []CanonicalMessage{{Payload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"Inspect this fixture"},{"type":"image_url","image_url":{"url":"data:image/png;base64,fixture"}}]}`)}},
		ObserveContext: func(value ContextInspection) { inspections = append(inspections, value) },
	}, func(Update) error { return nil })
	if err != nil || len(inspections) != 2 || inspections[0].Budget.EstimateSource != "heuristic" || inspections[1].Budget.EstimateSource != "provider_usage" {
		t.Fatalf("next real request did not use its prior measured input: err=%v inspections=%+v", err, inspections)
	}
	budget := inspections[1].Budget
	if budget.UsageAnchorTokens != 800 || budget.InputTokens <= 800 || budget.InputTokens >= budget.HeuristicInputTokens {
		t.Fatalf("fixed image estimate did not yield to actual input plus new tool evidence: %+v", budget)
	}
}

func TestGenerateKeepsUsageMeasurementsRunLocal(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1500,\"completion_tokens\":2,\"total_tokens\":1502}}\n\n")
		writeChatAnswer(w, "done")
	}))
	defer provider.Close()
	g, _ := NewOpenAI(Config{BaseURL: provider.URL, Model: "fixture", AllowNoKey: true})
	var mu sync.Mutex
	var budgets []ContextBudget
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := g.Generate(context.Background(), Request{Messages: []Message{{Role: "user", Content: "Question"}}, ObserveContext: func(value ContextInspection) {
				mu.Lock()
				budgets = append(budgets, value.Budget)
				mu.Unlock()
			}}, func(Update) error { return nil })
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(budgets) != 3 || g.usageAnchor != nil {
		t.Fatal("shared generator retained run-local usage")
	}
	for _, budget := range budgets {
		if budget.EstimateSource != "heuristic" {
			t.Fatal("one run inherited another run's measured input")
		}
	}
}
