package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"ochi/server/internal/product"
)

func providerClient(config Config) *http.Client {
	timeout := 8 * time.Minute
	if config.TimeoutSeconds > 0 {
		timeout = time.Duration(config.TimeoutSeconds) * time.Second
	}
	return &http.Client{Timeout: timeout}
}

// A dynamic runner keeps one implementation while each run receives immutable
// provider/model/options copied from the administrator's current configuration.
func NewDynamic(tools ToolSource) *OpenAI {
	return &OpenAI{config: Config{Tools: tools}, client: &http.Client{Timeout: 8 * time.Minute}}
}

type completionDelta struct {
	Choices []struct {
		Delta struct {
			Content          string          `json:"content"`
			ReasoningContent string          `json:"reasoning_content"`
			ReasoningDetails json.RawMessage `json:"reasoning_details"`
			Reasoning        json.RawMessage `json:"reasoning"`
			ReasoningSummary json.RawMessage `json:"reasoning_summary"`
			ToolCalls        []struct {
				Index    int          `json:"index"`
				ID       string       `json:"id"`
				Type     string       `json:"type"`
				Function functionCall `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens         int64  `json:"prompt_tokens"`
		CompletionTokens     int64  `json:"completion_tokens"`
		TotalTokens          int64  `json:"total_tokens"`
		PromptCacheHitTokens *int64 `json:"prompt_cache_hit_tokens"`
		PromptTokensDetails  struct {
			CachedTokens *int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails struct {
			ReasoningTokens *int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Code    string `json:"code"`
		Type    string `json:"type"`
	} `json:"error"`
}

func (g *OpenAI) requestBody(messages []wireMessage, tools []wireTool, stream bool) map[string]any {
	if g.config.Protocol == "openai-responses" {
		return g.responsesBody(messages, tools, stream)
	}
	// Transport-specific canonical replay items must not leak into Chat Completions.
	messages = append([]wireMessage{}, messages...)
	for i := range messages {
		messages[i].ResponsesItems = nil
		messages[i].Observation = false
	}
	body := map[string]any{"model": g.config.Model, "messages": messages, "stream": stream}
	if stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	body["max_tokens"] = outputBudget(g.config)
	if g.config.Effort != "" && g.config.EffortParameter != "" && len(g.config.EffortValue) > 0 {
		setRequestParameter(body, g.config.EffortParameter, g.config.EffortValue)
	}
	if g.config.ReasoningKind == "budget" && g.config.ReasoningBudget > 0 && g.config.EffortParameter != "" {
		value, _ := json.Marshal(g.config.ReasoningBudget)
		if template, ok := g.config.EffortMapping["budget"]; ok {
			value = bytes.ReplaceAll(template, []byte(`"$budget"`), value)
		}
		setRequestParameter(body, g.config.EffortParameter, value)
	}
	return body
}

func setRequestParameter(body map[string]any, path string, value json.RawMessage) {
	keys := strings.Split(path, ".")
	for _, key := range keys[:len(keys)-1] {
		nested, ok := body[key].(map[string]any)
		if !ok {
			nested = map[string]any{}
			body[key] = nested
		}
		body = nested
	}
	body[keys[len(keys)-1]] = value
}
func (g *OpenAI) do(ctx context.Context, body any) (*http.Response, error) {
	path := "/chat/completions"
	if g.config.Protocol == "openai-responses" {
		path = "/responses"
	}
	return g.post(ctx, path, body)
}

func (g *OpenAI) post(ctx context.Context, path string, body any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.config.BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, &ModelError{Class: "configuration", cause: err}
	}
	req.Header.Set("User-Agent", product.UserAgent())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if g.config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+g.config.APIKey)
	}
	for key, value := range g.config.Headers {
		req.Header.Set(key, value)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, connectionError(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, providerError(resp.StatusCode, data, resp.Header.Get("Retry-After"))
	}
	return resp, nil
}

func (g *OpenAI) stream(ctx context.Context, messages []wireMessage, tools []wireTool, reasonID string, emit func(Update) error) (wireMessage, *Usage, error) {
	var totalUsage *Usage
	for attempt := 1; ; attempt++ {
		emitted, callbackFailed := false, false
		tracked := func(update Update) error {
			if update.Text != "" || update.Reasoning != nil || update.Step != nil || update.Canonical != nil {
				emitted = true
			}
			if err := emit(update); err != nil {
				callbackFailed = true
				return err
			}
			return nil
		}
		var message wireMessage
		var usage *Usage
		var err error
		if g.config.Protocol == "openai-responses" {
			message, usage, err = g.streamResponses(ctx, messages, tools, reasonID, tracked)
		} else {
			message, usage, err = g.streamChat(ctx, messages, tools, reasonID, tracked)
		}
		// Each attempt returns its final cumulative snapshot, not additive chunks.
		// A safely retried request can still have incurred known provider usage.
		if usage != nil {
			if totalUsage == nil {
				totalUsage = &Usage{}
			}
			totalUsage.PromptTokens += usage.PromptTokens
			totalUsage.CompletionTokens += usage.CompletionTokens
			totalUsage.TotalTokens += usage.TotalTokens
			if usage.CachedTokens != nil {
				cached := *usage.CachedTokens
				if totalUsage.CachedTokens != nil {
					cached += *totalUsage.CachedTokens
				}
				totalUsage.CachedTokens = &cached
			}
			if usage.ReasoningTokens != nil {
				reasoning := *usage.ReasoningTokens
				if totalUsage.ReasoningTokens != nil {
					reasoning += *totalUsage.ReasoningTokens
				}
				totalUsage.ReasoningTokens = &reasoning
			}
		}
		if err == nil {
			return message, totalUsage, nil
		}
		if ctx.Err() != nil {
			return message, totalUsage, ctx.Err()
		}
		delay, retry := retryDelay(err, attempt)
		if emitted || callbackFailed || !retry {
			var model *ModelError
			if errors.As(err, &model) && (emitted || callbackFailed) {
				model.committed = true
			}
			g.observeModelError("request_failed", attempt, err)
			return message, totalUsage, err
		}
		g.observeModelError("request_retry", attempt, err)
		if err := waitRetry(ctx, delay); err != nil {
			return wireMessage{}, totalUsage, err
		}
	}
}

func (g *OpenAI) streamChat(ctx context.Context, messages []wireMessage, tools []wireTool, reasonID string, emit func(Update) error) (wireMessage, *Usage, error) {
	resp, err := g.do(ctx, g.requestBody(messages, tools, true))
	if err != nil {
		return wireMessage{}, nil, err
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 8192), 4*1024*1024)
	var text, reasoning strings.Builder
	var details json.RawMessage
	visible := newReasoningStream(reasonID, emit)
	returned := newChatReasoningStream(visible)
	var reasoningAlias, summaryAlias json.RawMessage
	calls := map[int]*toolCall{}
	finished := false
	var usage *Usage
	var terminalErr error
	var usageGrace *time.Timer
	defer func() {
		if usageGrace != nil {
			usageGrace.Stop()
		}
	}()
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			finished = true
			break
		}
		var part completionDelta
		if err := json.Unmarshal([]byte(data), &part); err != nil {
			if terminalErr != nil {
				break
			}
			return wireMessage{}, usage, &ModelError{Class: "invalid_stream"}
		}
		if part.Usage != nil {
			u := part.Usage
			cached := u.PromptTokensDetails.CachedTokens
			if cached == nil {
				cached = u.PromptCacheHitTokens
			}
			usage = &Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens, CachedTokens: cached, ReasoningTokens: u.CompletionTokensDetails.ReasoningTokens}
		}
		if part.Error != nil {
			if terminalErr == nil {
				terminalErr = classifyProviderError(0, part.Error.Code+" "+part.Error.Type, part.Error.Message, "")
			}
			break
		}
		if len(part.Choices) == 0 || finished {
			continue
		}
		choice := part.Choices[0]
		delta := choice.Delta
		if err := returned.delta(delta.ReasoningContent, delta.Reasoning, delta.ReasoningSummary, delta.ReasoningDetails); err != nil {
			return wireMessage{}, usage, err
		}
		if choice.Delta.Content != "" || len(choice.Delta.ToolCalls) > 0 {
			if err := visible.done(); err != nil {
				return wireMessage{}, usage, err
			}
		}
		if choice.Delta.Content != "" {
			text.WriteString(choice.Delta.Content)
			if err := emit(Update{Text: choice.Delta.Content, TextKind: publicTextKind("", len(tools) > 0), TextID: reasonID + ":text"}); err != nil {
				return wireMessage{}, usage, err
			}
		}
		reasoning.WriteString(choice.Delta.ReasoningContent)
		if len(choice.Delta.ReasoningDetails) > 0 {
			details = appendReasoningDetails(details, choice.Delta.ReasoningDetails)
		}
		if len(delta.Reasoning) > 0 {
			reasoningAlias = appendReasoningValue(reasoningAlias, delta.Reasoning)
		}
		if len(delta.ReasoningSummary) > 0 {
			summaryAlias = appendReasoningValue(summaryAlias, delta.ReasoningSummary)
		}
		for _, delta := range choice.Delta.ToolCalls {
			call := calls[delta.Index]
			if call == nil {
				call = &toolCall{Type: "function"}
				calls[delta.Index] = call
			}
			if delta.ID != "" {
				call.ID = delta.ID
			}
			call.Function.Name += delta.Function.Name
			call.Function.Arguments += delta.Function.Arguments
		}
		if choice.FinishReason != "" {
			finished = true
			if choice.FinishReason == "length" || choice.FinishReason == "content_filter" {
				class := "output_limit"
				if choice.FinishReason == "content_filter" {
					class = "content_filter"
				}
				terminalErr = &ModelError{Class: class}
				// Usage can follow the terminal delta. Bound that metadata-only
				// drain without cancelling the caller or reclassifying truncation.
				usageGrace = time.AfterFunc(2*time.Second, func() { _ = resp.Body.Close() })
			}
		}
	}
	if terminalErr != nil {
		_ = visible.done()
		return wireMessage{}, usage, terminalErr
	}
	if err := scanner.Err(); err != nil {
		return wireMessage{}, usage, interruptedStream(err)
	}
	if !finished {
		return wireMessage{}, usage, interruptedStream(nil)
	}
	if err := visible.done(); err != nil {
		return wireMessage{}, usage, err
	}
	ordered := make([]toolCall, len(calls))
	for i := range ordered {
		call, ok := calls[i]
		if !ok || call.ID == "" || call.Function.Name == "" {
			return wireMessage{}, usage, errors.New("model returned an incomplete tool call")
		}
		ordered[i] = *call
	}
	return wireMessage{Role: "assistant", Content: text.String(), ToolCalls: ordered, ReasoningContent: reasoning.String(), ReasoningDetails: details, Reasoning: reasoningAlias, ReasoningSummary: summaryAlias}, usage, nil
}

func publicTextKind(phase string, tools bool) string {
	switch phase {
	case "commentary":
		return "progress"
	case "final_answer":
		return "final"
	default:
		if tools {
			return "pending"
		}
		return "final"
	}
}

func appendReasoningDetails(previous, next json.RawMessage) json.RawMessage {
	var before, after []json.RawMessage
	if json.Unmarshal(next, &after) != nil {
		return next
	}
	_ = json.Unmarshal(previous, &before)
	for _, item := range after {
		var detail map[string]any
		_ = json.Unmarshal(item, &detail)
		key := ""
		switch detail["type"] {
		case "reasoning.text", "summary_text":
			key = "text"
		case "reasoning.summary":
			key = "summary"
			if _, ok := detail[key].(string); !ok {
				key = "text"
			}
		}
		merged := false
		for index := len(before) - 1; key != "" && index >= 0; index-- {
			var last map[string]any
			_ = json.Unmarshal(before[index], &last)
			if last["type"] != detail["type"] || !sameReasoningDetail(last, detail, index == len(before)-1) {
				continue
			}
			fragment, text := detail[key].(string)
			if !text || !mergeableReasoningFields(last, detail, key) {
				break
			}
			previous, _ := last[key].(string)
			last[key] = previous + fragment
			for field, value := range detail {
				if last[field] == nil || last[field] == "" {
					last[field] = value
				}
			}
			before[index], _ = json.Marshal(last)
			merged = true
			break
		}
		if !merged {
			before = append(before, item)
		}
	}
	result, _ := json.Marshal(before)
	return result
}

func sameReasoningDetail(previous, next map[string]any, adjacent bool) bool {
	shared, identified := false, false
	for _, field := range []string{"id", "index"} {
		value, present := next[field]
		if !present || value == nil || value == "" {
			continue
		}
		identified = true
		if before := previous[field]; before != nil && before != "" {
			left, _ := json.Marshal(before)
			right, _ := json.Marshal(value)
			if !bytes.Equal(left, right) {
				return false
			}
			shared = true
		}
	}
	return shared || !identified && adjacent
}

func mergeableReasoningFields(previous, next map[string]any, textKey string) bool {
	for key, value := range next {
		if key == textKey || previous[key] == nil || previous[key] == "" {
			continue
		}
		before, _ := json.Marshal(previous[key])
		after, _ := json.Marshal(value)
		if !bytes.Equal(before, after) {
			// Opaque fields are replay state. Preserve both raw fragments if
			// combining text would otherwise overwrite a signature or extension.
			return false
		}
	}
	return true
}
