package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const PromptVersion = "ochi-core-2026-10-14.5"

type ContextPart struct {
	Source string `json:"source"`
	Bytes  int    `json:"bytes"`
}

// ContextInspection contains model input, never transport headers or secrets
// from provider configuration. Access to persisted records is owner-scoped.
type ContextInspection struct {
	PromptVersion string          `json:"prompt_version"`
	Round         string          `json:"round"`
	ModelID       string          `json:"model_id"`
	Protocol      string          `json:"protocol"`
	Timezone      string          `json:"timezone"`
	Parts         []ContextPart   `json:"parts"`
	Request       json.RawMessage `json:"request"`
	SHA256        string          `json:"sha256"`
	Budget        ContextBudget   `json:"budget"`
	Redacted      bool            `json:"redacted"`
}

func (g *OpenAI) contextInspection(req Request, round string, history, input []wireMessage, tools []wireTool) ContextInspection {
	body, _ := json.Marshal(g.requestBody(input, tools, true))
	sum := sha256.Sum256(body)
	parts := make([]ContextPart, 0, 5)
	if len(history) > 0 {
		data, _ := json.Marshal(history[0])
		parts = append(parts, ContextPart{Source: "stable_system", Bytes: len(data)})
		data, _ = json.Marshal(history[1:])
		parts = append(parts, ContextPart{Source: "canonical_history_and_current_input", Bytes: len(data)})
	}
	data, _ := json.Marshal(input[len(history):])
	parts = append(parts, ContextPart{Source: "live_state_and_retrieved_evidence", Bytes: len(data)})
	data, _ = json.Marshal(tools)
	parts = append(parts, ContextPart{Source: "tool_schemas", Bytes: len(data)})
	return ContextInspection{PromptVersion: PromptVersion, Round: round, ModelID: g.config.ModelID,
		Protocol: g.config.Protocol, Timezone: req.Timezone, Parts: parts, Request: body, SHA256: hex.EncodeToString(sum[:]), Budget: g.budgetForInput(history, input, tools)}
}
