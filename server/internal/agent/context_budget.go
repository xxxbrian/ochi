package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type ContextBudget struct {
	Window            int  `json:"window"`
	UnknownWindow     bool `json:"unknown_window"`
	SystemTokens      int  `json:"system_tokens"`
	HistoryTokens     int  `json:"history_tokens"`
	ToolTokens        int  `json:"tool_tokens"`
	DynamicTokens     int  `json:"dynamic_tokens"`
	OutputTokens      int  `json:"output_tokens"`
	InputTokens       int  `json:"input_tokens"`
	LimitInputTokens  int  `json:"limit_input_tokens"`
	TargetInputTokens int  `json:"target_input_tokens"`
}

const unknownContextWindow = 16384

func contextWindow(config Config) int {
	if config.ContextWindow > 0 {
		return config.ContextWindow
	}
	return unknownContextWindow
}

func outputBudget(config Config) int {
	if config.MaxOutputTokens > 0 {
		return config.MaxOutputTokens
	}
	// Leave most of the context for input without starving reasoning models.
	// A catalog ceiling constrains this budget; it is not a generation target.
	budget := min(65536, contextWindow(config)/4)
	if config.ReasoningKind == "budget" && config.ReasoningBudget > 0 {
		budget = max(budget, config.ReasoningBudget+1024)
	}
	if config.OutputTokenLimit > 0 {
		budget = min(budget, config.OutputTokenLimit)
	}
	return budget
}

func (g *OpenAI) contextBudget(ctx context.Context, req Request, messages []wireMessage, tools []wireTool) (ContextBudget, error) {
	input, err := g.runMessages(ctx, req, messages)
	if err != nil {
		return ContextBudget{}, err
	}
	return g.budgetForInput(messages, input, tools), nil
}

func (g *OpenAI) budgetForInput(history, input []wireMessage, tools []wireTool) ContextBudget {
	window := contextWindow(g.config)
	budget := ContextBudget{Window: window, UnknownWindow: g.config.ContextWindow <= 0, OutputTokens: outputBudget(g.config)}
	budget.LimitInputTokens = max(0, min(window*7/10, window-budget.OutputTokens-256))
	budget.TargetInputTokens = max(0, min(window*55/100, window-budget.OutputTokens-256))
	for index, message := range input {
		tokens := estimateMessageTokens(message, g.config.Protocol)
		switch {
		case index >= len(history):
			budget.DynamicTokens += tokens
		case index == 0 && message.Role == "system":
			budget.SystemTokens += tokens
		default:
			budget.HistoryTokens += tokens
		}
	}
	budget.ToolTokens = estimateToolTokens(tools)
	budget.InputTokens = budget.SystemTokens + budget.HistoryTokens + budget.ToolTokens + budget.DynamicTokens
	return budget
}

// A conservative estimate, not a provider tokenizer. Non-ASCII text is counted
// per code point; compact JSON/English receives at most three bytes per token.
func estimateTextTokens(text string) int {
	ascii, other := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+2)/3 + other
}

func estimateToolTokens(tools []wireTool) int {
	if len(tools) == 0 {
		return 0
	}
	data, _ := json.Marshal(tools)
	return estimateTextTokens(string(data)) + 8*len(tools)
}

func estimateMessageTokens(message wireMessage, protocol string) int {
	if protocol == "openai-responses" && len(message.ResponsesItems) > 0 {
		return estimateTextTokens(string(message.ResponsesItems)) + 12
	}
	message.ResponsesItems = nil
	data, _ := json.Marshal(message)
	if !strings.Contains(string(data), `"image_url"`) {
		return estimateTextTokens(string(data)) + 12
	}
	var decoded any
	_ = json.Unmarshal(data, &decoded)
	images := 0
	var stripImages func(any)
	stripImages = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			if value["type"] == "image_url" {
				value["image_url"] = "[image]"
				images++
				return
			}
			for _, child := range value {
				stripImages(child)
			}
		case []any:
			for _, child := range value {
				stripImages(child)
			}
		}
	}
	stripImages(decoded)
	data, _ = json.Marshal(decoded)
	return estimateTextTokens(string(data)) + images*2000 + 12
}

type ContextBudgetError struct{ Budget ContextBudget }

func (e *ContextBudgetError) Error() string {
	return fmt.Sprintf("model context cannot fit the current user input, instructions and tool schemas after safe compaction (estimated input %d, available %d); shorten the current input or reduce enabled tools", e.Budget.InputTokens, e.Budget.LimitInputTokens)
}
