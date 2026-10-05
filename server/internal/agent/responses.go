package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Responses uses the same durable portable transcript as Chat Completions,
// retaining native output items separately for encrypted reasoning/phase replay.
func (g *OpenAI) responsesBody(messages []wireMessage, tools []wireTool, stream bool) map[string]any {
	input := []any{}
	for _, message := range messages {
		if len(message.ResponsesItems) > 0 {
			var items []json.RawMessage
			if json.Unmarshal(message.ResponsesItems, &items) == nil && len(items) > 0 {
				for _, item := range items {
					input = append(input, item)
				}
				continue
			}
		}
		if message.Role == "tool" {
			input = append(input, map[string]any{"type": "function_call_output", "call_id": message.ToolCallID, "output": message.Content})
			continue
		}
		if content := responsesContent(message.Content); len(content) > 0 {
			input = append(input, map[string]any{"role": message.Role, "content": content})
		}
		for _, call := range message.ToolCalls {
			input = append(input, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
		}
	}
	body := map[string]any{"model": g.config.Model, "input": input, "stream": stream, "store": false, "include": []string{"reasoning.encrypted_content"}}
	if len(tools) > 0 {
		items := []any{}
		for _, tool := range tools {
			items = append(items, map[string]any{"type": "function", "name": tool.Function.Name, "description": tool.Function.Description, "parameters": tool.Function.Parameters, "strict": false})
		}
		body["tools"] = items
	}
	body["max_output_tokens"] = outputBudget(g.config)
	if g.config.Effort != "" && g.config.EffortParameter != "" && len(g.config.EffortValue) > 0 {
		path := g.config.EffortParameter
		if path == "reasoning_effort" {
			path = "reasoning.effort"
		}
		setRequestParameter(body, path, g.config.EffortValue)
	}
	if g.config.ReasoningKind != "" && g.config.ReasoningKind != "none" && g.config.ReasoningKind != "unknown" {
		reasoning, _ := body["reasoning"].(map[string]any)
		if reasoning == nil {
			reasoning = map[string]any{}
		}
		reasoning["summary"] = "auto"
		body["reasoning"] = reasoning
	}
	return body
}

func responsesContent(content any) []any {
	if text, ok := content.(string); ok {
		if text == "" {
			return nil
		}
		return []any{map[string]any{"type": "input_text", "text": text}}
	}
	data, _ := json.Marshal(content)
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	if json.Unmarshal(data, &parts) != nil {
		return nil
	}
	result := []any{}
	for _, part := range parts {
		switch part.Type {
		case "text":
			result = append(result, map[string]any{"type": "input_text", "text": part.Text})
		case "image_url":
			result = append(result, map[string]any{"type": "input_image", "image_url": part.ImageURL.URL})
		}
	}
	return result
}

type responseOutput struct {
	ID               string `json:"id"`
	Type             string `json:"type"`
	Phase            string `json:"phase"`
	CallID           string `json:"call_id"`
	Name             string `json:"name"`
	Arguments        string `json:"arguments"`
	EncryptedContent string `json:"encrypted_content,omitempty"`
	Content          []struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Refusal string `json:"refusal"`
	} `json:"content"`
	Summary []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"summary"`
}

type responsesResult struct {
	Status string            `json:"status"`
	Output []json.RawMessage `json:"output"`
	Error  *struct {
		Message string `json:"message"`
		Code    string `json:"code"`
		Type    string `json:"type"`
	} `json:"error"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Usage *struct {
		InputTokens       int64 `json:"input_tokens"`
		OutputTokens      int64 `json:"output_tokens"`
		TotalTokens       int64 `json:"total_tokens"`
		InputTokenDetails struct {
			CachedTokens *int64 `json:"cached_tokens"`
		} `json:"input_tokens_details"`
		OutputTokenDetails struct {
			ReasoningTokens *int64 `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
	} `json:"usage"`
}

func (r responsesResult) usage() *Usage {
	if u := r.Usage; u != nil {
		return &Usage{PromptTokens: u.InputTokens, CompletionTokens: u.OutputTokens, TotalTokens: u.TotalTokens, CachedTokens: u.InputTokenDetails.CachedTokens, ReasoningTokens: u.OutputTokenDetails.ReasoningTokens}
	}
	return nil
}

func (r responsesResult) message() (wireMessage, error) {
	if r.Error != nil {
		return wireMessage{}, classifyProviderError(0, r.Error.Code+" "+r.Error.Type, r.Error.Message, "")
	}
	if r.Status == "failed" || r.Status == "incomplete" {
		reason := r.Status
		if r.IncompleteDetails != nil {
			reason = r.IncompleteDetails.Reason
		}
		class := "configuration"
		if reason == "max_output_tokens" {
			class = "output_limit"
		} else if reason == "content_filter" {
			class = "content_filter"
		}
		return wireMessage{}, &ModelError{Class: class}
	}
	var text strings.Builder
	calls := []toolCall{}
	for _, raw := range r.Output {
		var item responseOutput
		if err := json.Unmarshal(raw, &item); err != nil {
			return wireMessage{}, err
		}
		switch item.Type {
		case "message":
			if item.Phase == "commentary" {
				continue
			}
			for _, content := range item.Content {
				if content.Type == "output_text" {
					text.WriteString(content.Text)
				} else if content.Type == "refusal" {
					text.WriteString(content.Refusal)
				}
			}
		case "function_call":
			if item.CallID == "" || item.Name == "" {
				return wireMessage{}, errors.New("model returned an incomplete tool call")
			}
			calls = append(calls, toolCall{ID: item.CallID, Type: "function", Function: functionCall{Name: item.Name, Arguments: item.Arguments}})
		}
	}
	items, _ := json.Marshal(r.Output)
	return wireMessage{Role: "assistant", Content: text.String(), ToolCalls: calls, ResponsesItems: items}, nil
}

func (g *OpenAI) streamResponses(ctx context.Context, messages []wireMessage, tools []wireTool, reasonID string, emit func(Update) error) (wireMessage, *Usage, error) {
	resp, err := g.do(ctx, g.responsesBody(messages, tools, true))
	if err != nil {
		return wireMessage{}, nil, err
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 8192), 4*1024*1024)
	visible := newReasoningStream(reasonID, emit)
	returned := newResponseReasoningStream(visible)
	items := map[string]json.RawMessage{}
	itemOrder := []string{}
	itemIndexes := map[string]int{}
	public := map[int]*responsePublicText{}
	byID := map[string]*responsePublicText{}
	var current *responsePublicText
	publicItem := func(index int, id string) *responsePublicText {
		item := byID[id]
		if item == nil && index != -1 {
			item = public[index]
		}
		if item == nil && index == -1 && id == "" {
			item = current
			if item == nil {
				item = public[-1]
			}
		}
		if item == nil {
			key := id
			if key == "" {
				key = fmt.Sprintf("output-%d", index)
			}
			item = &responsePublicText{ID: reasonID + ":" + key, Parts: map[int]string{}}
		}
		if index != -1 || (id == "" && current == nil) {
			public[index] = item
		}
		if id != "" {
			byID[id] = item
		}
		return item
	}
	emitText := func(item *responsePublicText, index int, delta string) error {
		if delta == "" {
			return nil
		}
		if item.Kind == "" {
			item.Kind = publicTextKind(item.Phase, len(tools) > 0)
		}
		if err := emit(Update{Text: delta, TextKind: item.Kind, TextID: item.ID}); err != nil {
			return err
		}
		item.Parts[index] += delta
		return nil
	}
	setPhase := func(item *responsePublicText, phase string) error {
		if phase != "" {
			item.Phase = phase
		}
		if item.Phase == "commentary" && item.Kind != "" && item.Kind != "progress" {
			if err := emit(Update{TextKind: "progress", TextID: item.ID}); err != nil {
				return err
			}
			item.Kind = "progress"
		}
		return nil
	}
	completeText := func(index int, output responseOutput) error {
		// Some gateways omit delta indices; bind that stream to its completed item.
		if public[index] == nil && byID[output.ID] == nil && public[-1] != nil {
			if strings.HasPrefix(output.publicText(), public[-1].text()) {
				public[index] = public[-1]
				delete(public, -1)
			}
		}
		item := publicItem(index, output.ID)
		if err := setPhase(item, output.Phase); err != nil {
			return err
		}
		for index, content := range output.Content {
			text := content.Text
			if content.Type == "refusal" {
				text = content.Refusal
			} else if content.Type != "output_text" {
				continue
			}
			before := item.Parts[index]
			if strings.HasPrefix(text, before) && len(text) > len(before) {
				if err := emitText(item, index, text[len(before):]); err != nil {
					return err
				}
			}
		}
		return nil
	}
	result := responsesResult{}
	finished := false
	var usage *Usage
stream:
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var event struct {
			Type         string `json:"type"`
			Delta        string `json:"delta"`
			Text         string `json:"text"`
			OutputIndex  *int   `json:"output_index"`
			ItemID       string `json:"item_id"`
			SummaryIndex int    `json:"summary_index"`
			ContentIndex int    `json:"content_index"`
			Part         struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"part"`
			Item     json.RawMessage `json:"item"`
			Response responsesResult `json:"response"`
			Message  string          `json:"message"`
			Code     string          `json:"code"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return wireMessage{}, usage, &ModelError{Class: "invalid_stream"}
		}
		if known := event.Response.usage(); known != nil {
			usage = known
		}
		index := -1
		if event.OutputIndex != nil {
			index = *event.OutputIndex
		}
		switch event.Type {
		case "response.reasoning_summary_text.delta":
			if err := returned.delta("summary", index, event.ItemID, event.SummaryIndex, event.Delta); err != nil {
				return wireMessage{}, usage, err
			}
		case "response.reasoning_text.delta":
			if err := returned.delta("reasoning", index, event.ItemID, event.ContentIndex, event.Delta); err != nil {
				return wireMessage{}, usage, err
			}
		case "response.reasoning_summary_text.done":
			if err := returned.snapshot("summary", index, event.ItemID, event.SummaryIndex, event.Text, true); err != nil {
				return wireMessage{}, usage, err
			}
		case "response.reasoning_text.done":
			if err := returned.snapshot("reasoning", index, event.ItemID, event.ContentIndex, event.Text, true); err != nil {
				return wireMessage{}, usage, err
			}
		case "response.reasoning_summary_part.added", "response.reasoning_summary_part.done":
			if event.Part.Type == "summary_text" {
				if err := returned.snapshot("summary", index, event.ItemID, event.SummaryIndex, event.Part.Text, event.Type == "response.reasoning_summary_part.done"); err != nil {
					return wireMessage{}, usage, err
				}
			}
		case "response.content_part.added", "response.content_part.done":
			if event.Part.Type == "reasoning_text" {
				if err := returned.snapshot("reasoning", index, event.ItemID, event.ContentIndex, event.Part.Text, event.Type == "response.content_part.done"); err != nil {
					return wireMessage{}, usage, err
				}
			}
		case "response.output_text.delta", "response.refusal.delta":
			if err := emitText(publicItem(index, event.ItemID), event.ContentIndex, event.Delta); err != nil {
				return wireMessage{}, usage, err
			}
		case "response.output_item.added":
			var output responseOutput
			if json.Unmarshal(event.Item, &output) == nil {
				if output.Type == "message" {
					current = publicItem(index, output.ID)
					if err := setPhase(current, output.Phase); err != nil {
						return wireMessage{}, usage, err
					}
				} else if output.Type == "reasoning" {
					if err := returned.output(index, output, false); err != nil {
						return wireMessage{}, usage, err
					}
				}
			}
		case "response.output_item.done":
			var output responseOutput
			if json.Unmarshal(event.Item, &output) == nil {
				key := "id:" + output.ID
				if output.ID == "" {
					key = fmt.Sprintf("output:%d", index)
					if index == -1 {
						key += fmt.Sprintf("-%d", len(itemOrder))
					}
				}
				if items[key] == nil {
					itemOrder = append(itemOrder, key)
				}
				items[key], itemIndexes[key] = event.Item, index
				if output.Type == "message" {
					if err := completeText(index, output); err != nil {
						return wireMessage{}, usage, err
					}
				} else if output.Type == "reasoning" {
					if err := returned.output(index, output, true); err != nil {
						return wireMessage{}, usage, err
					}
				}
			}
		case "response.completed", "response.failed", "response.incomplete":
			result, finished = event.Response, true
			if result.Status == "" {
				result.Status = strings.TrimPrefix(event.Type, "response.")
			}
			// Unlike Chat Completions, this terminal event contains its usage.
			// Do not wait for EOF (or another event) after a complete response.
			break stream
		case "error":
			return wireMessage{}, usage, classifyProviderError(0, event.Code, event.Message, "")
		}
	}
	if err := scanner.Err(); err != nil {
		return wireMessage{}, usage, interruptedStream(err)
	}
	if !finished {
		return wireMessage{}, usage, interruptedStream(nil)
	}
	fallbackIndexes := []int{}
	if len(result.Output) == 0 {
		indexed := true
		for _, key := range itemOrder {
			indexed = indexed && itemIndexes[key] >= 0
		}
		if indexed {
			sort.SliceStable(itemOrder, func(i, j int) bool { return itemIndexes[itemOrder[i]] < itemIndexes[itemOrder[j]] })
		}
		for _, key := range itemOrder {
			result.Output = append(result.Output, items[key])
			fallbackIndexes = append(fallbackIndexes, itemIndexes[key])
		}
	}
	_, resultErr := result.message()
	for position, raw := range result.Output {
		index := position
		if len(fallbackIndexes) > position {
			index = fallbackIndexes[position]
		}
		var item responseOutput
		_ = json.Unmarshal(raw, &item)
		if item.Type == "message" {
			if err := completeText(index, item); err != nil {
				if resultErr != nil {
					return wireMessage{}, usage, resultErr
				}
				return wireMessage{}, usage, err
			}
			if phase := publicItem(index, item.ID).Phase; item.Phase == "" && phase != "" {
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(raw, &fields)
				fields["phase"], _ = json.Marshal(phase)
				result.Output[position], _ = json.Marshal(fields)
			}
		}
		if item.Type == "reasoning" {
			if err := returned.output(index, item, true); err != nil {
				if resultErr != nil {
					return wireMessage{}, usage, resultErr
				}
				return wireMessage{}, usage, err
			}
		}
	}
	if err := visible.done(); err != nil {
		if resultErr != nil {
			return wireMessage{}, usage, resultErr
		}
		return wireMessage{}, usage, err
	}
	if resultErr != nil {
		return wireMessage{}, usage, resultErr
	}
	message, err := result.message()
	if err != nil {
		return wireMessage{}, usage, err
	}
	return message, usage, nil
}

type responseReasoningItem struct {
	key, id string
	parts   []string
}

type responseReasoningStream struct {
	visible *reasoningStream
	byIndex map[int]*responseReasoningItem
	byID    map[string]*responseReasoningItem
	current *responseReasoningItem
	count   int
}

func newResponseReasoningStream(visible *reasoningStream) *responseReasoningStream {
	return &responseReasoningStream{visible: visible, byIndex: map[int]*responseReasoningItem{}, byID: map[string]*responseReasoningItem{}}
}

func (s *responseReasoningStream) item(index int, id string, start bool) *responseReasoningItem {
	item := s.byID[id]
	if item == nil && index >= 0 {
		candidate := s.byIndex[index]
		if candidate != nil && (id == "" || candidate.id == "" || candidate.id == id) {
			item = candidate
		}
	}
	if item == nil && !start && s.current != nil && s.current.id == "" && s.byIndex[-1] == s.current {
		// Bind an unaddressed stream once the provider finally names it.
		item = s.current
		delete(s.byIndex, -1)
	}
	if item == nil && !start && index == -1 && id == "" {
		item = s.current
	}
	if item == nil {
		s.count++
		key := "item-" + id
		if id == "" {
			key = fmt.Sprintf("output-%d", index)
			if index == -1 {
				key += fmt.Sprintf("-%d", s.count)
			}
		}
		item = &responseReasoningItem{key: key}
	}
	if id != "" {
		item.id = id
		s.byID[id] = item
	}
	if index >= 0 {
		s.byIndex[index] = item
	} else if id == "" {
		s.byIndex[-1] = item
	}
	s.current = item
	return item
}

func (s *responseReasoningStream) key(item *responseReasoningItem, kind string, index int) string {
	key := fmt.Sprintf("%s-%s-%d", kind, item.key, index)
	for _, existing := range item.parts {
		if existing == key {
			return key
		}
	}
	item.parts = append(item.parts, key)
	return key
}

func (s *responseReasoningStream) delta(kind string, outputIndex int, id string, partIndex int, text string) error {
	item := s.item(outputIndex, id, false)
	return s.visible.part(kind, s.key(item, kind, partIndex), text)
}

func (s *responseReasoningStream) snapshot(kind string, outputIndex int, id string, partIndex int, text string, done bool) error {
	item := s.item(outputIndex, id, false)
	return s.visible.snapshot(kind, s.key(item, kind, partIndex), text, done)
}

func (s *responseReasoningStream) output(index int, output responseOutput, done bool) error {
	item := s.item(index, output.ID, !done)
	for index, summary := range output.Summary {
		if summary.Type == "summary_text" {
			if err := s.visible.snapshot("summary", s.key(item, "summary", index), summary.Text, done); err != nil {
				return err
			}
		}
	}
	for index, content := range output.Content {
		if content.Type == "reasoning_text" {
			if err := s.visible.snapshot("reasoning", s.key(item, "reasoning", index), content.Text, done); err != nil {
				return err
			}
		}
	}
	if done {
		for _, key := range item.parts {
			if err := s.visible.finish(key); err != nil {
				return err
			}
		}
	}
	return nil
}

type responsePublicText struct {
	ID, Phase, Kind string
	Parts           map[int]string
}

func (p *responsePublicText) text() string {
	indexes := make([]int, 0, len(p.Parts))
	for index := range p.Parts {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	var text strings.Builder
	for _, index := range indexes {
		text.WriteString(p.Parts[index])
	}
	return text.String()
}

func (r responseOutput) publicText() string {
	var text strings.Builder
	for _, content := range r.Content {
		if content.Type == "output_text" {
			text.WriteString(content.Text)
		} else if content.Type == "refusal" {
			text.WriteString(content.Refusal)
		}
	}
	return text.String()
}
