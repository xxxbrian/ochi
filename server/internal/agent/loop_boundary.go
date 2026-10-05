package agent

import (
	"context"
	"encoding/json"
	"errors"
)

func (g *OpenAI) acceptBoundary(ctx context.Context, req *Request, messages *[]wireMessage) (bool, error) {
	if req.AtBoundary == nil {
		return false, nil
	}
	update, err := req.AtBoundary(ctx)
	if err != nil {
		return false, err
	}
	req.TaskContext = update.TaskContext
	req.SkillsIndex = update.SkillsIndex
	if update.MemoryContext != nil {
		g.config.MemoryContext = *update.MemoryContext
	}
	for _, canonical := range update.Messages {
		var message wireMessage
		if json.Unmarshal(canonical.Payload, &message) != nil || !isUserTurn(message) || len(message.ToolCalls) != 0 {
			return false, errors.New("invalid accepted steering input")
		}
		// The boundary callback durably committed these messages already. Never
		// persist them twice or allow steering to replace the frozen run model.
		req.History = append(req.History, canonical)
		message.seq = canonical.Seq
		*messages = append(*messages, message)
	}
	return len(update.Messages) > 0, nil
}

func (g *OpenAI) streamWithRecovery(ctx context.Context, req *Request, messages []wireMessage, tools []wireTool, reasonID string, emit func(Update) error) (wireMessage, *Usage, []wireMessage, error) {
	for recovery := 0; ; recovery++ {
		finalOnly := len(tools) > 0 && req.Budget.Remaining() <= 1
		if finalOnly {
			tools = nil
			messages = append(messages, wireMessage{Role: "system", Content: "共享模型请求预算只够最后答复。" + finalAnswerPolicy})
		}
		response, usage, err := g.streamRun(ctx, *req, messages, tools, reasonID, emit)
		if err == nil {
			if finalOnly && len(response.ToolCalls) > 0 {
				return response, usage, messages, errors.New("model requested tools after the shared operation limit")
			}
			return response, usage, messages, nil
		}
		var model *ModelError
		if recovery >= 1 || !errors.As(err, &model) || model.Class != "context" || model.committed {
			return response, usage, messages, err
		}
		g.observe(Diagnostic{Kind: "context_overflow_recovery", Class: "context", Attempt: recovery + 1, StatusCode: model.StatusCode})
		compacted, compactErr := g.compactToBudget(ctx, req, messages, tools, true, emit)
		if compactErr != nil {
			return response, usage, messages, compactErr
		}
		messages = compacted
	}
}
