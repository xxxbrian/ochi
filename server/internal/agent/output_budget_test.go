package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAutomaticOutputBudgetRespectsModelAndContext(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
		want   int
	}{
		{"large_reasoning_model", Config{ContextWindow: 1000000, OutputTokenLimit: 393216, ReasoningKind: "effort", Effort: "max"}, 65536},
		{"input_reservation", Config{ContextWindow: 65536, OutputTokenLimit: 128000}, 16384},
		{"small_context", Config{ContextWindow: 8192}, 2048},
		{"unknown_context", Config{}, 4096},
		{"small_model_limit", Config{ContextWindow: 65536, OutputTokenLimit: 512}, 512},
		{"very_small_model_limit", Config{ContextWindow: 65536, OutputTokenLimit: 128}, 128},
		{"selected_thinking", Config{ContextWindow: 32768, ReasoningKind: "budget", ReasoningBudget: 8192}, 9216},
		{"thinking_hits_model_limit", Config{ContextWindow: 32768, OutputTokenLimit: 8500, ReasoningKind: "budget", ReasoningBudget: 8192}, 8500},
		{"explicit_request", Config{ContextWindow: 32768, MaxOutputTokens: 20000, OutputTokenLimit: 32000}, 20000},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := outputBudget(test.config); got != test.want {
				t.Fatalf("budget=%d, want %d", got, test.want)
			}
			for _, protocol := range []string{"openai", "openai-responses"} {
				test.config.Protocol = protocol
				g := &OpenAI{config: test.config}
				body := g.requestBody(nil, nil, true)
				key := "max_tokens"
				if protocol == "openai-responses" {
					key = "max_output_tokens"
				}
				budget := g.budgetForInput(nil, nil, nil)
				if body[key] != test.want || budget.OutputTokens != test.want {
					t.Fatalf("%s: wire=%v reserve=%d, want %d", protocol, body[key], budget.OutputTokens, test.want)
				}
			}
		})
	}
}

func TestAuxiliaryUsesItsActualOutputBudget(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
		want   int
	}{
		{"title_stays_small", Config{ContextWindow: 1000000, OutputTokenLimit: 393216}, 256},
		{"title_respects_low_model_cap", Config{ContextWindow: 32768, OutputTokenLimit: 128}, 128},
		{"valid_title_from_large_main_cap", Config{ContextWindow: 8192, MaxOutputTokens: 16000, OutputTokenLimit: 32000}, 256},
		{"thinking_exceeds_actual_cap", Config{ContextWindow: 32768, OutputTokenLimit: 512, ReasoningKind: "budget", ReasoningBudgetMin: 512}, 0},
		{"valid_main_thinking_exceeds_short_title_cap", Config{ContextWindow: 32768, OutputTokenLimit: 32000, ReasoningKind: "budget", ReasoningBudgetMin: 512}, 0},
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
				text, err := Complete(context.Background(), test.config, "Title", "A short conversation", 256)
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

func TestInvalidOutputBudgetsFailBeforeRequest(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
	}{
		{"thinking_exceeds_model", Config{ContextWindow: 32768, OutputTokenLimit: 8192, ReasoningKind: "budget", ReasoningBudget: 8192}},
		{"thinking_exceeds_context", Config{ContextWindow: 8192, ReasoningKind: "budget", ReasoningBudget: 8192}},
		{"explicit_exceeds_model", Config{ContextWindow: 32768, OutputTokenLimit: 4096, MaxOutputTokens: 8192}},
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
