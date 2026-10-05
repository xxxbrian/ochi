package agent

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Attachment struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	Path       string           `json:"path"`
	MIMEType   string           `json:"mime_type"`
	URL        string           `json:"url"`
	Size       int64            `json:"size"`
	SourcePath string           `json:"source_path,omitempty"`
	Version    int              `json:"version,omitempty"`
	DataURL    string           `json:"-"`
	Generation *ImageGeneration `json:"generation,omitempty"`
}

type ImageGeneration struct {
	Prompt        string `json:"prompt"`
	RevisedPrompt string `json:"revised_prompt,omitempty"`
	ModelID       string `json:"model_id"`
	ModelName     string `json:"model_name"`
	Size          string `json:"size,omitempty"`
	Quality       string `json:"quality,omitempty"`
	OutputFormat  string `json:"output_format,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
}

// RunScope is the explicit ownership and working-directory boundary passed to
// every workspace call. It must never be inferred from a user's active run.
type RunScope struct {
	UserID              string `json:"user_id"`
	SessionID           string `json:"session_id"`
	RunID               string `json:"run_id"`
	ProjectID           string `json:"project_id,omitempty"`
	WorkspaceID         string `json:"workspace_id"`
	CWD                 string `json:"cwd"`
	ProjectInstructions string `json:"project_instructions,omitempty"`
	ComputeOnly         bool   `json:"compute_only,omitempty"`
	OperationID         string `json:"operation_id,omitempty"`
}

type scopeKey struct{}

func WithRunScope(ctx context.Context, scope RunScope) context.Context {
	return context.WithValue(ctx, scopeKey{}, scope)
}

func ScopeFromContext(ctx context.Context) (RunScope, bool) {
	scope, ok := ctx.Value(scopeKey{}).(RunScope)
	return scope, ok
}

type CanonicalMessage struct {
	Seq        int64
	RunID      string
	ModelID    string
	ProviderID string
	Payload    json.RawMessage
}
type Compaction struct {
	ThroughSeq int64
	Summary    string
}
type Usage struct {
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	CachedTokens     *int64 `json:"cached_tokens,omitempty"`
	ReasoningTokens  *int64 `json:"reasoning_tokens,omitempty"`
}
type WaitingInput struct {
	Kind     string   `json:"kind,omitempty"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
}

type Request struct {
	Scope            RunScope
	RunID            string
	SessionID        string
	UserID           string
	Messages         []Message
	History          []CanonicalMessage
	Attachments      []Attachment
	Config           *Config
	Compaction       *Compaction
	Timezone         string
	SkillsIndex      string
	TaskContext      string
	ObserveContext   func(ContextInspection)
	BeforeCompaction func(context.Context) error
	AtBoundary       func(context.Context) (BoundaryUpdate, error)
	Budget           *ExecutionBudget
	AskUser          func(context.Context, WaitingInput) (string, error)
	ComputerAllowed  func(context.Context) (bool, error)
}

// The store commits supplemental user messages exactly once before returning
// them. The loop appends these to its input without persisting them a second time.
type BoundaryUpdate struct {
	Messages      []CanonicalMessage
	TaskContext   string
	SkillsIndex   string
	MemoryContext *string
}

type Step struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
	Output     string          `json:"output,omitempty"`
	Screenshot string          `json:"screenshot,omitempty"`
}

// ReasoningPart contains only text explicitly returned by the provider. Private
// signatures and encrypted replay state remain in the canonical transcript.
type ReasoningPart struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

type Update struct {
	Text         string
	TextKind     string // pending until the model round resolves, explicit progress, or final
	TextID       string // stable identity for provider-declared public progress
	CommitOutput bool
	Reasoning    *ReasoningPart
	Step         *Step
	ResetOutput  bool
	Canonical    *CanonicalMessage
	Compaction   *Compaction
	Usage        *Usage
}

type Generator interface {
	Generate(context.Context, Request, func(Update) error) error
}

// DemoGenerator is opt-in and exercises transport, not model or tool behavior.
type DemoGenerator struct{}

func (DemoGenerator) Generate(ctx context.Context, req Request, emit func(Update) error) error {
	prompt := ""
	if len(req.Messages) > 0 {
		prompt = req.Messages[len(req.Messages)-1].Content
	}
	response := "这是演示回复，不是实际任务结果。\n\n你刚才说：" + strings.TrimSpace(prompt) + "\n\n## 周末散步小计划\n\n找一个天气舒服的午后，出门走走，不用赶时间。\n\n- 选一条熟悉、平坦的路线。\n- 带上水，穿一双舒服的鞋。\n- 走累了就坐下来休息。\n\n可以把想带的东西记在一起：\n\n```text\n水、纸巾、钥匙、手机\n```\n\n愿你有一个轻松的周末。"
	for _, r := range response {
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if err := emit(Update{Text: string(r)}); err != nil {
			return err
		}
	}
	return nil
}
