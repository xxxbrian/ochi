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

func TestReasoningReopenedAfterPublicOutputGetsANewOccurrence(t *testing.T) {
	parts := []ReasoningPart{}
	stream := newReasoningStream("round-1", func(update Update) error {
		parts = append(parts, *update.Reasoning)
		return nil
	})
	_ = stream.delta("reasoning", "First thought")
	_ = stream.done() // provider starts public output at this boundary
	_ = stream.delta("reasoning", "Second thought")
	_ = stream.delta("reasoning", " continues")
	_ = stream.done()
	if len(parts) != 5 || parts[0].ID != "round-1:reasoning" || parts[1].ID != parts[0].ID ||
		parts[2].ID != "round-1:reasoning:segment-2" || parts[3].ID != parts[2].ID || parts[4].ID != parts[2].ID || !parts[4].Done {
		t.Fatalf("later thought would overwrite an earlier chronological position: %+v", parts)
	}
}

func TestReturnedReasoningStaysSeparateAndReplayable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `data: {"choices":[{"delta":{"reasoning_content":"Checking "}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"reasoning_content":"the input.","reasoning_details":[{"type":"reasoning.encrypted","data":"opaque-private-value"}]}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture"})
	var answer, reasoning strings.Builder
	var saved wireMessage
	done := false
	err := g.Generate(context.Background(), Request{}, func(update Update) error {
		answer.WriteString(update.Text)
		if update.Reasoning != nil {
			reasoning.WriteString(update.Reasoning.Text)
			done = update.Reasoning.Done
		}
		if update.Canonical != nil {
			_ = json.Unmarshal(update.Canonical.Payload, &saved)
		}
		return nil
	})
	if err != nil || answer.String() != "42" || reasoning.String() != "Checking the input." || !done {
		t.Fatalf("reasoning stream: err=%v answer=%q reasoning=%q done=%v", err, answer.String(), reasoning.String(), done)
	}
	if saved.ReasoningContent != reasoning.String() || !strings.Contains(string(saved.ReasoningDetails), "opaque-private-value") {
		t.Fatal("provider replay state was lost")
	}
	merged := appendReasoningDetails(json.RawMessage(`[{"type":"reasoning.text","text":"One "}]`), json.RawMessage(`[{"type":"reasoning.text","text":"two","signature":"signed"},{"type":"reasoning.encrypted","data":"opaque"}]`))
	if !strings.Contains(string(merged), `"text":"One two"`) || !strings.Contains(string(merged), `"signature":"signed"`) || len(returnedReasoningDetails(merged)) != 1 {
		t.Fatalf("plaintext detail merge/private filtering: %s", merged)
	}
}

func TestEnvironmentDoesNotReplaceLatestUserRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []wireMessage `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		lastUser := wireMessage{}
		for _, message := range body.Messages {
			if message.Role == "user" {
				lastUser = message
			}
		}
		if lastUser.Content != "你好，仅回答你好。" {
			t.Errorf("synthetic environment replaced latest user request: %+v", lastUser)
		}
		first, _ := body.Messages[0].Content.(string)
		last := body.Messages[len(body.Messages)-1]
		if last.Role != "system" || !strings.Contains(last.Content.(string), "当前执行环境") || !strings.Contains(first, "已停止或失败的任务不自行恢复") {
			t.Error("environment and stopped-turn rules were not system context")
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture"})
	history := []CanonicalMessage{
		{Payload: json.RawMessage(`{"role":"user","content":"旧硬币任务"}`)},
		{Payload: json.RawMessage(`{"role":"assistant","content":"上一轮已停止，不再自动执行。"}`)},
		{Payload: json.RawMessage(`{"role":"user","content":"你好，仅回答你好。"}`)},
	}
	err := g.Generate(context.Background(), Request{Scope: RunScope{SessionID: "test", ComputeOnly: true}, History: history}, func(Update) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}

func TestResponsesToolsImagesAndReasoningSummaryReplay(t *testing.T) {
	round := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("wrong protocol path: %s", r.URL.Path)
		}
		var body struct {
			Store     bool              `json:"store"`
			Input     []json.RawMessage `json:"input"`
			Reasoning struct {
				Effort  string `json:"effort"`
				Summary string `json:"summary"`
			} `json:"reasoning"`
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Store || body.Reasoning.Summary != "auto" || body.Reasoning.Effort != "high" || len(body.Tools) == 0 || body.Tools[0].Name == "" {
			t.Errorf("bad Responses request: %+v", body)
		}
		round++
		w.Header().Set("Content-Type", "text/event-stream")
		if round == 1 {
			if !strings.Contains(string(body.Input[len(body.Input)-1]), `"type":"input_image"`) {
				t.Error("image part was not translated")
			}
			fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"Read the requested file."}`+"\n\n")
			fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"rs-1","type":"reasoning","summary":[{"type":"summary_text","text":"Read the requested file."}],"encrypted_content":"opaque-replay"},{"id":"fn-1","type":"function_call","call_id":"call-1","name":"files_read","arguments":"{\"path\":\"hello.txt\"}"}]}}`+"\n\n")
		} else {
			input, _ := json.Marshal(body.Input)
			if !strings.Contains(string(input), "opaque-replay") || !strings.Contains(string(input), `"type":"function_call_output"`) || !strings.Contains(string(input), "Hello from the workspace") {
				t.Errorf("native/tool replay was lost: %s", input)
			}
			fmt.Fprint(w, `data: {"type":"response.output_text.delta","delta":"File read."}`+"\n\n")
			fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"msg-1","type":"message","role":"assistant","phase":"final_answer","status":"completed","content":[{"type":"output_text","text":"File read."}]}],"usage":{"input_tokens":30,"output_tokens":9,"total_tokens":39,"output_tokens_details":{"reasoning_tokens":4}}}}`+"\n\n")
		}
	}))
	defer server.Close()
	tools := &testTools{}
	g, _ := NewOpenAI(Config{BaseURL: server.URL, APIKey: "fixture", Model: "fixture", Protocol: "openai-responses", Tools: tools, ReasoningKind: "effort", Effort: "high", EffortParameter: "reasoning_effort", EffortValue: json.RawMessage(`"high"`)})
	history := []CanonicalMessage{{Payload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"Read hello.txt"},{"type":"image_url","image_url":{"url":"data:image/png;base64,fixture"}}]}`)}}
	var answer, summary strings.Builder
	var saved wireMessage
	err := g.Generate(context.Background(), Request{UserID: "ochi-test", History: history}, func(update Update) error {
		answer.WriteString(update.Text)
		if update.Reasoning != nil {
			if update.Reasoning.Kind != "summary" {
				t.Error("summary incorrectly labelled raw thinking")
			}
			summary.WriteString(update.Reasoning.Text)
		}
		if update.Canonical != nil {
			_ = json.Unmarshal(update.Canonical.Payload, &saved)
		}
		return nil
	})
	if err != nil || answer.String() != "File read." || summary.String() != "Read the requested file." || tools.calls != 1 || !strings.Contains(string(saved.ResponsesItems), "final_answer") {
		t.Fatalf("Responses roundtrip: err=%v answer=%q summary=%q tools=%d saved=%s", err, answer.String(), summary.String(), tools.calls, saved.ResponsesItems)
	}
}

func TestChatReasoningWireFixturesPreservePartsAndReplay(t *testing.T) {
	// These are wire-shape fixtures, not model-name rules. A relay can expose
	// any supported model through any one of these explicitly returned fields.
	for _, fixture := range []struct {
		name   string
		deltas []string
		parts  []ReasoningPart
	}{
		{
			name: "deepseek/plain-continuous-string",
			deltas: []string{
				`{"reasoning_content":"First "}`,
				`{"reasoning_content":"thought."}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "First thought."}},
		},
		{
			name: "grok/mirrored-string-aliases",
			deltas: []string{
				`{"reasoning_content":"Same ","reasoning":"Same "}`,
				`{"reasoning_content":"thought.","reasoning":"thought."}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "Same thought."}},
		},
		{
			name: "glm/structured-detail-and-mirrored-alias",
			deltas: []string{
				`{"reasoning_content":"Full ","reasoning_details":[{"type":"reasoning.text","id":"full-1","index":0,"text":"Full "},{"type":"reasoning.encrypted","id":"private-1","data":"opaque-private-value"}]}`,
				`{"reasoning_content":"thought.","reasoning_summary":"Short plan.","reasoning_details":[{"type":"reasoning.text","index":0,"text":"thought.","signature":"signed-private-value"},{"type":"reasoning.summary","id":"summary-1","index":1,"summary":"Short plan."}]}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "Full thought."}, {Kind: "summary", Text: "Short plan."}},
		},
		{
			name: "gemini/typed-reasoning-array",
			deltas: []string{
				`{"reasoning":[{"type":"reasoning.summary","id":"summary-1","index":0,"summary":"Plan "},{"type":"reasoning.text","id":"full-1","index":1,"text":"Detailed "}]}`,
				`{"reasoning_summary":"ready.","reasoning":[{"type":"reasoning.summary","id":"summary-1","summary":"ready."},{"type":"reasoning.text","index":1,"text":"thought."}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "Plan ready."}, {Kind: "reasoning", Text: "Detailed thought."}},
		},
		{
			name: "gpt/multiple-summary-identities",
			deltas: []string{
				`{"reasoning_details":[{"type":"reasoning.summary","id":"summary-a","index":0,"summary":"**First "},{"type":"reasoning.summary","id":"summary-b","index":1,"summary":"**Second "}]}`,
				`{"reasoning_summary":"title**title**","reasoning_details":[{"type":"reasoning.summary","index":0,"summary":"title**"},{"type":"reasoning.summary","index":1,"summary":"title**"}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "**First title**"}, {Kind: "summary", Text: "**Second title**"}},
		},
		{
			name: "different-channels-are-not-discarded",
			deltas: []string{
				`{"reasoning_content":"Plain thought.","reasoning":"Another thought.","reasoning_details":[{"type":"reasoning.text","id":"detail-1","index":0,"text":"Structured thought."}]}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "Structured thought."}, {Kind: "reasoning", Text: "Another thought."}, {Kind: "reasoning", Text: "Plain thought."}},
		},
		{
			name: "later-identical-text-is-not-assumed-an-alias",
			deltas: []string{
				`{"reasoning_content":"Repeated title"}`,
				`{"reasoning_details":[{"type":"reasoning.text","id":"new-part","index":1,"text":"Repeated title"}]}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "Repeated title"}, {Kind: "reasoning", Text: "Repeated title"}},
		},
		{
			name: "unidentified-summary-array-retains-members",
			deltas: []string{
				`{"reasoning_summary":[{"type":"summary_text","text":"First title"},{"type":"summary_text","text":"Second title"}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "First title"}, {Kind: "summary", Text: "Second title"}},
		},
		{
			name: "identity-metadata-can-precede-plaintext",
			deltas: []string{
				`{"reasoning_details":[{"type":"reasoning.summary","id":"summary-1","index":2}]}`,
				`{"reasoning_details":[{"type":"reasoning.summary","summary":"First "}]}`,
				`{"reasoning_details":[{"type":"reasoning.summary","id":"summary-1","index":2,"summary":"title"}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "First title"}},
		},
		{
			name: "same-frame-mirror-does-not-reuse-old-source-position",
			deltas: []string{
				`{"reasoning_content":"First "}`,
				`{"reasoning_content":"second","reasoning_details":[{"type":"reasoning.text","id":"r","index":0,"text":"second"}]}`,
				`{"reasoning_content":" third"}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "First "}, {Kind: "reasoning", Text: "second"}, {Kind: "reasoning", Text: " third"}},
		},
		{
			name: "mirror-does-not-bridge-distinct-explicit-identities",
			deltas: []string{
				`{"reasoning_content":"First","reasoning_details":[{"type":"reasoning.text","id":"a","index":0,"text":"First"}]}`,
				`{"reasoning_content":"Second","reasoning_details":[{"type":"reasoning.text","id":"b","index":1,"text":"Second"}]}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "First"}, {Kind: "reasoning", Text: "Second"}},
		},
		{
			name: "same-id-distinct-indices-are-separate",
			deltas: []string{
				`{"reasoning_details":[{"type":"reasoning.summary","id":"r","index":0,"summary":"First"}]}`,
				`{"reasoning_details":[{"type":"reasoning.summary","id":"r","index":1,"summary":"Second"}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "First"}, {Kind: "summary", Text: "Second"}},
		},
		{
			name: "mirror-moves-anonymous-continuation-forward",
			deltas: []string{
				`{"reasoning_content":"A"}`,
				`{"reasoning_details":[{"type":"reasoning.text","id":"d","index":0,"text":"B"}]}`,
				`{"reasoning_content":"C","reasoning_details":[{"type":"reasoning.text","id":"d","index":0,"text":"C"}]}`,
				`{"reasoning_content":"D"}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "A"}, {Kind: "reasoning", Text: "BC"}, {Kind: "reasoning", Text: "D"}},
		},
		{
			name: "mixed-kinds-retain-array-order",
			deltas: []string{
				`{"reasoning_details":[{"type":"reasoning.summary","id":"s1","index":0,"summary":"First"},{"type":"reasoning.text","id":"r1","index":1,"text":"Second"},{"type":"reasoning.summary","id":"s2","index":2,"summary":"Third"}]}`,
			},
			parts: []ReasoningPart{{Kind: "summary", Text: "First"}, {Kind: "reasoning", Text: "Second"}, {Kind: "summary", Text: "Third"}},
		},
		{
			name: "mirrored-text-with-conflicting-identities-is-not-deduplicated",
			deltas: []string{
				`{"reasoning_details":[{"type":"reasoning.text","id":"a","index":0,"text":"Same"}],"reasoning":{"type":"reasoning.text","id":"b","index":1,"text":"Same"}}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "Same"}, {Kind: "reasoning", Text: "Same"}},
		},
		{
			name: "suppressed-anonymous-source-does-not-end-explicit-part",
			deltas: []string{
				`{"reasoning_content":"A","reasoning_details":[{"type":"reasoning.text","id":"a","index":0,"text":"A"}]}`,
				`{"reasoning_content":"BC","reasoning_details":[{"type":"reasoning.text","id":"a","index":0,"text":"B"},{"type":"reasoning.text","id":"b","index":1,"text":"C"}]}`,
				`{"reasoning_details":[{"type":"reasoning.text","id":"a","index":0,"text":"D"}]}`,
			},
			parts: []ReasoningPart{{Kind: "reasoning", Text: "ABD"}, {Kind: "reasoning", Text: "C"}},
		},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				for _, delta := range fixture.deltas {
					fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":%s}]}\n\n", delta)
				}
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
			var updates []Update
			message, _, err := g.streamChat(context.Background(), nil, nil, "round-1", func(update Update) error {
				updates = append(updates, update)
				return nil
			})
			if err != nil || message.Content != "Answer" {
				t.Fatalf("stream: message=%+v err=%v", message, err)
			}
			assertReasoningParts(t, updates, fixture.parts)
			for _, update := range updates {
				if update.Text != "" && update.TextID != "round-1:text" {
					t.Fatalf("unstable Chat public text identity: %+v", update)
				}
			}
			if fixture.name == "glm/structured-detail-and-mirrored-alias" {
				for _, retained := range []string{"opaque-private-value", "signed-private-value", `"id":"full-1"`, `"index":0`, `"text":"Full thought."`} {
					if !strings.Contains(string(message.ReasoningDetails), retained) {
						t.Fatalf("canonical replay lost %q: %s", retained, message.ReasoningDetails)
					}
				}
			}
		})
	}
}

func TestResponsesReasoningItemAliasesAndDoneSnapshots(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.reasoning_text.delta","output_index":3,"content_index":2,"delta":"Full "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.added","output_index":3,"item":{"type":"reasoning","id":"rs-full"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_text.delta","item_id":"rs-full","content_index":2,"delta":"thought"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_text.done","item_id":"rs-full","content_index":2,"text":"Full thought."}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.done","output_index":3,"item":{"type":"reasoning","id":"rs-full","encrypted_content":"opaque-replay","provider_extension":"retained","content":[{"type":"output_text","text":"Not reasoning"},{"type":"private","text":"Not visible"},{"type":"reasoning_text","text":"Full thought. Done."}]}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed"}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	var updates []Update
	message, _, err := g.streamResponses(context.Background(), nil, nil, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertReasoningParts(t, updates, []ReasoningPart{{Kind: "reasoning", Text: "Full thought. Done."}})
	for _, retained := range []string{"rs-full", "opaque-replay", "provider_extension", "Not visible"} {
		if !strings.Contains(string(message.ResponsesItems), retained) {
			t.Fatalf("native replay lost %q: %s", retained, message.ResponsesItems)
		}
	}
}

func TestResponsesReasoningPartsFinishIndependently(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs-summary"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_part.added","item_id":"rs-summary","summary_index":0,"part":{"type":"summary_text","text":""}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs-summary","summary_index":0,"delta":"**First "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs-summary","summary_index":1,"delta":"**Second "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.done","item_id":"rs-summary","summary_index":0,"text":"**First title**"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_text.delta","output_index":1,"item_id":"answer-1","delta":"Answer"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs-summary","summary_index":1,"delta":"title"}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_part.done","item_id":"rs-summary","summary_index":1,"part":{"type":"summary_text","text":"**Second title**"}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs-summary","summary":[{"type":"summary_text","text":"**First title**!"},{"type":"summary_text","text":"**Second title**"}],"encrypted_content":"opaque-replay"},{"type":"message","id":"answer-1","phase":"final_answer","content":[{"type":"output_text","text":"Answer"}]}]}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	var updates []Update
	_, _, err := g.streamResponses(context.Background(), nil, nil, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertReasoningParts(t, updates, []ReasoningPart{{Kind: "summary", Text: "**First title**!"}, {Kind: "summary", Text: "**Second title**"}})
	for _, update := range updates {
		if update.Reasoning != nil && update.Reasoning.Text == "title" && update.Reasoning.Done {
			t.Fatalf("closing another summary/public item prematurely ended this part: %+v", updates)
		}
	}
}

func TestResponsesUnindexedReasoningItemIDsStayDistinct(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs-a","summary_index":0,"delta":"First "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.reasoning_summary_text.delta","item_id":"rs-b","summary_index":0,"delta":"Second "}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs-a","summary":[{"type":"summary_text","text":"First title"}]}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs-b","summary":[{"type":"summary_text","text":"Second title"}]}}`+"\n\n")
		fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed"}}`+"\n\n")
	}))
	defer server.Close()
	g, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Protocol: "openai-responses"})
	var updates []Update
	message, _, err := g.streamResponses(context.Background(), nil, nil, "round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertReasoningParts(t, updates, []ReasoningPart{{Kind: "summary", Text: "First title"}, {Kind: "summary", Text: "Second title"}})
	var items []json.RawMessage
	if json.Unmarshal(message.ResponsesItems, &items) != nil || len(items) != 2 {
		t.Fatalf("unindexed completed items overwrote one another: %s", message.ResponsesItems)
	}
}

func TestReasoningCanonicalMergeDoesNotOverwriteOpaqueFields(t *testing.T) {
	merged := appendReasoningDetails(
		json.RawMessage(`[{"type":"reasoning.text","id":"r1","index":0,"text":"First ","signature":"signed-a","provider_extension":"a"},{"type":"reasoning.summary","id":"s1","index":1,"summary":"A"}]`),
		json.RawMessage(`[{"type":"reasoning.text","id":"r1","index":0,"text":"second","signature":"signed-b","provider_extension":"b"},{"type":"reasoning.summary","id":"s1","index":1,"summary":"B"}]`),
	)
	for _, retained := range []string{"signed-a", "signed-b", `"provider_extension":"a"`, `"provider_extension":"b"`, `"summary":"AB"`} {
		if !strings.Contains(string(merged), retained) {
			t.Fatalf("canonical merge discarded %q: %s", retained, merged)
		}
	}
}

func TestReasoningSingleObjectAliasRetainsCanonicalFragments(t *testing.T) {
	merged := appendReasoningValue(nil, json.RawMessage(` {"type":"reasoning.text","id":"r1","text":"First ","signature":"signed-a"}`))
	merged = appendReasoningValue(merged, json.RawMessage(`{"type":"reasoning.text","id":"r1","text":"last","provider_extension":"retained"}`))
	var value map[string]any
	if json.Unmarshal(merged, &value) != nil || value["text"] != "First last" || value["signature"] != "signed-a" || value["provider_extension"] != "retained" {
		t.Fatalf("single object alias lost canonical fragments: %s", merged)
	}
}

func TestResponsesNewAddedItemDoesNotAdoptCompletedAnonymous(t *testing.T) {
	var updates []Update
	visible := newReasoningStream("round-1", func(update Update) error {
		updates = append(updates, update)
		return nil
	})
	stream := newResponseReasoningStream(visible)
	_ = stream.delta("summary", -1, "", 0, "First")
	_ = stream.snapshot("summary", -1, "", 0, "First", true)
	_ = stream.output(-1, responseOutput{Type: "reasoning"}, true)
	_ = stream.output(1, responseOutput{Type: "reasoning", ID: "rs-second"}, false)
	_ = stream.delta("summary", 1, "rs-second", 0, "Second")
	_ = visible.done()
	assertReasoningParts(t, updates, []ReasoningPart{{Kind: "summary", Text: "First"}, {Kind: "summary", Text: "Second"}})
}

func assertReasoningParts(t *testing.T, updates []Update, want []ReasoningPart) {
	t.Helper()
	var parts []*ReasoningPart
	byID := map[string]*ReasoningPart{}
	for _, update := range updates {
		if update.Reasoning == nil {
			continue
		}
		delta := update.Reasoning
		part := byID[delta.ID]
		if part == nil {
			part = &ReasoningPart{ID: delta.ID, Kind: delta.Kind}
			byID[delta.ID] = part
			parts = append(parts, part)
		}
		if part.Kind != delta.Kind {
			t.Fatalf("part kind changed for %s: %+v", delta.ID, updates)
		}
		part.Text += delta.Text
		part.Done = delta.Done
	}
	if len(parts) != len(want) {
		t.Fatalf("part identities: got=%+v want=%+v updates=%+v", parts, want, updates)
	}
	for index, part := range parts {
		if part.ID == "" || part.Kind != want[index].Kind || part.Text != want[index].Text || !part.Done {
			t.Fatalf("part %d: got=%+v want=%+v", index, part, want[index])
		}
		if strings.Contains(part.Text, "private-value") {
			t.Fatalf("private reasoning state became renderable: %+v", part)
		}
	}
}
