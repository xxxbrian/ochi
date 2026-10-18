package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func assertNoOutputCap(t *testing.T, body map[string]any) {
	t.Helper()
	for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if value, present := body[key]; present {
			t.Errorf("ordinary request includes %s=%v", key, value)
		}
	}
}

func TestContextOutputReservationDoesNotLimitGeneration(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
		want   int
	}{
		{"large_reasoning_model", Config{ContextWindow: 1000000, OutputTokenLimit: 393216, ReasoningKind: "effort", Effort: "max"}, 250000},
		{"input_reservation", Config{ContextWindow: 65536, OutputTokenLimit: 128000}, 16384},
		{"small_context", Config{ContextWindow: 8192}, 2048},
		{"unknown_context", Config{}, 4096},
		{"small_model_limit", Config{ContextWindow: 65536, OutputTokenLimit: 512}, 512},
		{"very_small_model_limit", Config{ContextWindow: 65536, OutputTokenLimit: 128}, 128},
		{"selected_thinking", Config{ContextWindow: 32768, ReasoningKind: "budget", ReasoningBudget: 8192}, 9216},
		{"thinking_hits_model_limit", Config{ContextWindow: 32768, OutputTokenLimit: 8500, ReasoningKind: "budget", ReasoningBudget: 8192}, 8500},
		{"capability_exceeds_context", Config{ContextWindow: 8192, OutputTokenLimit: 393216}, 2048},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := contextOutputReserve(test.config); got != test.want {
				t.Fatalf("reserve=%d, want %d", got, test.want)
			}
			for _, protocol := range []string{"openai", "openai-responses"} {
				test.config.Protocol = protocol
				g := &OpenAI{config: test.config}
				if err := g.validateContextConfig(); err != nil {
					t.Fatalf("valid model capability rejected: %v", err)
				}
				budget := g.budgetForInput(nil, nil, nil)
				if budget.OutputReserveTokens != test.want || budget.LimitInputTokens <= 0 || budget.LimitInputTokens+budget.OutputReserveTokens+256 > budget.Window {
					t.Fatalf("%s: invalid compaction reservation %+v, want %d", protocol, budget, test.want)
				}
				for _, stream := range []bool{false, true} {
					assertNoOutputCap(t, g.requestBody(nil, nil, stream))
				}
			}
		})
	}
}

func TestGenerationAndFinalizationLeaveOutputAllowanceToProvider(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-responses"} {
		for _, finalOnly := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/final=%t", protocol, finalOnly), func(t *testing.T) {
				answer := strings.Repeat("long response ", 3000)
				var requests atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					assertNoOutputCap(t, body)
					if protocol == "openai-responses" {
						text, _ := json.Marshal(answer)
						fmt.Fprintf(w, `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":%s}]}]}}`+"\n\n", text)
					} else {
						writeChatAnswer(w, answer)
					}
				}))
				defer upstream.Close()
				g, err := NewOpenAI(Config{Protocol: protocol, BaseURL: upstream.URL, Model: "fixture", AllowNoKey: true})
				if err != nil {
					t.Fatal(err)
				}
				inspections := 0
				req := Request{ObserveContext: func(inspection ContextInspection) {
					inspections++
					var body map[string]any
					if err := json.Unmarshal(inspection.Request, &body); err != nil {
						t.Fatal(err)
					}
					assertNoOutputCap(t, body)
					if !inspection.Budget.UnknownWindow || inspection.Budget.OutputReserveTokens != 4096 {
						t.Fatalf("unknown context lost its compaction headroom: %+v", inspection.Budget)
					}
				}}
				if finalOnly {
					req.Budget = NewExecutionBudget(1)
				}
				var output strings.Builder
				err = g.Generate(context.Background(), req, func(update Update) error { output.WriteString(update.Text); return nil })
				if err != nil || output.String() != answer || requests.Load() != 1 || inspections != 1 {
					t.Fatalf("provider-controlled generation: err=%v output=%d requests=%d inspections=%d", err, output.Len(), requests.Load(), inspections)
				}
			})
		}
	}
}

func TestAuxiliaryUsesItsActualOutputBudget(t *testing.T) {
	for _, test := range []struct {
		name      string
		config    Config
		maxTokens int
		want      int
	}{
		{"title_stays_small", Config{ContextWindow: 1000000, OutputTokenLimit: 393216}, 256, 256},
		{"title_respects_low_model_cap", Config{ContextWindow: 32768, OutputTokenLimit: 128}, 256, 128},
		{"title_with_small_context", Config{ContextWindow: 8192, OutputTokenLimit: 32000}, 256, 256},
		{"title_fits_remaining_small_window", Config{ContextWindow: 2048}, 2048, 1740},
		{"memory_fits_remaining_small_window", Config{ContextWindow: 3072}, 3000, 2764},
		{"summary_independent_of_context_reserve", Config{ContextWindow: 8192}, 3000, 3000},
		{"thinking_exceeds_actual_cap", Config{ContextWindow: 32768, OutputTokenLimit: 512, ReasoningKind: "budget", ReasoningBudgetMin: 512}, 256, 0},
		{"valid_main_thinking_exceeds_short_title_cap", Config{ContextWindow: 32768, OutputTokenLimit: 32000, ReasoningKind: "budget", ReasoningBudgetMin: 512}, 256, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, protocol := range []string{"openai", "openai-responses"} {
				var body map[string]any
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					if protocol == "openai-responses" {
						fmt.Fprint(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"title"}]}]}`)
					} else {
						fmt.Fprint(w, `{"choices":[{"message":{"content":"title"},"finish_reason":"stop"}]}`)
					}
				}))
				test.config.Protocol = protocol
				test.config.BaseURL, test.config.Model, test.config.AllowNoKey = upstream.URL, "fixture", true
				text, err := Complete(context.Background(), test.config, "Title", "A short conversation", test.maxTokens)
				upstream.Close()
				if test.want == 0 {
					var model *ModelError
					if !errors.As(err, &model) || model.Class != "configuration" || body != nil {
						t.Fatalf("%s: error=%v request=%v", protocol, err, body)
					}
					continue
				}
				key := "max_tokens"
				if protocol == "openai-responses" {
					key = "max_output_tokens"
				}
				if err != nil || text != "title" || body[key] != float64(test.want) {
					t.Fatalf("%s: err=%v text=%q budget=%v, want %d", protocol, err, text, body[key], test.want)
				}
			}
		})
	}
}

func TestAuxiliaryRejectsOversizedInputWithoutSendingOrTruncating(t *testing.T) {
	for _, protocol := range []string{"openai", "openai-responses"} {
		t.Run(protocol, func(t *testing.T) {
			var called atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called.Store(true) }))
			defer upstream.Close()
			config := Config{Protocol: protocol, BaseURL: upstream.URL, Model: "fixture", AllowNoKey: true, ContextWindow: 2048}
			_, err := Complete(context.Background(), config, "Title", strings.Repeat("protected input ", 1000), 256)
			var model *ModelError
			if !errors.As(err, &model) || model.Class != "configuration" || called.Load() {
				t.Fatalf("oversized auxiliary input: err=%v requested=%t", err, called.Load())
			}
		})
	}
}

func TestConnectionCheckUsesSelectedThinkingWithoutOutputCap(t *testing.T) {
	var called atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		assertNoOutputCap(t, body)
		thinking, _ := body["thinking"].(map[string]any)
		if thinking["budget_tokens"] != float64(12000) {
			t.Errorf("connection check changed selected thinking: %v", thinking)
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()
	config := Config{BaseURL: upstream.URL, Model: "fixture", AllowNoKey: true, ContextWindow: 65536, OutputTokenLimit: 32768, ReasoningKind: "budget", ReasoningBudget: 12000, EffortParameter: "thinking", EffortMapping: map[string]json.RawMessage{"budget": json.RawMessage(`{"type":"enabled","budget_tokens":"$budget"}`)}}
	if err := TestCompletion(context.Background(), config); err != nil || !called.Load() {
		t.Fatalf("valid thinking config rejected by connection check: err=%v requested=%t", err, called.Load())
	}
}

func TestInvalidThinkingBudgetsFailBeforeRequest(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
	}{
		{"thinking_exceeds_model", Config{ContextWindow: 32768, OutputTokenLimit: 8192, ReasoningKind: "budget", ReasoningBudget: 8192}},
		{"thinking_exceeds_context", Config{ContextWindow: 8192, ReasoningKind: "budget", ReasoningBudget: 8192}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var called atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called.Store(true)
				w.WriteHeader(http.StatusBadRequest)
			}))
			defer upstream.Close()
			test.config.BaseURL, test.config.Model, test.config.AllowNoKey = upstream.URL, "fixture", true
			g, err := NewOpenAI(test.config)
			if err != nil {
				t.Fatal(err)
			}
			err = g.Generate(context.Background(), Request{}, func(Update) error {
				t.Fatal("invalid budget reached generation")
				return nil
			})
			var model *ModelError
			if !errors.As(err, &model) || model.Class != "configuration" || called.Load() {
				t.Fatalf("error=%v, want configuration error", err)
			}
		})
	}
}
