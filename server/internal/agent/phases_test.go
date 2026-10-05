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

func TestChatPublicTextIsPendingBeforeAToolCallArrives(t *testing.T) {
	for _, withTools := range []bool{false, true} {
		t.Run(fmt.Sprintf("tools=%t", withTools), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Inspecting "}}]}`+"\n\n")
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"the input."}}]}`+"\n\n")
				if withTools {
					fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"files_read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\n")
				} else {
					fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer server.Close()
			g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
			var tools []wireTool
			kind := "final"
			if withTools {
				tools = []wireTool{{Type: "function", Function: ToolDefinition{Name: "files_read"}}}
				kind = "pending"
			}
			var updates []Update
			message, _, err := g.streamChat(context.Background(), nil, tools, "round-1", func(update Update) error {
				updates = append(updates, update)
				return nil
			})
			if err != nil || message.Content != "Inspecting the input." || len(updates) != 2 {
				t.Fatalf("public stream: message=%+v updates=%+v err=%v", message, updates, err)
			}
			for _, update := range updates {
				if update.TextKind != kind {
					t.Fatalf("public text was exposed before its role was known: %+v", update)
				}
			}
			if withTools && len(message.ToolCalls) != 1 {
				t.Fatalf("canonical tool preamble lost its call: %+v", message)
			}
		})
	}
}

func TestResponsesPhasesKeepCommentarySeparateFromFinalText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"comment-1","phase":"commentary"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","output_index":0,"item_id":"comment-1","content_index":0,"delta":"Inspecting "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"comment-1","content":[{"type":"output_text","text":"Inspecting the input."}]}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"answer-1","phase":"final_answer"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","output_index":1,"item_id":"answer-1","content_index":0,"delta":"Answer"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","id":"comment-1","content":[{"type":"output_text","text":"Inspecting the input."}],"provider_field":"retained"},{"type":"message","id":"answer-1","content":[{"type":"output_text","text":"Answer!"}]}]}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	var updates []Update
	message, _, err := g.streamResponses(context.Background(), nil, nil, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil || message.Content != "Answer!" || len(updates) != 4 {
		t.Fatalf("phase separation: message=%+v updates=%+v err=%v", message, updates, err)
	}
	if updates[0].TextKind != "progress" || updates[1].TextKind != "progress" || updates[0].TextID != updates[1].TextID || updates[0].Text+updates[1].Text != "Inspecting the input." {
		t.Fatalf("commentary lost its phase or stable identity: %+v", updates)
	}
	if updates[2].TextKind != "final" || updates[3].TextKind != "final" || updates[2].TextID != updates[3].TextID || updates[2].TextID == updates[0].TextID || updates[2].Text+updates[3].Text != "Answer!" {
		t.Fatalf("explicit final answer stopped streaming independently: %+v", updates)
	}
	for _, preserved := range []string{"commentary", "final_answer", `"provider_field":"retained"`} {
		if !strings.Contains(string(message.ResponsesItems), preserved) {
			t.Fatalf("canonical replay lost %q: %s", preserved, message.ResponsesItems)
		}
	}
}

func TestResponsesLatePhaseResolvesTheExistingPublicItem(t *testing.T) {
	for _, withTools := range []bool{false, true} {
		for _, phase := range []string{"commentary", "final_answer"} {
			t.Run(fmt.Sprintf("tools=%t/phase=%s", withTools, phase), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					fmt.Fprint(w, `data: {"type":"response.output_text.delta","output_index":2,"content_index":0,"delta":"First "}`+"\n\n")
					fmt.Fprintf(w, `data: {"type":"response.output_item.done","output_index":2,"item":{"type":"message","id":"public-1","phase":%q,"content":[{"type":"output_text","text":"First last"}]}}`+"\n\n", phase)
					fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed"}}`+"\n\n")
				}))
				defer server.Close()
				g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
				var tools []wireTool
				kind := "final"
				if withTools {
					tools = []wireTool{{Type: "function", Function: ToolDefinition{Name: "files_read"}}}
					kind = "pending"
				}
				var updates []Update
				message, _, err := g.streamResponses(context.Background(), nil, tools, "round-1", func(update Update) error {
					updates = append(updates, update)
					return nil
				})
				if err != nil || len(updates) < 2 || updates[0].Text != "First " || updates[0].TextKind != kind {
					t.Fatalf("initial classification: message=%+v updates=%+v err=%v", message, updates, err)
				}
				if phase == "commentary" {
					if len(updates) != 3 || updates[1].Text != "" || updates[1].TextKind != "progress" || updates[2].Text != "last" || updates[2].TextKind != "progress" || message.Content != "" {
						t.Fatalf("late commentary duplicated or leaked into final: message=%+v updates=%+v", message, updates)
					}
				} else if len(updates) != 2 || updates[1].TextKind != kind || updates[1].Text != "last" || message.Content != "First last" {
					t.Fatalf("late final answer was replayed or prematurely promoted: message=%+v updates=%+v", message, updates)
				}
				for _, update := range updates {
					if update.TextID == "" || update.TextID != updates[0].TextID {
						t.Fatalf("phase resolution changed the public item identity: %+v", updates)
					}
				}
			})
		}
	}
}

func TestResponsesIncompleteUnclassifiedTextRemainsPending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","delta":"Partial "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"Partial text"}]}]}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	tools := []wireTool{{Type: "function", Function: ToolDefinition{Name: "files_read", Parameters: json.RawMessage(`{"type":"object"}`)}}}
	var updates []Update
	_, _, err := g.streamResponses(context.Background(), nil, tools, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	assertCutoffClass(t, err, "output_limit")
	if len(updates) != 2 || updates[0].Text+updates[1].Text != "Partial text" {
		t.Fatalf("incomplete public suffix lost or replayed: %+v", updates)
	}
	for _, update := range updates {
		if update.TextKind != "pending" || update.CommitOutput {
			t.Fatalf("incomplete text falsely promoted: %+v", update)
		}
	}
}

func TestResponsesItemIDsSeparateUnindexedDeltas(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","item_id":"comment-1","delta":"Inspecting"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","item_id":"answer-1","delta":"Answer"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","id":"comment-1","phase":"commentary","content":[{"type":"output_text","text":"Inspecting"}]},{"type":"message","id":"answer-1","phase":"final_answer","content":[{"type":"output_text","text":"Answer"}]}]}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	tools := []wireTool{{Type: "function", Function: ToolDefinition{Name: "files_read"}}}
	var updates []Update
	message, _, err := g.streamResponses(context.Background(), nil, tools, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil || message.Content != "Answer" || len(updates) != 3 || updates[0].TextID == updates[1].TextID || updates[2].TextID != updates[0].TextID || updates[2].TextKind != "progress" || updates[2].Text != "" {
		t.Fatalf("unindexed items merged or replayed: message=%+v updates=%+v err=%v", message, updates, err)
	}
}
