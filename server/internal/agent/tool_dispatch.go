package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

type toolOutcome struct {
	call      toolCall
	step      Step
	result    ToolResult
	execution *ToolExecution
	err       error
}

type toolRunRequestKey struct{}

// ToolRunRequest exposes a read-only run-local snapshot at a completed model
// boundary. Isolated research sees accepted steering without changing the model.
func ToolRunRequest(ctx context.Context) (Request, bool) {
	req, ok := ctx.Value(toolRunRequestKey{}).(Request)
	return req, ok
}

func toolCatalogue(tools []wireTool) map[string]ToolDefinition {
	definitions := make(map[string]ToolDefinition, len(tools))
	for _, tool := range tools {
		definitions[tool.Function.Name] = tool.Function
	}
	return definitions
}

func prepareToolCall(call toolCall, definitions map[string]ToolDefinition) toolOutcome {
	arguments := json.RawMessage(call.Function.Arguments)
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	outcome := toolOutcome{call: call, step: Step{ID: call.ID, Name: call.Function.Name, Status: "running", Arguments: arguments}}
	definition, found := definitions[call.Function.Name]
	if !found {
		outcome.err = errors.New("tool is not present in the currently allowed catalogue")
	} else {
		outcome.execution = definition.Execution
		outcome.err = ValidateToolArguments(definition, arguments)
	}
	if !json.Valid(arguments) {
		outcome.step.Arguments = json.RawMessage(`{}`)
	}
	return outcome
}

func parallelTool(outcome toolOutcome) bool {
	if outcome.err != nil || outcome.execution == nil {
		return false
	}
	execution := outcome.execution
	return execution.ReadOnly && execution.ParallelSafe && !execution.ExternalSend && !execution.Irreversible &&
		len(execution.Resources) == 0 &&
		outcome.call.Function.Name != "request_user_input" && outcome.call.Function.Name != "request_computer_permission"
}

func skipToolCall(outcome *toolOutcome, reason string) {
	// Every declared call still needs a canonical result. This is an explicit
	// non-execution record, not a fabricated failure from the underlying tool.
	output, _ := json.Marshal(map[string]any{"isError": true, "code": "not_dispatched", "reason": reason, "error": "Tool was not dispatched because the loop stopped after repeated failures or no progress."})
	outcome.result = ToolResult{Output: string(output)}
	outcome.step.Status, outcome.step.Outcome, outcome.step.Output = "failed", "failure", string(output)
}

func skipToolForReplan(outcome *toolOutcome) {
	output, _ := json.Marshal(map[string]any{
		"code": "not_dispatched", "executed": false,
		"reason": "A preceding resource wait or fresh desktop observation requires a new plan. This call was not executed; reassess it using the latest state.",
	})
	outcome.result = ToolResult{Output: string(output), NotExecuted: true}
	outcome.step.Status, outcome.step.Outcome, outcome.step.Output = "completed", "not_executed", string(output)
}

func (g *OpenAI) executeTool(ctx context.Context, req Request, outcome *toolOutcome, permissionDenied *bool) {
	scope, ok := ScopeFromContext(ctx)
	if !ok {
		scope = req.Scope
	}
	scope.OperationID = outcome.call.ID
	ctx = WithRunScope(ctx, scope)
	snapshot := req
	frozenConfig := cloneConfig(g.config)
	snapshot.Config = &frozenConfig
	ctx = context.WithValue(ctx, toolRunRequestKey{}, snapshot)
	if outcome.err == nil && ctx.Err() != nil {
		outcome.err = ctx.Err()
	}
	if outcome.err == nil {
		arguments := outcome.step.Arguments
		switch outcome.call.Function.Name {
		case "request_user_input":
			var input WaitingInput
			if err := json.Unmarshal(arguments, &input); err != nil || strings.TrimSpace(input.Question) == "" {
				outcome.err = errors.New("question is required")
			} else if req.AskUser == nil {
				outcome.err = errors.New("user input is unavailable")
			} else {
				input.Kind = "question"
				outcome.result.Output, outcome.err = req.AskUser(ctx, input)
			}
		case "request_computer_permission":
			var input struct {
				Reason string `json:"reason"`
			}
			if *permissionDenied {
				outcome.result.Output = permissionResult("deny")
			} else if err := json.Unmarshal(arguments, &input); err != nil || strings.TrimSpace(input.Reason) == "" {
				outcome.err = errors.New("a specific reason is required")
			} else if req.AskUser == nil {
				outcome.err = errors.New("computer permission is unavailable")
			} else {
				allowed := false
				if req.ComputerAllowed != nil {
					allowed, outcome.err = req.ComputerAllowed(ctx)
				}
				if outcome.err == nil && allowed {
					outcome.result.Output = "Computer access is already allowed for this conversation/turn."
				} else if outcome.err == nil {
					choice, err := req.AskUser(ctx, WaitingInput{Kind: "computer_permission", Question: strings.TrimSpace(input.Reason), Options: []string{"allow_once", "allow_session", "deny"}})
					outcome.err = err
					if err == nil {
						*permissionDenied = choice == "deny"
						outcome.result.Output = permissionResult(choice)
					}
				}
			}
		default:
			if g.config.Tools == nil {
				outcome.err = errors.New("no workspace is configured")
			} else {
				outcome.result, outcome.err = g.config.Tools.Call(ctx, req.UserID, outcome.call.Function.Name, arguments)
			}
		}
	}
	outcome.step.Output, outcome.step.Screenshot, outcome.step.Status = outcome.result.Output, outcome.result.Screenshot, "completed"
	if outcome.err != nil {
		outcome.step.Status = "failed"
		if outcome.step.Output == "" {
			outcome.step.Output = outcome.err.Error()
		}
	} else if !outcome.result.Replan && !outcome.result.NotExecuted && toolOutputFailed(outcome.result.Output) {
		outcome.step.Status = "failed"
	}
	outcome.step.Outcome = "success"
	if outcome.step.Status == "failed" {
		outcome.step.Outcome = "failure"
	} else if outcome.result.Replan || outcome.result.NotExecuted {
		outcome.step.Outcome = "not_executed"
	} else {
		var result struct {
			NeedsUser  bool `json:"needs_user"`
			Automation struct {
				NeedsUser bool `json:"needs_user"`
			} `json:"automation"`
		}
		if json.Unmarshal([]byte(outcome.result.Output), &result) == nil && (result.NeedsUser || result.Automation.NeedsUser) {
			outcome.step.Outcome = "needs_user"
		}
	}

}

// Batches are contiguous and bounded. Writes, resource claims, questions and
// unknown tools are barriers; results are committed in model order.
func (g *OpenAI) executeToolBatch(ctx context.Context, req Request, outcomes []toolOutcome, permissionDenied *bool) {
	if len(outcomes) == 1 {
		g.executeTool(ctx, req, &outcomes[0], permissionDenied)
		return
	}
	var wait sync.WaitGroup
	for index := range outcomes {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			denied := false
			g.executeTool(ctx, req, &outcomes[index], &denied)
		}(index)
	}
	wait.Wait()
}
