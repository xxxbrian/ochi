package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// Auxiliary work uses a cheap/low-reasoning model if configured and never
// inherits the main task's high effort or hidden reasoning budget.
func AuxiliaryConfig(config Config) Config {
	config.CompactionConfig = nil
	config.Tools = nil
	config.MemoryContext = ""
	config.Effort, config.EffortValue = "", nil
	config.ReasoningBudget = 0
	// Relays frequently accept low/off but reject a catalog's native "none"
	// spelling. Prefer the widely supported cheap option for auxiliary work.
	for _, effort := range []string{"off", "low", "minimal", "none"} {
		if value, ok := config.EffortMapping[effort]; ok {
			config.Effort, config.EffortValue = effort, value
			break
		}
	}
	if config.ReasoningKind == "budget" && config.ReasoningBudgetMin > 0 {
		config.ReasoningBudget = config.ReasoningBudgetMin
	}
	return config
}

func Complete(ctx context.Context, config Config, system, user string, maxTokens int) (string, error) {
	config = AuxiliaryConfig(config)
	return complete(ctx, config, system, user, maxTokens)
}

func CompleteWithUsage(ctx context.Context, config Config, system, user string, maxTokens int) (string, *Usage, error) {
	var usage *Usage
	text, err := completeObserved(ctx, AuxiliaryConfig(config), system, user, maxTokens, func(v *Usage) { usage = v })
	return text, usage, err
}

func TestCompletion(ctx context.Context, config Config) error {
	_, err := complete(ctx, config, "Return exactly OK. This is a connection check.", "OK", 0)
	return err
}

func complete(ctx context.Context, config Config, system, user string, maxTokens int) (string, error) {
	return completeObserved(ctx, config, system, user, maxTokens, nil)
}

func completeObserved(ctx context.Context, config Config, system, user string, maxTokens int, observed func(*Usage)) (string, error) {
	g, err := NewOpenAI(config)
	if err != nil {
		return "", err
	}
	if err := g.validateContextConfig(); err != nil {
		return "", err
	}
	messages := []wireMessage{{Role: "system", Content: system}, {Role: "user", Content: user}}
	available := contextWindow(config) - 256
	for _, message := range messages {
		available -= estimateMessageTokens(message, config.Protocol)
	}
	if available <= 0 {
		return "", &ModelError{Class: "configuration"}
	}
	if maxTokens > 0 {
		maxTokens = min(maxTokens, available)
		if config.OutputTokenLimit > 0 {
			maxTokens = min(maxTokens, config.OutputTokenLimit)
		}
	}
	if config.ReasoningKind == "budget" && config.ReasoningBudget > 0 && maxTokens > 0 && maxTokens <= config.ReasoningBudget {
		return "", &ModelError{Class: "configuration"}
	}
	body := g.requestBody(messages, nil, false)
	if maxTokens > 0 {
		if config.Protocol == "openai-responses" {
			body["max_output_tokens"] = maxTokens
		} else {
			body["max_tokens"] = maxTokens
		}
	}
	resp, err := g.doRetry(ctx, body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if config.Protocol == "openai-responses" {
		var result responsesResult
		if err = json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&result); err != nil {
			return "", err
		}
		if observed != nil && result.Usage != nil {
			u := result.Usage
			observed(&Usage{PromptTokens: u.InputTokens, CompletionTokens: u.OutputTokens, TotalTokens: u.TotalTokens, CachedTokens: u.InputTokenDetails.CachedTokens, ReasoningTokens: u.OutputTokenDetails.ReasoningTokens})
		}
		message, err := result.message()
		if err != nil {
			return "", err
		}
		content, _ := message.Content.(string)
		if strings.TrimSpace(content) == "" {
			return "", errors.New("auxiliary model returned no content")
		}
		return strings.TrimSpace(content), nil
	}
	var result struct {
		Usage   json.RawMessage `json:"usage"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&result); err != nil {
		return "", &ModelError{Class: "invalid_stream"}
	}
	if observed != nil && len(result.Usage) > 0 {
		payload, _ := json.Marshal(map[string]json.RawMessage{"usage": result.Usage})
		var parsed completionDelta
		if json.Unmarshal(payload, &parsed) == nil && parsed.Usage != nil {
			u := parsed.Usage
			cached := u.PromptTokensDetails.CachedTokens
			if cached == nil {
				cached = u.PromptCacheHitTokens
			}
			observed(&Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens, CachedTokens: cached, ReasoningTokens: u.CompletionTokensDetails.ReasoningTokens})
		}
	}
	if len(result.Choices) > 0 && result.Choices[0].FinishReason == "length" {
		return "", &ModelError{Class: "output_limit"}
	}
	if len(result.Choices) == 0 || strings.TrimSpace(result.Choices[0].Message.Content) == "" {
		return "", errors.New("auxiliary model returned no content")
	}
	return strings.TrimSpace(result.Choices[0].Message.Content), nil
}

func Embed(ctx context.Context, config Config, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	g, err := NewOpenAI(config)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"model": config.Model, "input": texts, "encoding_format": "float"}
	resp, err := g.retryRequest(ctx, func() (*http.Response, error) { return g.post(ctx, "/embeddings", body) })
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Data) != len(texts) {
		return nil, errors.New("embedding model returned incomplete vectors")
	}
	values := make([][]float32, len(texts))
	for _, value := range result.Data {
		if value.Index < 0 || value.Index >= len(values) || len(value.Embedding) == 0 || values[value.Index] != nil {
			return nil, errors.New("embedding model returned invalid vectors")
		}
		values[value.Index] = value.Embedding
	}
	return values, nil
}
