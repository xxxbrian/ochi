package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const cutoffChatUsage = `"usage":{"prompt_tokens":10,"completion_tokens":7,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":5}}`
const cutoffResponsesUsage = `"usage":{"input_tokens":10,"output_tokens":7,"total_tokens":17,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":5}}`

type cutoffCapture struct {
	text, reasoning strings.Builder
	usage           []*Usage
	canonical       int
	steps           int
	resets          int
}

func (c *cutoffCapture) emit(update Update) error {
	c.text.WriteString(update.Text)
	if update.Reasoning != nil {
		c.reasoning.WriteString(update.Reasoning.Text)
	}
	if update.Usage != nil {
		c.usage = append(c.usage, update.Usage)
	}
	if update.Canonical != nil {
		c.canonical++
	}
	if update.Step != nil {
		c.steps++
	}
	if update.ResetOutput {
		c.resets++
	}
	return nil
}

func assertCutoffUsage(t *testing.T, captured *cutoffCapture) {
	t.Helper()
	if len(captured.usage) != 1 {
		t.Fatalf("usage reports=%d, want one final cumulative snapshot", len(captured.usage))
	}
	u := captured.usage[0]
	if u.PromptTokens != 10 || u.CompletionTokens != 7 || u.TotalTokens != 17 || u.CachedTokens == nil || *u.CachedTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 5 {
		t.Fatalf("known usage lost or added twice: %+v", u)
	}
}

func assertCutoffClass(t *testing.T, err error, class string) {
	t.Helper()
	var model *ModelError
	if !errors.As(err, &model) || model.Class != class {
		t.Fatalf("error=%v, want %s", err, class)
	}
}

func TestChatTruncationPreservesTerminalDeltaAndTrailingUsage(t *testing.T) {
	for _, finalOnly := range []bool{false, true} {
		for _, test := range []struct {
			name, finish, class, trailer string
			inline                       bool
		}{
			{"length_usage_then_done", "length", "output_limit", "data: {" + cutoffChatUsage + ",\"choices\":[]}\n\ndata: [DONE]\n\n", false},
			{"filter_usage_then_done", "content_filter", "content_filter", "data: {" + cutoffChatUsage + ",\"choices\":[]}\n\ndata: [DONE]\n\n", false},
			{"inline_usage_eof", "length", "output_limit", "", true},
			{"inline_usage_bad_trailer", "length", "output_limit", "data: invalid-json\n\n", true},
		} {
			t.Run(fmt.Sprintf("%s/final=%t", test.name, finalOnly), func(t *testing.T) {
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					requests.Add(1)
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"prefix \",\"reasoning_content\":\"first \"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\n")
					usage := ""
					if test.inline {
						usage = "," + cutoffChatUsage
					}
					fmt.Fprintf(w, `data: {"choices":[{"delta":{"content":"last","reasoning_content":"tail","tool_calls":[{"index":0,"id":"not-safe","function":{"name":"files_read","arguments":"{\"path\":\"hello.txt\"}"}}]},"finish_reason":%q}]%s}`+"\n\n", test.finish, usage)
					// No output/tool fragments after a terminal choice may become visible.
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"must not show\"}}]}\n\n", test.trailer)
				}))
				defer server.Close()
				tools := &testTools{}
				g, err := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
				if err != nil {
					t.Fatal(err)
				}
				req := Request{UserID: "ochi-test"}
				if finalOnly {
					req.Budget = NewExecutionBudget(1)
				}
				captured := &cutoffCapture{}
				err = g.Generate(context.Background(), req, captured.emit)
				assertCutoffClass(t, err, test.class)
				assertCutoffUsage(t, captured)
				if captured.text.String() != "prefix last" || captured.reasoning.String() != "first tail" {
					t.Fatalf("last chunk lost or post-terminal delta leaked: text=%q reasoning=%q", captured.text.String(), captured.reasoning.String())
				}
				if requests.Load() != 1 || tools.calls != 0 || captured.canonical != 0 || captured.steps != 0 || captured.resets != 0 {
					t.Fatalf("truncated call committed, executed or retried: requests=%d tools=%d canonical=%d steps=%d resets=%d", requests.Load(), tools.calls, captured.canonical, captured.steps, captured.resets)
				}
			})
		}
	}
}

func TestResponsesTerminalPreservesUsageAndPublicSuffixWithoutExecutingIncompleteTools(t *testing.T) {
	for _, test := range []struct {
		name, event, status, detail, class string
	}{
		{"completed", "response.completed", "completed", "", ""},
		{"incomplete", "response.incomplete", "incomplete", `,"incomplete_details":{"reason":"max_output_tokens"}`, "output_limit"},
		{"incomplete_status_omitted", "response.incomplete", "", `,"incomplete_details":{"reason":"max_output_tokens"}`, "output_limit"},
		{"failed_billing", "response.failed", "failed", `,"error":{"code":"insufficient_quota","message":"billing"}`, "billing"},
		{"failed_unavailable", "response.failed", "", `,"error":{"code":"server_error","message":"unavailable"}`, "unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":0,\"delta\":\"Thinking\"}\n\n")
				fmt.Fprint(w, "data: {\"type\":\"response.reasoning_summary_text.done\"}\n\n")
				fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"prefix \"}\n\n")
				status, call := "", ""
				if test.status != "" {
					status = fmt.Sprintf(`"status":%q,`, test.status)
				}
				if test.class != "" {
					call = `,{"type":"function_call","call_id":"not-safe","name":"files_read","arguments":"{"}`
				}
				fmt.Fprintf(w, `data: {"type":%q,"response":{%s"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking tail"}]},{"type":"message","content":[{"type":"output_text","text":"prefix last"}]}%s],%s%s}}`+"\n\n", test.event, status, call, cutoffResponsesUsage, test.detail)
				w.(http.Flusher).Flush()
				// The terminal Responses event is self-contained. A provider that
				// holds its HTTP body open must not delay/error the finished result.
				<-r.Context().Done()
			}))
			defer server.Close()
			tools := &testTools{}
			g, err := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses", Tools: tools})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			captured := &cutoffCapture{}
			err = g.Generate(ctx, Request{UserID: "ochi-test"}, captured.emit)
			if test.class == "" {
				if err != nil || captured.canonical != 1 {
					t.Fatalf("completed response changed: err=%v canonical=%d", err, captured.canonical)
				}
			} else {
				assertCutoffClass(t, err, test.class)
				if captured.canonical != 0 {
					t.Fatal("incomplete Responses items were committed")
				}
			}
			assertCutoffUsage(t, captured)
			if captured.text.String() != "prefix last" || captured.reasoning.String() != "Thinking tail" || tools.calls != 0 || captured.steps != 0 || requests.Load() != 1 {
				t.Fatalf("terminal content/summary duplicated, dropped or replayed: text=%q reasoning=%q tools=%d steps=%d requests=%d", captured.text.String(), captured.reasoning.String(), tools.calls, captured.steps, requests.Load())
			}
		})
	}
}

func TestKnownUsageCallbackFailurePreservesInferenceErrorAndStopsSuccess(t *testing.T) {
	for _, finalOnly := range []bool{false, true} {
		for _, failed := range []bool{false, true} {
			t.Run(fmt.Sprintf("final=%t/failed=%t", finalOnly, failed), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					finish := "stop"
					if failed {
						finish = "length"
					}
					fmt.Fprintf(w, `data: {"choices":[{"delta":{"content":"known"},"finish_reason":%q}],%s}`+"\n\ndata: [DONE]\n\n", finish, cutoffChatUsage)
				}))
				defer server.Close()
				g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
				req := Request{}
				if finalOnly {
					req.Budget = NewExecutionBudget(1)
				}
				callbackErr := errors.New("usage checkpoint failed")
				captured := &cutoffCapture{}
				err := g.Generate(context.Background(), req, func(update Update) error {
					_ = captured.emit(update)
					if update.Usage != nil {
						return callbackErr
					}
					return nil
				})
				if failed {
					assertCutoffClass(t, err, "output_limit")
				} else if !errors.Is(err, callbackErr) {
					t.Fatalf("successful response ignored usage callback failure: %v", err)
				}
				assertCutoffUsage(t, captured)
				if captured.canonical != 0 {
					t.Fatal("committed an answer after failed usage checkpoint")
				}
			})
		}
	}
}

func TestChatTruncationUsageDrainHasGraceTimeoutAndCancellation(t *testing.T) {
	for _, mode := range []string{"grace", "client_timeout", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"last"},"finish_reason":"length"}],`+cutoffChatUsage+"}\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			defer server.Close()
			g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "client_timeout" {
				g.client.Timeout = 60 * time.Millisecond
			}
			if mode == "cancel" {
				timer := time.AfterFunc(60*time.Millisecond, cancel)
				defer timer.Stop()
			}
			captured := &cutoffCapture{}
			started := time.Now()
			err := g.Generate(ctx, Request{}, captured.emit)
			if mode == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("caller cancellation was hidden: %v", err)
				}
			} else {
				assertCutoffClass(t, err, "output_limit")
			}
			assertCutoffUsage(t, captured)
			if time.Since(started) > 3*time.Second || requests.Load() != 1 || captured.text.String() != "last" || captured.canonical != 0 {
				t.Fatalf("terminal drain hung/retried: elapsed=%s requests=%d canonical=%d", time.Since(started), requests.Load(), captured.canonical)
			}
		})
	}
}

func TestProviderStreamErrorKeepsKnownUsageAndClassificationAtEOF(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"error":{"code":"insufficient_quota","message":"billing"},`+cutoffChatUsage+"}\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
	captured := &cutoffCapture{}
	err := g.Generate(context.Background(), Request{}, captured.emit)
	assertCutoffClass(t, err, "billing")
	assertCutoffUsage(t, captured)
}

func TestCompletedChatReportsCumulativeTrailerUsageOnce(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":13}}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],"+cutoffChatUsage+"}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
	captured := &cutoffCapture{}
	err := g.Generate(context.Background(), Request{}, captured.emit)
	if err != nil || captured.canonical != 1 || captured.text.String() != "done" {
		t.Fatalf("completed response changed: err=%v canonical=%d text=%q", err, captured.canonical, captured.text.String())
	}
	assertCutoffUsage(t, captured)
}

func TestSafeStreamRetryAccountsForEachAttemptsKnownUsage(t *testing.T) {
	for _, protocol := range []string{"openai-chat", "openai-responses"} {
		for _, cancelRetry := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/cancel=%t", protocol, cancelRetry), func(t *testing.T) {
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					if requests.Add(1) == 1 {
						if protocol == "openai-responses" {
							fmt.Fprint(w, `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"unavailable"},`+cutoffResponsesUsage+"}}\n\n")
						} else {
							fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"total_tokens\":13}}\n\n")
							fmt.Fprint(w, `data: {"error":{"code":"server_error","message":"unavailable"},`+cutoffChatUsage+"}\n\n")
						}
						return
					}
					if protocol == "openai-responses" {
						fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],`+cutoffResponsesUsage+"}}\n\n")
					} else {
						fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],`+cutoffChatUsage+"}\n\ndata: [DONE]\n\n")
					}
				}))
				defer server.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: protocol, Observe: func(d Diagnostic) {
					if cancelRetry && d.Kind == "request_retry" {
						cancel()
					}
				}})
				captured := &cutoffCapture{}
				err := g.Generate(ctx, Request{}, captured.emit)
				if cancelRetry {
					if !errors.Is(err, context.Canceled) || requests.Load() != 1 || captured.canonical != 0 || captured.text.Len() != 0 {
						t.Fatalf("backoff cancellation changed: err=%v requests=%d canonical=%d text=%q", err, requests.Load(), captured.canonical, captured.text.String())
					}
					assertCutoffUsage(t, captured)
					return
				}
				if err != nil || requests.Load() != 2 || captured.canonical != 1 || captured.text.String() != "done" || len(captured.usage) != 1 {
					t.Fatalf("safe retry changed: err=%v requests=%d canonical=%d text=%q usage=%d", err, requests.Load(), captured.canonical, captured.text.String(), len(captured.usage))
				}
				u := captured.usage[0]
				if u.PromptTokens != 20 || u.CompletionTokens != 14 || u.TotalTokens != 34 || u.CachedTokens == nil || *u.CachedTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 10 {
					t.Fatalf("attempt usage lost or cumulative chunks counted twice: %+v", u)
				}
			})
		}
	}
}
