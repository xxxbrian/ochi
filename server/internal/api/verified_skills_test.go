package api

import (
	"context"
	"encoding/json"
	"testing"

	"ochi/server/internal/agent"
)

func TestPrivateSkillsRequireOwnedComputerScope(t *testing.T) {
	s := &Server{}
	for _, scope := range []agent.RunScope{
		{},
		{UserID: "other", RunID: "run", SessionID: "session"},
		{UserID: "user", RunID: "run", SessionID: "session", ComputeOnly: true},
		{UserID: "user", SessionID: "session"},
	} {
		ctx := agent.WithRunScope(context.Background(), scope)
		if _, err := s.privateSkillsIndex(ctx, "user"); err == nil {
			t.Fatal("invalid scope read private index")
		}
		if _, err := s.readVerifiedSkill(ctx, "user", "private:one"); err == nil {
			t.Fatal("invalid scope read private instructions")
		}
		if _, err := s.promoteVerifiedSkill(ctx, "user", json.RawMessage(`{}`)); err == nil {
			t.Fatal("invalid scope promoted a skill")
		}
	}
	definition := verifiedSkillDefinitions()[0]
	if definition.Execution != nil && definition.Execution.ParallelSafe {
		t.Fatal("private promotion was incorrectly classified parallel-safe")
	}
	if err := agent.ValidateToolSchema(definition.Parameters); err != nil {
		t.Fatal(err)
	}
	if err := agent.ValidateToolArguments(definition, json.RawMessage(`{"name":"one","description":"Method","body":"Steps","source_evidence":[{"passed":true}]}`)); err == nil {
		t.Fatal("model-authored skill evidence was accepted")
	}
}
