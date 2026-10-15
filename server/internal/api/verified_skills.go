package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func verifiedSkillDefinitions() []agent.ToolDefinition {
	return []agent.ToolDefinition{{Name: "skills_promote", Description: "Save a reusable method as your user's private skill, after task_verify has completed the current task with actual passed command/test/file/artifact evidence from this run. Include applicability, steps, limitations and verification in the body; never store secrets, user facts or unverified claims. Use a lowercase slug name. Reusing a name replaces that private method only after fresh verification. Set project_scoped for project-only methods. Requires Computer permission.", Parameters: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64},"description":{"type":"string","minLength":1,"maxLength":1000},"body":{"type":"string","minLength":1,"maxLength":16384},"project_scoped":{"type":"boolean"}},"required":["name","description","body"],"additionalProperties":false}`), Execution: &agent.ToolExecution{}}}
}

func privateSkillScope(ctx context.Context, userID string) (agent.RunScope, error) {
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.UserID != userID || scope.RunID == "" || scope.SessionID == "" || scope.ComputeOnly {
		return agent.RunScope{}, errors.New("private skills require an owned computer run")
	}
	return scope, nil
}

func (s *Server) promoteVerifiedSkill(ctx context.Context, userID string, raw json.RawMessage) (agent.ToolResult, error) {
	scope, err := privateSkillScope(ctx, userID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	definition := verifiedSkillDefinitions()[0]
	if err := agent.ValidateToolArguments(definition, raw); err != nil {
		return agent.ToolResult{}, err
	}
	var input storage.VerifiedSkillInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return agent.ToolResult{}, err
	}
	v, err := s.store.PromoteVerifiedSkill(ctx, userID, scope.SessionID, scope.RunID, input)
	if err != nil {
		return agent.ToolResult{}, err
	}
	data, err := json.Marshal(v)
	return agent.ToolResult{Output: string(data)}, err
}

func (s *Server) privateSkillsIndex(ctx context.Context, userID string) (string, error) {
	scope, err := privateSkillScope(ctx, userID)
	if err != nil {
		return "", err
	}
	values, total, err := s.store.VerifiedSkills(ctx, userID, scope.ProjectID, 32)
	if err != nil {
		return "", err
	}
	index := struct {
		Skills    []map[string]string `json:"skills"`
		Total     int                 `json:"total"`
		Truncated bool                `json:"truncated"`
	}{Skills: []map[string]string{}, Total: total}
	for _, v := range values {
		item := map[string]string{"id": v.ID, "name": v.Name, "description": compactText(v.Description, 240), "source": "private_verified_method"}
		index.Skills = append(index.Skills, item)
		data, _ := json.Marshal(index)
		if len(data) > 8*1024-32 {
			index.Skills = index.Skills[:len(index.Skills)-1]
			break
		}
	}
	index.Truncated = len(index.Skills) < total
	data, err := json.Marshal(index)
	return string(data), err
}

func (s *Server) readVerifiedSkill(ctx context.Context, userID, id string) (agent.ToolResult, error) {
	scope, err := privateSkillScope(ctx, userID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	v, err := s.store.ReadVerifiedSkill(ctx, userID, scope.ProjectID, id)
	if err != nil {
		return agent.ToolResult{}, err
	}
	data, err := json.Marshal(map[string]any{"id": v.ID, "name": v.Name, "description": v.Description,
		"instructions": v.Body, "source": "private_verified_method", "project_id": v.ProjectID,
		"source_session_id": v.SourceSessionID, "source_run_id": v.SourceRunID, "source_objective": v.SourceObjective,
		"source_task_revision": v.SourceTaskRevision, "source_evidence": v.SourceEvidence})
	return agent.ToolResult{Output: string(data)}, err
}

func compactText(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return string(runes)
}
