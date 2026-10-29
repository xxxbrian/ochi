package storage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func TestInterruptedPublicContextUsesRoundIdentityNotTextMatching(t *testing.T) {
	for _, status := range []string{runtime.StatusFailed, runtime.StatusCancelled, runtime.StatusInterrupted} {
		t.Run(status, func(t *testing.T) {
			s := processTestStore(t)
			ctx := context.Background()
			const user = "partial-context-qa"
			if _, err := s.db.Exec(ctx, `INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,'QA','not-a-login')`, user); err != nil {
				t.Fatal(err)
			}
			session, err := s.CreateSession(ctx, user)
			if err != nil {
				t.Fatal(err)
			}
			const oldID = "40111111-1111-4111-8111-111111111111"
			const nextID = "40222222-2222-4222-8222-222222222222"
			snap, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Investigate", oldID, Model{}, "", "", nil)
			if err != nil {
				t.Fatal(err)
			}
			// A prior round already finished the same provider call ID. It must not
			// hide a new unresolved call in another round.
			prior := agent.CanonicalMessage{RoundID: "r0", Payload: json.RawMessage(`{"role":"assistant","tool_calls":[{"id":"unconfirmed","type":"function","function":{"name":"exec","arguments":"{}"}}]}`)}
			if err = s.AppendCanonical(ctx, session.ID, oldID, &prior); err != nil {
				t.Fatal(err)
			}
			prior.Payload = json.RawMessage(`{"role":"tool","tool_call_id":"unconfirmed","content":"Earlier round completed"}`)
			if err = s.AppendCanonical(ctx, session.ID, oldID, &prior); err != nil {
				t.Fatal(err)
			}
			complete := agent.CanonicalMessage{RoundID: "r1", Payload: json.RawMessage(`{"role":"assistant","content":"Already recorded.","tool_calls":[{"id":"unconfirmed","type":"function","function":{"name":"exec","arguments":"{}"}}]}`)}
			if err = s.AppendCanonical(ctx, session.ID, oldID, &complete); err != nil {
				t.Fatal(err)
			}
			m := runtime.NewManager()
			defer m.Shutdown(ctx)
			r := m.Restore(snap)
			_ = r.AppendText("r1", "source", "Already recorded.", "pending")
			_ = r.EndRound("r1", false)
			_ = r.AppendText("r2", "source", "Partial $E = ", "pending")
			_ = r.AppendReasoning("r2", agent.ReasoningPart{ID: "secret", Kind: "reasoning", Text: "PRIVATE_REASONING_NOT_CONTEXT"})
			_ = r.AppendText("r2", "source", "mc^2$", "pending")
			if err = r.Finalize(status, errors.New("fixture interruption"), func(v runtime.Snapshot) error { return s.CompleteRun(ctx, v) }); err != nil {
				t.Fatal(err)
			}
			next, history, err := s.CreateConfiguredRun(ctx, user, session.ID, "What had you found?", nextID, Model{}, "", "", nil)
			if err != nil {
				t.Fatal(err)
			}
			markers := 0
			unknown := false
			for _, entry := range history {
				var payload struct {
					Role    string `json:"role"`
					Content string `json:"content"`
					Status  string `json:"ochi_run_status"`
					Calls   []any  `json:"tool_calls"`
				}
				if err = json.Unmarshal(entry.Payload, &payload); err != nil {
					t.Fatal(err)
				}
				if payload.Role == "tool" {
					unknown = strings.Contains(payload.Content, "结果未确认")
				}
				if payload.Status != "" {
					markers++
					if payload.Status != status || !strings.Contains(payload.Content, "Partial $E = mc^2$") || strings.Contains(payload.Content, "Already recorded.") || strings.Contains(payload.Content, "PRIVATE_REASONING") || len(payload.Calls) > 0 {
						t.Fatalf("bad interruption observation: %s", entry.Payload)
					}
				}
			}
			if markers != 1 || !unknown {
				t.Fatalf("continuity/unknown tool repair missing: %d %v", markers, unknown)
			}
			next.Status = runtime.StatusCompleted
			if err = s.CompleteRun(ctx, next); err != nil {
				t.Fatal(err)
			}
			_, again, err := s.CreateConfiguredRun(ctx, user, session.ID, "Edit previous input", "40333333-3333-4333-8333-333333333333", Model{}, "", "", nil, Revision{RetryRunID: nextID})
			if err != nil {
				t.Fatal(err)
			}
			markers = 0
			for _, entry := range again {
				if strings.Contains(string(entry.Payload), `"ochi_run_status"`) {
					markers++
				}
			}
			if markers != 1 {
				t.Fatal("next admission duplicated interruption observation")
			}
		})
	}
}
