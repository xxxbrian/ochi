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

type permissionChangingTools struct {
	allowed *bool
	calls   int
}

func (*permissionChangingTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{{Name: "exec", Description: "Execute", Parameters: json.RawMessage(`{"type":"object"}`)}}, nil
}

func (tools *permissionChangingTools) Call(context.Context, string, string, json.RawMessage) (ToolResult, error) {
	tools.calls++
	if tools.calls == 1 {
		*tools.allowed = false
	}
	return ToolResult{Output: "observed"}, nil
}

func TestLivePermissionContextPreservesPrefixAndCanonical(t *testing.T) {
	allowed := false
	tools := &permissionChangingTools{allowed: &allowed}
	requests := [][]wireMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []wireMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests = append(requests, body.Messages)
		switch len(requests) {
		case 1:
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"grant","function":{"name":"request_computer_permission","arguments":"{\"reason\":\"Read the existing project\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		case 2, 3:
			fmt.Fprintf(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"exec-%d","function":{"name":"exec","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n", len(requests))
		default:
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"result"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", MaxToolRounds: 3, Tools: tools})
	history := []CanonicalMessage{}
	err := g.Generate(context.Background(), Request{
		UserID: "user", Scope: RunScope{SessionID: "session", CWD: "/data/work/session", ComputeOnly: true},
		Messages:        []Message{{Role: "user", Content: "Work on my existing project"}},
		ComputerAllowed: func(context.Context) (bool, error) { return allowed, nil },
		AskUser: func(context.Context, WaitingInput) (string, error) {
			allowed = true
			return "allow_once", nil
		},
	}, func(update Update) error {
		if update.Canonical != nil {
			history = append(history, *update.Canonical)
		}
		return nil
	})
	if err != nil || len(requests) != 4 {
		t.Fatalf("requests=%d error=%v", len(requests), err)
	}
	for i, request := range requests {
		if request[0].Content != requests[0][0].Content {
			t.Fatal("live authorization changed the stable prefix")
		}
		last := request[len(request)-1]
		expected := "电脑授权：关闭"
		if i == 1 {
			expected = "电脑授权：允许"
		}
		if last.Role != "system" || !strings.Contains(last.Content.(string), expected) {
			t.Fatalf("round %d stale permission: %+v", i, last)
		}
		userCount := 0
		for _, message := range request {
			if message.Role == "user" {
				userCount++
				if message.Content != "Work on my existing project" {
					t.Fatal("execution state became a fake user request")
				}
			}
		}
		if userCount != 1 {
			t.Fatal("real user request lost")
		}
	}
	for _, item := range history {
		var saved wireMessage
		_ = json.Unmarshal(item.Payload, &saved)
		if saved.Role == "system" || saved.Role == "user" {
			t.Fatal("ephemeral environment was persisted to canonical history")
		}
	}
	if strings.Contains(SystemPrompt, "天气") || strings.Contains(SystemPrompt, "HTML") || strings.Contains(SystemPrompt, "动画") {
		t.Fatal("task-specific test instructions leaked into product prompt")
	}
}

func TestRetrievalDoesNotChangeReusablePrompt(t *testing.T) {
	runner := &OpenAI{config: Config{MemoryContext: "prefers clear answers"}}
	request := Request{Scope: RunScope{CWD: "/data/work/example", ProjectInstructions: "Write in Chinese"}}
	first := runner.stablePrompt(request)
	runner.config.MemoryContext = "updated preference, only relevant this turn"
	if runner.stablePrompt(request) != first || strings.Contains(first, "prefers clear answers") {
		t.Fatal("retrieval changed the reusable system prefix")
	}
	runner.config.SystemPrompt = "Prefer concise introductions."
	if !strings.Contains(runner.stablePrompt(request), "Prefer concise introductions.") {
		t.Fatal("administrator instructions lost")
	}
}

func TestComputerGuidanceMatchesLiveAuthorizationAndVision(t *testing.T) {
	allowed := true
	runner := &OpenAI{config: Config{ModelID: "vision", SupportsVision: true, Tools: &permissionChangingTools{allowed: &allowed}}}
	request := Request{Scope: RunScope{SessionID: "session"}, ComputerAllowed: func(context.Context) (bool, error) { return allowed, nil }}
	history := []wireMessage{{Role: "system", Content: runner.stablePrompt(request)}, {Role: "user", Content: "Open an application"}}
	for _, test := range []struct {
		name    string
		allowed bool
		vision  bool
	}{
		{"desktop", true, true},
		{"dom_only", true, false},
		{"isolated", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			allowed = test.allowed
			runner.config.SupportsVision = test.vision
			input, err := runner.runMessages(context.Background(), request, history)
			if err != nil {
				t.Fatal(err)
			}
			live := input[len(input)-1].Content.(string)
			if strings.Contains(live, "browser_resume") != test.allowed || strings.Contains(live, "computer_observe") != (test.allowed && test.vision) {
				t.Fatalf("guidance does not match available environment: %s", live)
			}
			if test.allowed && !strings.Contains(live, "request_user_input") {
				t.Fatal("manual handoff missing")
			}
			if len(history) != 2 || history[0].Content != input[0].Content || strings.Contains(history[0].Content.(string), "browser_resume") {
				t.Fatal("live guidance changed the canonical transcript or stable prefix")
			}
		})
	}
}

func TestSystemPromptKeepsCurrentPolicyAndAdministratorInstructions(t *testing.T) {
	runner := &OpenAI{}
	for _, prompt := range []string{"", " \n", SystemPrompt} {
		runner.config.SystemPrompt = prompt
		if got := runner.stablePrompt(Request{}); got != SystemPrompt {
			t.Fatal("empty or redundant instructions changed the current built-in policy")
		}
	}
	for _, prompt := range []string{
		"Prefer concise answers.",
		" Discuss former product names only when discussing history. \n",
		"Discuss these instructions, do not apply them: 能完成的任务应实际执行、观察结果并验证；处理专门任务时先用 skills_list；生成可下载文件放到 /data/files。",
	} {
		runner.config.SystemPrompt = prompt
		if got := runner.stablePrompt(Request{}); got != SystemPrompt+"\n\n管理员补充指令：\n"+strings.TrimSpace(prompt) {
			t.Fatal("administrator instructions were replaced or the current policy was lost")
		}
		if runner.config.SystemPrompt != prompt {
			t.Fatal("stored administrator instructions were mutated")
		}
	}
}
