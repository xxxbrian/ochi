package workspace

import (
	"context"
	"encoding/json"
	"errors"

	"ochi/server/internal/agent"
)

func ordinaryTool(name string) bool {
	switch name {
	case "exec", "job", "files_list", "files_read", "files_write", "web_fetch":
		return true
	}
	return false
}

// The API resolves permissions and prepares files before dispatch. The bridge
// repeats the target check so a caller cannot silently run in the other volume.
func executionContext(ctx context.Context, name string, args json.RawMessage) (context.Context, error) {
	if !ordinaryTool(name) {
		return ctx, nil
	}
	var input struct {
		Environment string `json:"environment"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return ctx, err
	}
	environment := input.Environment
	if environment == "" {
		environment = "compute"
	}
	if environment != "compute" && environment != "desktop" {
		return ctx, errors.New("execution environment must be compute or desktop")
	}
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.SessionID == "" {
		return ctx, errors.New("execution requires a conversation scope")
	}
	if scope.ExecutionEnvironment != "" && scope.ExecutionEnvironment != environment {
		return ctx, errors.New("execution environment does not match the prepared scope")
	}
	if environment == "desktop" && scope.ComputeOnly {
		return ctx, errors.New("desktop execution requires computer permission")
	}
	scope.ExecutionEnvironment = environment
	scope.ComputeOnly = environment == "compute"
	return agent.WithRunScope(ctx, scope), nil
}
