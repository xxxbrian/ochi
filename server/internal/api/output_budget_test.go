package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func TestModelOutputCapabilityAndRequestBudget(t *testing.T) {
	for _, test := range []struct {
		name       string
		manual     bool
		limit      int
		requestCap int
		wireCap    int
	}{
		{"catalog_auto", false, 393216, 0, 65536},
		{"admin_explicit", true, 8192, 8192, 8192},
		{"admin_auto", true, 0, 0, 65536},
		{"catalog_low_cap", false, 512, 0, 512},
		{"catalog_tiny_cap", false, 128, 0, 128},
	} {
		t.Run(test.name, func(t *testing.T) {
			var request struct {
				MaxTokens int    `json:"max_tokens"`
				Effort    string `json:"reasoning_effort"`
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				reasoning, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"reasoning_content": strings.Repeat("reasoning ", 2000)}}}})
				fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", reasoning)
			}))
			defer upstream.Close()
			model := storage.Model{
				Model: "fixture", ContextWindow: 1000000, MaxOutputTokens: test.limit,
				ReasoningKind: "effort", EffortParameter: "reasoning_effort",
				EffortMapping:     map[string]json.RawMessage{"max": json.RawMessage(`"max"`)},
				MetadataOverrides: map[string]bool{"max_output_tokens": test.manual},
			}
			config := (&Server{}).modelConfig(context.Background(), model, storage.Provider{Protocol: "openai", BaseURL: upstream.URL, AllowNoKey: true}, "max", storage.Settings{})
			if config.OutputTokenLimit != test.limit || config.MaxOutputTokens != test.requestCap {
				t.Fatalf("capability=%d request=%d, want %d/%d", config.OutputTokenLimit, config.MaxOutputTokens, test.limit, test.requestCap)
			}
			generator, err := agent.NewOpenAI(*config)
			if err != nil {
				t.Fatal(err)
			}
			var output string
			err = generator.Generate(context.Background(), agent.Request{}, func(update agent.Update) error {
				output += update.Text
				return nil
			})
			if err != nil || output != "done" || request.MaxTokens != test.wireCap || request.Effort != "max" {
				t.Fatalf("err=%v output=%q cap=%d effort=%q, want cap %d/max", err, output, request.MaxTokens, request.Effort, test.wireCap)
			}
		})
	}
}
