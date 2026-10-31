package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ochi/server/internal/agent"
)

func computerQueueDefinitions() []agent.ToolDefinition {
	return []agent.ToolDefinition{
		{
			Name:        "computer_queue",
			Description: "Continue a paused desktop/workspace request with a new foreground blocking wait, or cancel it. Paused requests retain their original priority without expiry, hold no lease and never execute in the background. A desktop grant returns a fresh observation; the original action was not executed and must be planned again. wait_ms is an optional reporting checkpoint, not an execution timeout; omitted checkpoints grow from 2 to at most 15 minutes.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"action":{"type":"string","enum":["wait","cancel"]},"request_id":{"type":"string","minLength":1,"maxLength":160},"wait_ms":{"type":"integer","minimum":1000,"maximum":900000}},"required":["action","request_id"],"additionalProperties":false}`),
			Execution:   &agent.ToolExecution{},
		},
		{
			Name:        "computer_release",
			Description: "Release this run's continuous desktop ownership before independent computation, research or a user decision. Active desktop Jobs must first be stopped and drained with job; isolated compute Jobs are unaffected. A later acquisition joins a new FIFO position.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
			Execution:   &agent.ToolExecution{},
		},
	}
}

func (s *Server) resourceQueueProgress(scope agent.RunScope, state resourceQueueCheckpoint) {
	if s.runtime == nil {
		return
	}
	run, ok := s.runtime.Get(scope.RunID)
	if !ok {
		return
	}
	output, _ := json.Marshal(state)
	if run.UpdateToolProgress(scope.OperationID, string(output)) != nil || s.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkpointTimeout)
	defer cancel()
	_ = s.store.Checkpoint(ctx, run.Snapshot())
}

func queueCheckpointResult(state *resourceQueueCheckpoint) agent.ToolResult {
	output, _ := json.Marshal(state)
	return agent.ToolResult{Output: string(output), Replan: true}
}

func (p *personalTools) computerQueueTool(ctx context.Context, scope agent.RunScope, args json.RawMessage) (agent.ToolResult, error) {
	var input struct {
		Action    string `json:"action"`
		RequestID string `json:"request_id"`
		WaitMS    int64  `json:"wait_ms"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return agent.ToolResult{}, err
	}
	owner := resourceOwner{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID}
	if input.Action == "cancel" {
		if err := p.server.resources.cancelRequest(owner, input.RequestID); err != nil {
			return agent.ToolResult{}, err
		}
		output, _ := json.Marshal(map[string]any{"status": "cancelled", "executed": false, "request_id": input.RequestID})
		return agent.ToolResult{Output: string(output), NotExecuted: true}, nil
	}
	admission, err := p.server.continueToolResources(ctx, scope, input.RequestID, time.Duration(input.WaitMS)*time.Millisecond)
	if err != nil {
		return agent.ToolResult{}, err
	}
	if admission.Checkpoint != nil {
		return queueCheckpointResult(admission.Checkpoint), nil
	}
	if !admission.Fresh {
		output, _ := json.Marshal(map[string]any{
			"status": "acquired", "executed": false, "request_id": input.RequestID, "resource": "project",
			"message": "Workspace resources acquired. The original action was not executed. Plan it again using the current state.",
		})
		return agent.ToolResult{Output: string(output), Replan: true}, nil
	}
	return p.freshDesktopObservation(ctx, scope, input.RequestID, "computer_observe")
}

func (p *personalTools) computerReleaseTool(ctx context.Context, scope agent.RunScope) (agent.ToolResult, error) {
	if source := p.server.workspaceJobs(); source != nil {
		jobs, err := source.ActiveJobs(ctx, scope.UserID)
		if err != nil {
			return agent.ToolResult{}, err
		}
		owned := []string{}
		for _, job := range jobs {
			if job.SessionID == scope.SessionID && hasClaim(job.ResourceClaims, "desktop") {
				owned = append(owned, job.ID)
			}
		}
		if len(owned) > 0 {
			output, _ := json.Marshal(map[string]any{
				"status": "jobs_running", "executed": false, "job_ids": owned,
				"message": "Stop these desktop Jobs with job and wait for them to drain before releasing the desktop.",
			})
			return agent.ToolResult{Output: string(output), NotExecuted: true}, nil
		}
	}
	p.server.resources.releaseRunLeases(scope.RunID)
	output, _ := json.Marshal(map[string]any{"status": "released", "executed": false})
	return agent.ToolResult{Output: string(output), NotExecuted: true}, nil
}

// The initial action can contain coordinates or refs observed by a previous
// lease. Admission returns new state instead of replaying that action.
func needsFreshDesktopState(name string) bool {
	if strings.HasPrefix(name, "computer_") {
		return name != "computer_observe" && name != "computer_screenshot"
	}
	if strings.HasPrefix(name, "browser_") {
		switch name {
		case "browser_observe", "browser_screenshot", "browser_status", "browser_tabs", "browser_goto":
			return false
		default:
			return true
		}
	}
	return false
}

func (p *personalTools) freshDesktopObservation(ctx context.Context, scope agent.RunScope, requestID, name string) (agent.ToolResult, error) {
	if p.source == nil {
		return agent.ToolResult{}, errors.New("desktop observation is unavailable")
	}
	if err := p.server.activateDesktop(ctx, scope); err != nil {
		return agent.ToolResult{}, err
	}
	args := json.RawMessage(`{"max_chars":12000,"include_image":true}`)
	if strings.HasPrefix(name, "browser_") {
		name, args = "browser_observe", json.RawMessage(`{"max_chars":12000}`)
	} else {
		name = "computer_observe"
	}
	result, err := p.source.Call(agent.WithRunScope(ctx, scope), scope.UserID, name, args)
	if err != nil {
		return result, err
	}
	var observation any
	if json.Unmarshal([]byte(result.Output), &observation) != nil {
		observation = result.Output
	}
	output, _ := json.Marshal(map[string]any{
		"status": "acquired", "executed": false, "request_id": requestID, "resource": "desktop",
		"observation": observation,
		"message":     "Desktop acquired. The original action was not executed. Plan the next action using this fresh observation.",
	})
	result.Output, result.Replan = string(output), true
	return result, nil
}
