package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSparseStreamingToolCallsPreserveOrderAndFragments(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) > 1 {
			writeChatAnswer(w, "done")
			return
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":7,"id":"later","function":{"name":"files_read","arguments":"{\"path\":"}},{"index":2,"id":"earlier","function":{"name":"files_","arguments":"{\"path\":"}}]}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":7,"id":"later","function":{"arguments":"\"hello.txt\"}"}},{"index":2,"function":{"name":"read","arguments":"\"hello.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	tools := &testTools{}
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools})
	var canonical []wireMessage
	err := generator.Generate(context.Background(), Request{UserID: "ochi-test"}, func(update Update) error {
		if update.Canonical != nil {
			var message wireMessage
			if err := json.Unmarshal(update.Canonical.Payload, &message); err != nil {
				return err
			}
			canonical = append(canonical, message)
		}
		return nil
	})
	if err != nil || tools.calls != 2 || requests.Load() != 2 || len(canonical) != 4 {
		t.Fatalf("sparse call round trip: err=%v tools=%d requests=%d history=%+v", err, tools.calls, requests.Load(), canonical)
	}
	if got := []string{canonical[0].ToolCalls[0].ID, canonical[0].ToolCalls[1].ID, canonical[1].ToolCallID, canonical[2].ToolCallID}; !reflect.DeepEqual(got, []string{"earlier", "later", "earlier", "later"}) {
		t.Fatalf("canonical call/result order = %v", got)
	}
}

func TestAmbiguousChatToolCallsAreAtomicAndDiagnosed(t *testing.T) {
	for _, test := range []struct {
		name, delta, code string
	}{
		{"missing_index", `{"id":"bad","function":{"name":"files_read","arguments":"{}"}}`, "missing_index"},
		{"null_index", `{"index":null,"id":"bad","function":{"name":"files_read","arguments":"{}"}}`, "missing_index"},
		{"negative_index", `{"index":-1,"id":"bad","function":{"name":"files_read","arguments":"{}"}}`, "invalid_index"},
		{"missing_id", `{"index":3,"function":{"name":"files_read","arguments":"{}"}}`, "missing_id"},
		{"blank_id", `{"index":3,"id":" ","function":{"name":"files_read","arguments":"{}"}}`, "missing_id"},
		{"missing_name", `{"index":3,"id":"bad","function":{"arguments":"{}"}}`, "missing_name"},
		{"blank_name", `{"index":3,"id":"bad","function":{"name":" ","arguments":"{}"}}`, "missing_name"},
		{"changed_id", `{"index":0,"id":"replacement"}`, "conflicting_id"},
		{"duplicate_id", `{"index":3,"id":"valid"}`, "duplicate_id"},
		{"unsupported_type", `{"index":3,"id":"bad","type":"custom","function":{"name":"files_read","arguments":"{}"}}`, "unsupported_type"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"public progress","tool_calls":[{"index":0,"id":"valid","function":{"name":"files_read","arguments":"{\"path\":\"hello.txt\"}"}}]}}]}`+"\n\n")
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[%s]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", test.delta)
			}))
			defer server.Close()
			tools := &testTools{}
			var diagnostics []Diagnostic
			generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true, Tools: tools, Observe: func(d Diagnostic) { diagnostics = append(diagnostics, d) }})
			canonical, steps := 0, 0
			err := generator.Generate(context.Background(), Request{UserID: "ochi-test"}, func(update Update) error {
				if update.Canonical != nil {
					canonical++
				}
				if update.Step != nil {
					steps++
				}
				return nil
			})
			var model *ModelError
			if !errors.As(err, &model) || model.Class != "tool_protocol" || model.Code != test.code || requests.Load() != 1 || tools.calls != 0 || canonical != 0 || steps != 0 {
				t.Fatalf("unsafe malformed call: err=%#v requests=%d tools=%d history=%d steps=%d", err, requests.Load(), tools.calls, canonical, steps)
			}
			if len(diagnostics) != 1 || diagnostics[0].Kind != "request_failed" || diagnostics[0].Class != model.Class || diagnostics[0].Code != test.code || diagnostics[0].Attempt != 1 || !reflect.DeepEqual(diagnostics[0].ToolIndex, model.ToolIndex) {
				t.Fatalf("protocol diagnostic = %+v", diagnostics)
			}
			encoded, _ := json.Marshal(diagnostics)
			for _, secret := range []string{"hello.txt", "public progress", "replacement", "files_read"} {
				if strings.Contains(string(encoded), secret) || strings.Contains(err.Error(), secret) {
					t.Fatalf("diagnostic disclosed model/tool payload: %s; %v", encoded, err)
				}
			}
		})
	}
}

func TestToolCallFinishRequiresCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	generator, _ := NewOpenAI(Config{BaseURL: server.URL, Model: "fixture", AllowNoKey: true})
	err := generator.Generate(context.Background(), Request{}, func(Update) error { return nil })
	var model *ModelError
	if !errors.As(err, &model) || model.Class != "tool_protocol" || model.Code != "missing_calls" {
		t.Fatalf("missing declared tool calls = %#v", err)
	}
}

func TestAmbiguousResponsesToolCallsAreAtomicAndDiagnosed(t *testing.T) {
	for _, test := range []struct {
		name, item, code string
	}{
		{"missing_id", `{"type":"function_call","name":"files_read","arguments":"{}"}`, "missing_id"},
		{"missing_name", `{"type":"function_call","call_id":"bad","arguments":"{}"}`, "missing_name"},
		{"duplicate_id", `{"type":"function_call","call_id":"valid","name":"files_read","arguments":"{}"}`, "duplicate_id"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"valid\",\"name\":\"files_read\",\"arguments\":\"{\\\"path\\\":\\\"hello.txt\\\"}\"},%s]}}\n\n", test.item)
			}))
			defer server.Close()
			tools := &testTools{}
			var diagnostics []Diagnostic
			generator, _ := NewOpenAI(Config{BaseURL: server.URL, Protocol: "openai-responses", Model: "fixture", AllowNoKey: true, Tools: tools, Observe: func(d Diagnostic) { diagnostics = append(diagnostics, d) }})
			canonical := 0
			err := generator.Generate(context.Background(), Request{UserID: "ochi-test"}, func(update Update) error {
				if update.Canonical != nil {
					canonical++
				}
				return nil
			})
			var model *ModelError
			if !errors.As(err, &model) || model.Class != "tool_protocol" || model.Code != test.code || tools.calls != 0 || requests.Load() != 1 || canonical != 0 {
				t.Fatalf("unsafe Responses call: err=%#v tools=%d requests=%d history=%d", err, tools.calls, requests.Load(), canonical)
			}
			if len(diagnostics) != 1 || diagnostics[0].Class != model.Class || diagnostics[0].Code != test.code || diagnostics[0].ToolIndex == nil || *diagnostics[0].ToolIndex != 1 {
				t.Fatalf("Responses diagnostic = %+v", diagnostics)
			}
		})
	}
}

type protocolArgumentTools struct{ calls []string }

func (*protocolArgumentTools) Definitions(context.Context, string) ([]ToolDefinition, error) {
	return []ToolDefinition{{Name: "read", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`)}}, nil
}

func (tools *protocolArgumentTools) Call(_ context.Context, _, _ string, arguments json.RawMessage) (ToolResult, error) {
	tools.calls = append(tools.calls, string(arguments))
	return ToolResult{Output: "observed"}, nil
}

func TestToolArgumentFailuresRemainCorrectableWithoutDispatch(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-responses"} {
		for _, test := range []struct{ name, arguments string }{
			{"missing_required", ""},
			{"truncated_arguments", "{"},
			{"multiple_json_values", "{} {}"},
			{"duplicate_properties", `{"path":"a","path":"b"}`},
			{"array_arguments", "[]"},
			{"null_arguments", "null"},
			{"schema_type", `{"path":3}`},
		} {
			t.Run(protocol+"/"+test.name, func(t *testing.T) {
				writeCalls := func(w http.ResponseWriter, calls []toolCall) {
					if protocol != "openai-responses" {
						writeToolCalls(w, calls)
						return
					}
					output := make([]map[string]any, len(calls))
					for index, call := range calls {
						output[index] = map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments}
					}
					data, _ := json.Marshal(map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "output": output}})
					fmt.Fprintf(w, "data: %s\n\n", data)
				}
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					switch requests.Add(1) {
					case 1:
						writeCalls(w, []toolCall{
							{ID: "valid", Function: functionCall{Name: "read", Arguments: `{"path":"first.txt"}`}},
							{ID: "bad-arguments", Function: functionCall{Name: "read", Arguments: test.arguments}},
						})
					case 2:
						writeCalls(w, []toolCall{{ID: "corrected", Function: functionCall{Name: "read", Arguments: `{"path":"corrected.txt"}`}}})
					default:
						if protocol == "openai-responses" {
							fmt.Fprint(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}`+"\n\n")
						} else {
							writeChatAnswer(w, "done")
						}
					}
				}))
				defer server.Close()
				tools := &protocolArgumentTools{}
				var diagnostics []Diagnostic
				generator, _ := NewOpenAI(Config{BaseURL: server.URL, Protocol: protocol, Model: "fixture", AllowNoKey: true, Tools: tools, Observe: func(d Diagnostic) { diagnostics = append(diagnostics, d) }})
				var canonical []wireMessage
				err := generator.Generate(context.Background(), Request{}, func(update Update) error {
					if update.Canonical != nil {
						var message wireMessage
						if err := json.Unmarshal(update.Canonical.Payload, &message); err != nil {
							return err
						}
						canonical = append(canonical, message)
					}
					return nil
				})
				if err != nil || requests.Load() != 3 || !reflect.DeepEqual(tools.calls, []string{`{"path":"first.txt"}`, `{"path":"corrected.txt"}`}) || len(canonical) != 6 {
					t.Fatalf("argument correction: err=%v requests=%d dispatched=%v history=%+v", err, requests.Load(), tools.calls, canonical)
				}
				if canonical[2].Role != "tool" || canonical[2].ToolCallID != "bad-arguments" || !strings.Contains(fmt.Sprint(canonical[2].Content), "invalid_arguments") {
					t.Fatalf("malformed arguments were not returned as a correctable failure: %+v", canonical[2])
				}
				if len(diagnostics) != 1 || diagnostics[0].Kind != "tool_failed" || diagnostics[0].Class != "invalid_arguments" {
					t.Fatalf("recoverable argument diagnostic = %+v", diagnostics)
				}
			})
		}
	}
}
