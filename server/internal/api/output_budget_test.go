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

func TestModelOutputMetadataNeverBecomesRequestCap(t *testing.T) {
	for _, test := range []struct {
		name   string
		manual bool
		limit  int
	}{
		{"catalog_capability", false, 393216},
		{"admin_capability", true, 8192},
		{"admin_unknown", true, 0},
		{"catalog_low_capability", false, 512},
		{"catalog_tiny_capability", false, 128},
	} {
		t.Run(test.name, func(t *testing.T) {
			var request map[string]any
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
			if config.OutputTokenLimit != test.limit {
				t.Fatalf("capability=%d, want %d", config.OutputTokenLimit, test.limit)
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
			if err != nil || output != "done" || request["reasoning_effort"] != "max" {
				t.Fatalf("err=%v output=%q effort=%v", err, output, request["reasoning_effort"])
			}
			for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
				if value, present := request[key]; present {
					t.Errorf("model metadata injected %s=%v", key, value)
				}
			}
		})
	}
}
