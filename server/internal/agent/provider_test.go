package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testTools struct{ calls int }

func (*testTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{{Name: "files_read", Description: "Read a file", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)}}, nil
}

func (tools *testTools) Call(_ context.Context, userID, name string, args json.RawMessage) (ToolResult, error) {
	if userID != "ochi-test" || name != "files_read" || string(args) != `{"path":"hello.txt"}` {
		return ToolResult{}, fmt.Errorf("wrong tool request")
	}
	tools.calls++
	return ToolResult{Output: "Hello from the workspace"}, nil
}

func TestStreamingToolRoundTrip(t *testing.T) {
	rounds := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("incorrect model request")
		}
		var request struct {
			Messages []wireMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		rounds++
		if rounds == 1 {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"files_read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"hello.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
		} else {
			last := request.Messages[len(request.Messages)-1]
			if last.Role != "tool" || last.ToolCallID != "call-1" || last.Content != "Hello from the workspace" {
				t.Error("tool result was not fed back to the model")
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"File read.\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	tools := &testTools{}
	generator, err := NewOpenAI(Config{BaseURL: server.URL, APIKey: "test-token", Model: "fixture", Tools: tools})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	var steps []Step
	err = generator.Generate(context.Background(), Request{UserID: "ochi-test", Messages: []Message{{Role: "user", Content: "Read hello.txt"}}}, func(update Update) error {
		output.WriteString(update.Text)
		if update.Step != nil {
			steps = append(steps, *update.Step)
		}
		return nil
	})
	if err != nil || output.String() != "File read." || tools.calls != 1 || len(steps) != 2 || steps[0].Status != "running" || steps[1].Status != "completed" {
		t.Fatalf("round trip: error=%v, text=%q, tool calls=%d, steps=%v", err, output.String(), tools.calls, steps)
	}
}

func TestIncompleteStreamIsNotSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "test-token", Model: "fixture"})
	err := generator.Generate(context.Background(), Request{}, func(Update) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "before completion") {
		t.Fatalf("expected interrupted stream error, got %v", err)
	}
}

type imageTools struct{}

func (imageTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{{Name: "files_read", Parameters: json.RawMessage(`{"type":"object"}`)}}, nil
}
func (imageTools) Call(context.Context, string, string, json.RawMessage) (ToolResult, error) {
	return ToolResult{Output: "observed", Screenshot: "data:image/png;base64,fixture"}, nil
}

func TestCanonicalToolImagesAndNextTurnPrefix(t *testing.T) {
	requests := [][]wireMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []wireMessage `json:"messages"`
			Effort   string        `json:"reasoning_effort"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if req.Effort != "high" {
			t.Errorf("effort = %q", req.Effort)
		}
		requests = append(requests, req.Messages)
		w.Header().Set("Content-Type", "text/event-stream")
		if len(requests) == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"intermediate","reasoning_content":"private protocol replay","tool_calls":[{"index":0,"id":"a","function":{"name":"files_read","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"files_read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		} else {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"final\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10,\"total_tokens\":110,\"prompt_tokens_details\":{\"cached_tokens\":80}}}\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	config := Config{BaseURL: server.URL, APIKey: "fixture", Model: "model", ModelID: "model-id", ProviderID: "provider-id", SupportsTools: true, SupportsVision: true, Effort: "high", EffortParameter: "reasoning_effort", EffortValue: json.RawMessage(`"high"`), Tools: imageTools{}}
	generator, _ := NewOpenAI(config)
	history := []CanonicalMessage{{Seq: 1, ModelID: config.ModelID, ProviderID: config.ProviderID, Payload: json.RawMessage(`{"role":"user","content":"look"}`)}}
	resets := 0
	seq := int64(1)
	usage := Usage{}
	emit := func(update Update) error {
		if update.Canonical != nil {
			seq++
			update.Canonical.Seq = seq
			copy := *update.Canonical
			copy.Payload = append(json.RawMessage(nil), copy.Payload...)
			history = append(history, copy)
		}
		if update.ResetOutput {
			resets++
		}
		if update.Usage != nil {
			usage = *update.Usage
		}
		return nil
	}
	if err := generator.Generate(context.Background(), Request{UserID: "ochi-test", History: history}, emit); err != nil {
		t.Fatal(err)
	}
	if resets != 1 || usage.CachedTokens == nil || *usage.CachedTokens != 80 {
		t.Fatalf("resets=%d usage=%+v", resets, usage)
	}
	got := requests[1]
	if len(got) != 6 || got[2].Role != "assistant" || got[3].Role != "tool" || got[3].ToolCallID != "a" || got[4].Role != "tool" || got[4].ToolCallID != "b" || got[5].Role != "user" {
		t.Fatalf("tool result/image order = %+v", got)
	}
	if got[2].ReasoningContent != "private protocol replay" {
		t.Fatal("native reasoning metadata lost")
	}
	history = append(history, CanonicalMessage{Seq: seq + 1, ModelID: config.ModelID, ProviderID: config.ProviderID, Payload: json.RawMessage(`{"role":"user","content":"continue"}`)})
	if err := generator.Generate(context.Background(), Request{UserID: "ochi-test", History: history}, func(Update) error { return nil }); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(requests[1])
	after, _ := json.Marshal(requests[2][:len(requests[1])])
	if string(before) != string(after) {
		t.Fatal("committed prefix changed between turns")
	}
}

func TestCompactionKeepsRepeatedReplyBoundary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"Saved task summary"}}]}`)
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", ContextWindow: 8192, MaxOutputTokens: 512})
	req := Request{}
	messages := []wireMessage{{Role: "system", Content: "Preserve the user's original constraints."}}
	for i := 0; i < 24; i++ {
		user := wireMessage{Role: "user", Content: fmt.Sprintf("Turn %d: %s", i, strings.Repeat("task context ", 80))}
		reply := wireMessage{Role: "assistant", Content: "Repeated acknowledgement"}
		for _, m := range []wireMessage{user, reply} {
			payload, _ := json.Marshal(m)
			req.History = append(req.History, CanonicalMessage{Seq: int64(len(req.History) + 1), Payload: payload})
			messages = append(messages, m)
		}
	}
	compacted, err := generator.compact(context.Background(), &req, messages, nil, func(Update) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if req.Compaction == nil || req.Compaction.ThroughSeq != 36 {
		t.Fatalf("boundary=%+v", req.Compaction)
	}
	if len(compacted) != 15 || compacted[1].Content != summaryMessage(req.Compaction.Summary).Content || compacted[3].Content != messages[37].Content {
		t.Fatalf("compacted tail or prefix changed: %d", len(compacted))
	}
}

func TestCompactionEmptyAuxiliaryResponseFallsBack(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if string(body["reasoning_effort"]) != `"none"` {
			t.Errorf("compression inherited main effort: %s", body["reasoning_effort"])
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"","reasoning_content":"budget consumed"}}]}`)
	}))
	defer server.Close()
	config := Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", ContextWindow: 8192, MaxOutputTokens: 512, Effort: "high", EffortParameter: "reasoning_effort", EffortValue: json.RawMessage(`"high"`), EffortMapping: map[string]json.RawMessage{"none": json.RawMessage(`"none"`)}}
	generator, _ := NewOpenAI(config)
	req := Request{}
	messages := []wireMessage{{Role: "system", Content: "Preserve the user's original constraints."}}
	for i := 0; i < 30; i++ {
		m := wireMessage{Role: "user", Content: fmt.Sprintf("目标 %d %s", i, strings.Repeat("retained work ", 90))}
		if i == 3 {
			m.Content = "已发布 /data/work/task/pelican.html /api/files/file-id?preview=1"
		}
		payload, _ := json.Marshal(m)
		req.History = append(req.History, CanonicalMessage{Seq: int64(i + 1), Payload: payload})
		messages = append(messages, m)
	}
	got, err := generator.compact(context.Background(), &req, messages, nil, func(Update) error { return nil })
	if err != nil || req.Compaction == nil || !strings.Contains(req.Compaction.Summary, "pelican.html") || len(got) >= len(messages) {
		t.Fatalf("fallback failed err=%v summary=%+v length=%d", err, req.Compaction, len(got))
	}
	if validToolBoundary([]wireMessage{{Role: "assistant", ToolCalls: []toolCall{{ID: "a"}}}, {Role: "tool", ToolCallID: "a"}}, 1) {
		t.Fatal("split tool call accepted")
	}
}

func TestAuxiliaryHeadersNoKeyAndBudgetEncoding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Provider") != "private-value" {
			t.Error("provider headers/no-key config ignored")
		}
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		if string(body["thinking"]) != `{"type":"enabled","budget_tokens":1024}` {
			t.Errorf("budget encoding %s", body["thinking"])
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"summary"}}]}`)
	}))
	defer server.Close()
	config := Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Headers: map[string]string{"X-Provider": "private-value"}, ReasoningKind: "budget", ReasoningBudget: 20000, ReasoningBudgetMin: 1024, EffortParameter: "thinking", EffortMapping: map[string]json.RawMessage{"budget": json.RawMessage(`{"type":"enabled","budget_tokens":"$budget"}`)}}
	text, err := Complete(context.Background(), config, "summarize", "history", 4096)
	if err != nil || text != "summary" {
		t.Fatalf("auxiliary error %v %s", err, text)
	}
}

func TestOperationLimitStillDeliversFinalReply(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls++
		if calls == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"done","function":{"name":"files_read","arguments":"{\"path\":\"hello.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		} else {
			if _, ok := body["tools"]; ok {
				t.Error("limit completion still has tools")
			}
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"已经读取文件。"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", MaxToolRounds: 1, Tools: &testTools{}})
	var text strings.Builder
	err := generator.Generate(context.Background(), Request{UserID: "ochi-test", Messages: []Message{{Role: "user", Content: "read file"}}}, func(update Update) error { text.WriteString(update.Text); return nil })
	if err != nil || text.String() != "已经读取文件。" || calls != 2 {
		t.Fatalf("limit delivery error=%v calls=%d text=%s", err, calls, text.String())
	}
}

func TestDeterministicSummaryKeepsMiddleResources(t *testing.T) {
	messages := []wireMessage{}
	for i := 0; i < 40; i++ {
		text := strings.Repeat("historical output ", 150)
		if i == 20 {
			text += " /data/work/example/pelican.html /api/files/real-file-id "
		}
		messages = append(messages, wireMessage{Role: "tool", ToolCallID: fmt.Sprint(i), Content: text})
	}
	summary := deterministicSummary(messages)
	if !strings.Contains(summary, "/data/work/example/pelican.html") || !strings.Contains(summary, "/api/files/real-file-id") {
		t.Fatal("fallback lost middle deliverable paths")
	}
}

func TestLongToolLoopKeepsRealUserRequestWithoutSyntheticReminders(t *testing.T) {
	requests := [][]wireMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []wireMessage `json:"messages"`
			Tools    []wireTool    `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests = append(requests, body.Messages)
		if len(body.Tools) == 0 {
			t.Error("general tool capabilities were removed")
		}
		if len(requests) <= 4 {
			fmt.Fprintf(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-%d","function":{"name":"files_read","arguments":"{\"path\":\"hello.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n", len(requests))
		} else {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"已完成。"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	tools := &testTools{}
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", Tools: tools})
	history := []CanonicalMessage{}
	err := generator.Generate(context.Background(), Request{UserID: "ochi-test", Messages: []Message{{Role: "user", Content: "Read a file"}}}, func(update Update) error {
		if update.Canonical != nil {
			history = append(history, *update.Canonical)
		}
		return nil
	})
	if err != nil || len(requests) != 5 || tools.calls != 4 {
		t.Fatalf("progress flow error=%v requests=%d tools=%d", err, len(requests), tools.calls)
	}
	last := requests[4]
	if last[len(last)-1].Role != "tool" {
		t.Fatal("completed tool pair is not the latest transcript entry")
	}
	for _, request := range requests {
		if request[0].Content != SystemPrompt {
			t.Fatal("tool iteration mutated stable system prefix")
		}
	}
	for _, item := range history {
		var saved wireMessage
		if err := json.Unmarshal(item.Payload, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Role == "user" || saved.Role == "system" {
			t.Fatal("tool loop added a synthetic instruction to canonical history")
		}
	}
}
