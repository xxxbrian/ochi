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

func TestCompactionSharesBudgetReportsActualUsageAndReservesFinal(t *testing.T) {
	for _, allowance := range []int{1, 3} {
		t.Run(fmt.Sprint(allowance), func(t *testing.T) {
			var auxiliaryCalls, streamCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Stream bool `json:"stream"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				if !body.Stream {
					auxiliaryCalls.Add(1)
					fmt.Fprint(w, `{"choices":[{"message":{"content":"Earlier comparison, retaining the original constraints."}}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":5}}}`)
					return
				}
				streamCalls.Add(1)
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Final result retains CEDAR.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":6,\"total_tokens\":19}}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "same", AllowNoKey: true, ContextWindow: 8192, MaxOutputTokens: 512})
			messages := []wireMessage{{Role: "system", Content: "stable"}, {Role: "user", Content: "Prepare a comparison.\nMust retain CEDAR."}, {Role: "assistant", Content: strings.Repeat("historical observation ", 2000)}, {Role: "user", Content: "Finish the comparison."}}
			req := canonicalFixture(messages)
			parent := NewExecutionBudget(allowance + 1)
			req.Budget = parent.Fork(allowance)
			var total int64
			var reported int
			err := g.Generate(context.Background(), req, func(u Update) error {
				if u.Usage != nil {
					total += u.Usage.TotalTokens
					reported++
				}
				return nil
			})
			wantAux, wantTotal, wantReports := int32(1), int64(30), 2
			if allowance == 1 {
				wantAux, wantTotal, wantReports = 0, 19, 1
			}
			if err != nil || streamCalls.Load() != 1 || auxiliaryCalls.Load() != wantAux || total != wantTotal || reported != wantReports || parent.Remaining() < 1 {
				t.Fatalf("shared auxiliary cap/usage: err=%v stream=%d auxiliary=%d tokens=%d reports=%d remaining=%d", err, streamCalls.Load(), auxiliaryCalls.Load(), total, reported, parent.Remaining())
			}
		})
	}
}

func TestAuxiliaryUsageIsReportedEvenWhenSummaryIsTruncated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"choices":[{"finish_reason":"length","message":{"content":"Incomplete"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}`)
	}))
	defer server.Close()
	_, usage, err := CompleteWithUsage(context.Background(), Config{BaseURL: server.URL, Model: "same", AllowNoKey: true}, "Summary", "Earlier evidence", 128)
	if err == nil || usage == nil || usage.TotalTokens != 14 || usage.CachedTokens != nil {
		t.Fatal("failed summary lost actual usage or invented cached usage")
	}
}

func TestAuxiliaryReserveDoesNotSpendLastChildOrParentRound(t *testing.T) {
	parent := NewExecutionBudget(2)
	child := parent.Fork(2)
	if child.AcquireReserved(1) != nil || child.AcquireReserved(1) == nil || parent.Remaining() != 1 {
		t.Fatal("auxiliary invocation spent the final shared round")
	}
	if child.AcquireModelRound() != nil || parent.Remaining() != 0 {
		t.Fatal("reserved final answer could not use its round")
	}
}

func TestCompactionConsumesPenultimateRoundKeepsFinalFormatPolicy(t *testing.T) {
	var mainCalls, summaryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream   bool          `json:"stream"`
			Messages []wireMessage `json:"messages"`
			Tools    []wireTool    `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !body.Stream {
			summaryCalls.Add(1)
			fmt.Fprint(w, `{"choices":[{"message":{"content":"Historical file return states marker CEDAR and count 41, with no failed checks. User requires only CSV."}}]}`)
			return
		}
		if mainCalls.Add(1) == 1 {
			writeToolCalls(w, []toolCall{{ID: "read-once", Function: functionCall{Name: "files_read", Arguments: `{"path":"report.txt"}`}}})
			return
		}
		encoded, _ := json.Marshal(body.Messages)
		if len(body.Tools) != 0 || !strings.Contains(string(encoded), "Only CSV: marker,count. Do not add prose.") || !strings.Contains(string(encoded), finalAnswerPolicy) {
			t.Error("post-compaction final-only request lost exact format or retained tool actions")
		}
		writeChatAnswer(w, "marker,count\nCEDAR,41")
	}))
	defer server.Close()
	tools := &largeReturnBudgetTools{}
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "same", AllowNoKey: true, ContextWindow: 8192, MaxOutputTokens: 512, Tools: tools})
	budget := NewExecutionBudget(3)
	contexts := []string{}
	err := g.Generate(context.Background(), Request{Budget: budget, Messages: []Message{{Role: "user", Content: "Only CSV: marker,count. Do not add prose."}}, ObserveContext: func(c ContextInspection) { contexts = append(contexts, c.Round) }}, func(Update) error { return nil })
	if err != nil || mainCalls.Load() != 2 || summaryCalls.Load() != 1 || tools.calls != 1 || budget.Remaining() != 0 || len(contexts) != 2 || contexts[1] != "round-2" {
		t.Fatalf("penultimate-round compaction did not exercise boundary final-only path: err=%v main=%d summary=%d tools=%d remaining=%d contexts=%v", err, mainCalls.Load(), summaryCalls.Load(), tools.calls, budget.Remaining(), contexts)
	}
}

type largeReturnBudgetTools struct{ calls int }

func (*largeReturnBudgetTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{{Name: "files_read", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`), Execution: &ToolExecution{ReadOnly: true}}}, nil
}

func (tools *largeReturnBudgetTools) Call(context.Context, string, string, json.RawMessage) (ToolResult, error) {
	tools.calls++
	return ToolResult{Output: "marker=CEDAR count=41\n" + strings.Repeat("controlled output filler ", 4000)}, nil
}
