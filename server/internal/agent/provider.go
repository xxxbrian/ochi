package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type Config struct {
	BaseURL            string
	Protocol           string
	APIKey             string
	Model              string
	ModelID            string
	ProviderID         string
	Headers            map[string]string
	TimeoutSeconds     int
	AllowNoKey         bool
	Effort             string
	EffortParameter    string
	EffortValue        json.RawMessage
	EffortMapping      map[string]json.RawMessage
	ReasoningKind      string
	ReasoningBudget    int
	ReasoningBudgetMin int
	ReasoningBudgetMax int
	ContextWindow      int
	MaxOutputTokens    int // Explicit request cap; zero selects an automatic budget.
	OutputTokenLimit   int // Known model capability; zero means unknown.
	SupportsTools      bool
	SupportsVision     bool
	SystemPrompt       string
	MaxToolRounds      int
	Tools              ToolSource
	CompactionConfig   *Config
	MemoryContext      string
	Observe            func(Diagnostic)
}

type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	Execution   *ToolExecution  `json:"-"`
}
type ToolResult struct {
	Output     string
	Screenshot string
	Usage      *Usage
}
type ToolSource interface {
	Definitions(context.Context, string) ([]ToolDefinition, error)
	Call(context.Context, string, string, json.RawMessage) (ToolResult, error)
}
type OpenAI struct {
	config Config
	client *http.Client
}

func NewOpenAI(config Config) (*OpenAI, error) {
	config = cloneConfig(config)
	config.BaseURL = strings.TrimRight(config.BaseURL, "/")
	if config.BaseURL == "" || (config.APIKey == "" && !config.AllowNoKey) || config.Model == "" {
		return nil, errors.New("MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME are required")
	}
	if config.MaxToolRounds == 0 {
		config.MaxToolRounds = 48
	}
	return &OpenAI{config: config, client: providerClient(config)}, nil
}

func cloneConfig(config Config) Config {
	copy := config
	copy.Headers = make(map[string]string, len(config.Headers))
	for key, value := range config.Headers {
		copy.Headers[key] = value
	}
	copy.EffortValue = append(json.RawMessage(nil), config.EffortValue...)
	copy.EffortMapping = make(map[string]json.RawMessage, len(config.EffortMapping))
	for key, value := range config.EffortMapping {
		copy.EffortMapping[key] = append(json.RawMessage(nil), value...)
	}
	if config.CompactionConfig != nil {
		auxiliary := *config.CompactionConfig
		auxiliary.CompactionConfig = nil
		auxiliary = cloneConfig(auxiliary)
		copy.CompactionConfig = &auxiliary
	}
	return copy
}

type toolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function functionCall `json:"function"`
}
type functionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type wireMessage struct {
	seq              int64
	summary          bool
	Role             string          `json:"role"`
	Observation      bool            `json:"ochi_workspace_observation,omitempty"`
	Content          any             `json:"content,omitempty"`
	ToolCalls        []toolCall      `json:"tool_calls,omitempty"`
	ToolCallID       string          `json:"tool_call_id,omitempty"`
	ReasoningContent string          `json:"reasoning_content,omitempty"`
	ReasoningDetails json.RawMessage `json:"reasoning_details,omitempty"`
	Reasoning        json.RawMessage `json:"reasoning,omitempty"`
	ReasoningSummary json.RawMessage `json:"reasoning_summary,omitempty"`
	ResponsesItems   json.RawMessage `json:"ochi_responses_items,omitempty"`
}
type wireTool struct {
	Type     string         `json:"type"`
	Function ToolDefinition `json:"function"`
}
