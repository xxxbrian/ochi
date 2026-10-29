package agent

import (
	"crypto/sha256"
	"encoding/json"
)

// A run-local measurement of one actual request, not cumulative billable usage.
// Hashes establish applicability without retaining another copy of the input.
type contextUsageAnchor struct {
	model, tools, history, dynamic [32]byte
	historyLength                  int
	heuristicInput, promptTokens   int
}

func contextHash(value any) [32]byte {
	data, _ := json.Marshal(value)
	return sha256.Sum256(data)
}

func (g *OpenAI) contextModelIdentity() [32]byte {
	return contextHash([]any{g.config.ProviderID, g.config.ModelID, g.config.BaseURL, g.config.Model, g.config.Protocol, g.config.Effort, g.config.EffortValue})
}

func dynamicContextIdentity(messages []wireMessage) [32]byte {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		if message.contextSignature != "" {
			// The server's changing clock is excluded; timezone, permissions,
			// retrieved memory, skills and task state remain part of the key.
			values = append(values, message.contextSignature)
		} else {
			values = append(values, message)
		}
	}
	return contextHash(values)
}

func (g *OpenAI) recordContextUsage(history, input []wireMessage, tools []wireTool, usage *Usage) {
	if usage == nil || usage.PromptTokens <= 0 || len(input) < len(history) || usage.PromptTokens > int64(^uint(0)>>1) {
		return
	}
	heuristic := estimateToolTokens(tools)
	for _, message := range input {
		heuristic += estimateMessageTokens(message, g.config.Protocol)
	}
	g.usageAnchor = &contextUsageAnchor{
		model: g.contextModelIdentity(), tools: contextHash(tools),
		history: contextHash(history), historyLength: len(history),
		dynamic:        dynamicContextIdentity(input[len(history):]),
		heuristicInput: heuristic, promptTokens: int(usage.PromptTokens),
	}
}

func (g *OpenAI) calibrateContextBudget(budget *ContextBudget, history, input []wireMessage, tools []wireTool) {
	anchor := g.usageAnchor
	if anchor == nil || len(history) < anchor.historyLength || len(input) < len(history) ||
		anchor.model != g.contextModelIdentity() || anchor.tools != contextHash(tools) ||
		anchor.history != contextHash(history[:anchor.historyLength]) ||
		anchor.dynamic != dynamicContextIdentity(input[len(history):]) {
		return
	}
	growth := max(0, budget.HeuristicInputTokens-anchor.heuristicInput)
	// Newly appended content still uses an estimate. Keep extra room for its
	// tokenizer variance; the unchanged prefix uses the provider's real count.
	increment := growth + (growth+9)/10
	budget.InputTokens = int(^uint(0) >> 1)
	if increment <= budget.InputTokens-anchor.promptTokens {
		budget.InputTokens = anchor.promptTokens + increment
	}
	budget.EstimateSource, budget.UsageAnchorTokens = "provider_usage", anchor.promptTokens
}
