package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

func (g *OpenAI) Generate(ctx context.Context, req Request, emit func(Update) error) error {
	runner := *g
	config := g.config
	if req.Config != nil {
		config = *req.Config
		runner.client = providerClient(config)
	}
	runner.config = cloneConfig(config)
	runner.config.BaseURL = strings.TrimRight(runner.config.BaseURL, "/")
	req.Config = nil
	if req.Budget == nil {
		rounds := runner.config.MaxToolRounds
		if rounds <= 0 {
			rounds = 48
		}
		req.Budget = NewExecutionBudget(rounds + 1)
	}
	return runner.generate(ctx, req, emit)
}

func (g *OpenAI) generate(ctx context.Context, req Request, emit func(Update) error) error {
	if g.config.BaseURL == "" || (g.config.APIKey == "" && !g.config.AllowNoKey) || g.config.Model == "" {
		return errors.New("请先在管理后台配置可用模型")
	}
	if g.config.ReasoningKind == "budget" && g.config.ReasoningBudget > 0 && outputBudget(g.config) <= g.config.ReasoningBudget {
		g.observe(Diagnostic{Kind: "request_failed", Class: "configuration", Message: "output cap must exceed the selected thinking token budget"})
		return &ModelError{Class: "configuration"}
	}
	if g.config.OutputTokenLimit > 0 && outputBudget(g.config) > g.config.OutputTokenLimit {
		g.observe(Diagnostic{Kind: "request_failed", Class: "configuration", Message: "the requested output cap exceeds the model output limit"})
		return &ModelError{Class: "configuration"}
	}
	if outputBudget(g.config)+256 >= contextWindow(g.config) {
		g.observe(Diagnostic{Kind: "request_failed", Class: "configuration", Message: "the selected output/thinking cap leaves no input space; configure the model context window or output cap"})
		return &ModelError{Class: "configuration"}
	}
	messages := []wireMessage{{Role: "system", Content: g.stablePrompt(req)}}
	if req.Compaction != nil && req.Compaction.Summary != "" {
		messages = append(messages, summaryMessage(req.Compaction.Summary), wireMessage{Role: "assistant", Content: "我会继续此前的任务。"})
	}
	if len(req.History) > 0 {
		for _, entry := range req.History {
			if req.Compaction != nil && entry.Seq <= req.Compaction.ThroughSeq {
				continue
			}
			var m wireMessage
			if err := json.Unmarshal(entry.Payload, &m); err != nil {
				return fmt.Errorf("invalid saved conversation: %w", err)
			}
			m.seq = entry.Seq
			// Provider-private reasoning replay is not portable when switching models.
			if entry.ProviderID != g.config.ProviderID || entry.ModelID != g.config.ModelID {
				m.ReasoningContent = ""
				m.ReasoningDetails = nil
				m.Reasoning, m.ReasoningSummary, m.ResponsesItems = nil, nil, nil
			}
			messages = append(messages, m)
		}
	} else {
		for _, m := range req.Messages {
			messages = append(messages, wireMessage{Role: m.Role, Content: m.Content})
		}
	}
	_, err := g.acceptBoundary(ctx, &req, &messages)
	if err != nil {
		return err
	}
	tools, err := g.availableTools(ctx, req)
	if err != nil {
		return err
	}
	messages, err = g.compact(ctx, &req, messages, tools, emit)
	if err != nil {
		return err
	}
	rounds := g.config.MaxToolRounds
	if rounds <= 0 {
		rounds = 48
	}
	detector := loopDetector{}
	permissionDenied := false
	for round := 0; round < rounds; round++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if req.Budget.Remaining() <= 1 {
			return g.finish(ctx, req, messages, "共享模型请求预算只够最后答复，不再执行新工具动作。", emit)
		}
		if round > 0 {
			// Only change the tool catalogue at a completed call boundary; canonical
			// history and the stable system prefix are never rebuilt from the UI.
			tools, err = g.availableTools(ctx, req)
			if err != nil {
				return err
			}
			messages, err = g.compact(ctx, &req, messages, tools, emit)
			if err != nil {
				return err
			}
		}
		response, usage, nextMessages, err := g.streamWithRecovery(ctx, &req, messages, tools, fmt.Sprintf("round-%d", round+1), emit)
		messages = nextMessages
		if usage != nil {
			if usageErr := emit(Update{Usage: usage}); err == nil {
				err = usageErr
			}
		}
		if err != nil {
			return err
		}
		payload, err := json.Marshal(response)
		if err != nil {
			return err
		}
		canonical := CanonicalMessage{ModelID: g.config.ModelID, ProviderID: g.config.ProviderID, Payload: payload}
		if err := emit(Update{Canonical: &canonical}); err != nil {
			return err
		}
		req.History = append(req.History, canonical)
		response.seq = canonical.Seq
		messages = append(messages, response)
		if len(response.ToolCalls) == 0 {
			accepted, err := g.acceptBoundary(ctx, &req, &messages)
			if err != nil {
				return err
			}
			if !accepted {
				return emit(Update{CommitOutput: true})
			}
			if err := emit(Update{ResetOutput: true}); err != nil {
				return err
			}
			continue
		}
		// Tool preambles remain in the canonical transcript, never in the final reply.
		if err := emit(Update{ResetOutput: true}); err != nil {
			return err
		}
		var screenshots []map[string]any
		definitions := toolCatalogue(tools)
		outcomes := make([]toolOutcome, len(response.ToolCalls))
		for index, call := range response.ToolCalls {
			outcomes[index] = prepareToolCall(call, definitions)
		}
		loopReason := ""
		for index := 0; index < len(outcomes); {
			end := index + 1
			if loopReason != "" {
				end = len(outcomes)
			} else if parallelTool(outcomes[index]) {
				for end < len(outcomes) && end-index < 4 && parallelTool(outcomes[end]) {
					end++
				}
			}
			dispatched := loopReason == ""
			if dispatched {
				for current := index; current < end; current++ {
					if err := emit(Update{Step: &outcomes[current].step}); err != nil {
						return err
					}
				}
				g.executeToolBatch(ctx, req, outcomes[index:end], &permissionDenied)
			} else {
				for current := index; current < end; current++ {
					skipToolCall(&outcomes[current], loopReason)
				}
			}
			for current := index; current < end; current++ {
				outcome := &outcomes[current]
				if dispatched && loopReason == "" {
					// Drain an already-started read batch, but never let a later
					// success clear the cutoff and start another batch.
					loopReason = detector.observe(outcome.call, outcome.step, outcome.execution)
				}
				if dispatched && outcome.step.Status == "failed" {
					class := "tool_error"
					var invalid *ToolArgumentError
					if errors.As(outcome.err, &invalid) {
						class = invalid.Code
					}
					g.observe(Diagnostic{Kind: "tool_failed", Class: class})
				}
				if err := emit(Update{Step: &outcome.step}); err != nil {
					return err
				}
				if outcome.result.Usage != nil {
					if err := emit(Update{Usage: outcome.result.Usage}); err != nil {
						return err
					}
				}
				tool := wireMessage{Role: "tool", ToolCallID: outcome.call.ID, Content: outcome.step.Output}
				payload, _ := json.Marshal(tool)
				canonical = CanonicalMessage{ModelID: g.config.ModelID, ProviderID: g.config.ProviderID, Payload: payload}
				if err := emit(Update{Canonical: &canonical}); err != nil {
					return err
				}
				req.History = append(req.History, canonical)
				tool.seq = canonical.Seq
				messages = append(messages, tool)
				if outcome.result.Screenshot != "" && (g.config.SupportsVision || g.config.ModelID == "") {
					screenshots = append(screenshots, map[string]any{"type": "image_url", "image_url": map[string]string{"url": outcome.result.Screenshot}})
				}
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			index = end
		}
		if len(screenshots) > 0 {
			content := append([]map[string]any{{"type": "text", "text": "工作区截图："}}, screenshots...)
			image := wireMessage{Role: "user", Observation: true, Content: content}
			canonical.Payload, _ = json.Marshal(image)
			if err := emit(Update{Canonical: &canonical}); err != nil {
				return err
			}
			req.History = append(req.History, canonical)
			image.seq = canonical.Seq
			messages = append(messages, image)
		}
		if _, err := g.acceptBoundary(ctx, &req, &messages); err != nil {
			return err
		}
		if loopReason != "" {
			g.observe(Diagnostic{Kind: "loop_stopped", Class: loopReason})
			return g.finish(ctx, req, messages, "工具动作重复且没有新进展，不再重复相同请求。", emit)
		}
	}
	// A bounded tool loop must still produce a deliverable. Asking once without
	// tools keeps existing work visible rather than failing after all side effects.
	return g.finish(ctx, req, messages, "本轮工具操作次数已用完。", emit)
}

func permissionResult(choice string) string {
	switch choice {
	case "allow_once":
		return "Computer access approved for this turn only. The conversation default remains unchanged. Continue only the requested scope."
	case "allow_session":
		return "Computer access approved for this conversation. Continue only the requested scope."
	default:
		return "Computer access denied. Continue using public web/API access and isolated computation if possible; do not repeat this permission request or bypass it. Explain only the specific unavailable part."
	}
}

func (g *OpenAI) availableTools(ctx context.Context, req Request) ([]wireTool, error) {
	if g.config.Tools == nil || (g.config.ModelID != "" && !g.config.SupportsTools) {
		return nil, nil
	}
	definitions, err := g.config.Tools.Definitions(ctx, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("workspace unavailable: %w", err)
	}
	if req.AskUser != nil {
		definitions = append(definitions,
			ToolDefinition{Name: "request_user_input", Description: "Ask for missing information or a decision, then wait. Computer authorization must use request_computer_permission, not this tool.", Parameters: json.RawMessage(`{"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["question"]}`)},
			ToolDefinition{Name: "request_computer_permission", Description: "Request permission only when the task needs the user's persistent computer, existing Project files, logged-in browser/desktop, Skills or MCP. Public network access, isolated code execution and this conversation's file processing remain available without it. This tool is the user's consent step: for a task already requested by the user, call it directly rather than asking in ordinary text whether to request permission. A missing file in the isolated environment says nothing about existing persistent files. Give a specific reason, wait for the user's typed choice and never self-authorize.", Parameters: json.RawMessage(`{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"],"additionalProperties":false}`)},
		)
	}
	sort.Slice(definitions, func(i, j int) bool { return definitions[i].Name < definitions[j].Name })
	tools := []wireTool{}
	for _, d := range definitions {
		if g.config.ModelID != "" && !g.config.SupportsVision && (strings.HasPrefix(d.Name, "computer_") || d.Name == "browser_screenshot") {
			continue
		}
		tools = append(tools, wireTool{Type: "function", Function: d})
	}
	return tools, nil
}

const finalAnswerPolicy = "不要再调用工具，立即给出最终答复：交付已经完成的实际成果与真实文件链接；仅在仍有未完成内容时简短说明，不声称未验证的内容成功。保留用户要求的输出形式，不额外添加格式包装；纯 JSON 不添加 Markdown 代码围栏，未完成内容也在用户指定形式中如实表达。"

func (g *OpenAI) finish(ctx context.Context, req Request, messages []wireMessage, reason string, emit func(Update) error) error {
	messages = append(messages, wireMessage{Role: "system", Content: reason + finalAnswerPolicy})
	messages, err := g.compact(ctx, &req, messages, nil, emit)
	if err != nil {
		return err
	}
	response, usage, _, err := g.streamWithRecovery(ctx, &req, messages, nil, "final", emit)
	if usage != nil {
		if usageErr := emit(Update{Usage: usage}); err == nil {
			err = usageErr
		}
	}
	if err != nil {
		return err
	}
	if len(response.ToolCalls) > 0 {
		return errors.New("model requested tools after the operation limit")
	}
	payload, _ := json.Marshal(response)
	canonical := CanonicalMessage{ModelID: g.config.ModelID, ProviderID: g.config.ProviderID, Payload: payload}
	if err := emit(Update{Canonical: &canonical}); err != nil {
		return err
	}
	return emit(Update{CommitOutput: true})
}
func toolOutputFailed(output string) bool {
	var result struct {
		ExitCode *int `json:"exit_code"`
		TimedOut bool `json:"timed_out"`
		IsError  bool `json:"isError"`
	}
	if json.Unmarshal([]byte(output), &result) != nil {
		return false
	}
	return result.TimedOut || result.IsError || (result.ExitCode != nil && *result.ExitCode != 0)
}
