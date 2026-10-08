package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

const taskQAUser = "task-owned-fixture"
const taskQAModel = "33333333-bbbb-4333-8333-333333333333"

func taskTestStore(t *testing.T) (*Store, Session, runtime.Snapshot) {
	t.Helper()
	s := processTestStore(t)
	ctx := context.Background()
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,'QA','not-a-login'),('task-other-fixture','task-other-fixture','Other','not-a-login')`, []any{taskQAUser}},
		{`INSERT INTO providers(id,name,base_url,api_key) VALUES('11111111-bbbb-4111-8111-111111111111','QA','http://127.0.0.1','fixture')`, nil},
		{`INSERT INTO models(id,provider_id,name,model) VALUES($1,'11111111-bbbb-4111-8111-111111111111','Same model','same-model')`, []any{taskQAModel}},
	} {
		if _, err := s.db.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	session, err := s.CreateSession(ctx, taskQAUser)
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := s.CreateConfiguredRun(ctx, taskQAUser, session.ID, "Create the requested report", "22222222-bbbb-4222-8222-222222222222", Model{ID: taskQAModel, ProviderID: "11111111-bbbb-4111-8111-111111111111", Name: "Same model"}, "high", agent.SystemPrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, session, run
}

func TestTaskValidationAndNoSelfCertification(t *testing.T) {
	base := TaskState{Objective: "Produce a report", Acceptance: []TaskCriterion{{ID: "report", Kind: "artifact_exists", Target: "report.md"}}}
	if ValidateTask(base) != nil || TaskChecksComplete(base, nil) {
		t.Fatal("new task or completion contract")
	}
	proof := []TaskEvidence{{ID: "report", Passed: true, Source: "immutable_artifact_store"}}
	if !TaskChecksComplete(base, proof) {
		t.Fatal("real evidence was rejected")
	}
	base.Remaining = []string{"Finish content"}
	if TaskChecksComplete(base, proof) {
		t.Fatal("remaining task self-completed")
	}
	base.Acceptance = append(base.Acceptance, base.Acceptance[0])
	if ValidateTask(base) == nil {
		t.Fatal("duplicate check id accepted")
	}
}

func TestTaskDatabaseRevisionOwnershipAndVerification(t *testing.T) {
	s, session, run := taskTestStore(t)
	ctx := context.Background()
	input := TaskState{Objective: "Create report", Constraints: []string{"No external sends"}, Done: []string{"Prepared"}, Remaining: []string{}, Acceptance: []TaskCriterion{{ID: "test", Kind: "test_success", Target: "go test ./..."}}, Status: "complete", Verification: []TaskEvidence{{ID: "test", Passed: true, Source: "model says so"}}}
	state, err := s.SaveTask(ctx, taskQAUser, session.ID, run.RunID, input, 0, false)
	if err != nil || state.Status != "active" || len(state.Verification) != 0 || state.Revision != 1 {
		t.Fatalf("model self-certification passed: %v %+v", err, state)
	}
	if _, err = s.Task(ctx, "task-other-fixture", session.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign task read")
	}
	if _, err = s.SaveTask(ctx, "task-other-fixture", session.ID, run.RunID, input, 1, false); err == nil {
		t.Fatal("foreign task write")
	}
	if _, err = s.SaveTask(ctx, taskQAUser, session.ID, run.RunID, input, 0, false); err == nil {
		t.Fatal("stale update accepted")
	}
	different := input
	different.Objective = "Invented extra task"
	if _, err = s.SaveTask(ctx, taskQAUser, session.ID, run.RunID, different, 1, false); err == nil {
		t.Fatal("objective implicitly replaced")
	}
	proof := []TaskEvidence{{ID: "test", Passed: true, Source: "recorded_exec", RunID: run.RunID, CheckedAt: time.Now()}}
	verified, err := s.VerifyTask(ctx, taskQAUser, session.ID, 1, proof)
	if err != nil || verified.Status != "complete" || verified.Revision != 2 {
		t.Fatalf("verify: %v %+v", err, verified)
	}
	if _, err = s.VerifyTask(ctx, taskQAUser, session.ID, 1, proof); err == nil {
		t.Fatal("stale verification overwrote task")
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, e := s.SaveTask(ctx, taskQAUser, session.ID, run.RunID, input, 2, false)
		results <- e
	}()
	go func() { defer wg.Done(); _, e := s.VerifyTask(ctx, taskQAUser, session.ID, 2, proof); results <- e }()
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	latest, _ := s.Task(ctx, taskQAUser, session.ID)
	if success != 1 || latest.Revision != 3 || len(latest.Constraints) != 1 || latest.Constraints[0] != "No external sends" {
		t.Fatal("optimistic task update/verify lost constraints or accepted both writers")
	}
}

func TestSupplementalInputExactOnceOwnershipAndOriginalTranscript(t *testing.T) {
	s, session, run := taskTestStore(t)
	ctx := context.Background()
	const key = "durable-client-key"
	ids := make(chan string, 12)
	errs := make(chan error, 12)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.AcceptInstruction(ctx, taskQAUser, run.RunID, key, "Keep every original constraint.")
			ids <- v.ID
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatal("same idempotency key duplicated input")
		}
	}
	if _, e := s.AcceptInstruction(ctx, taskQAUser, run.RunID, key, "different"); e == nil {
		t.Fatal("key reuse changed content")
	}
	if _, e := s.AcceptInstruction(ctx, "task-other-fixture", run.RunID, "foreign-client-key", "foreign"); e == nil {
		t.Fatal("foreign steering accepted")
	}
	accepted, e := s.ConsumeInstructions(ctx, taskQAUser, session.ID, run.RunID)
	if e != nil || len(accepted) != 1 || accepted[0].Seq == 0 {
		t.Fatalf("consume: %v %+v", e, accepted)
	}
	var original agent.Message
	_ = json.Unmarshal(accepted[0].Payload, &original)
	if original.Role != "user" || original.Content != "Keep every original constraint." {
		t.Fatal("supplement was not original user input")
	}
	if more, e := s.ConsumeInstructions(ctx, taskQAUser, session.ID, run.RunID); e != nil || len(more) != 0 {
		t.Fatal("supplement consumed twice")
	}
	entries, e := s.Instructions(ctx, taskQAUser, run.RunID)
	if e != nil || len(entries) != 1 || entries[0].Status != "applied" || entries[0].CanonicalSeq == nil {
		t.Fatal("applied disposition missing")
	}
	messages, _ := s.Messages(ctx, taskQAUser, session.ID)
	if len(messages) != 1 || messages[0].Content != "Create the requested report" {
		t.Fatal("steering mutated ordinary message projection/edit target")
	}
}

func TestLateSupplementCompletionQueuesInOrderWithFrozenSelection(t *testing.T) {
	s, _, run := taskTestStore(t)
	ctx := context.Background()
	if _, err := s.db.Exec(ctx, `UPDATE runs SET timezone='Asia/Shanghai' WHERE id=$1`, run.RunID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, e := s.AcceptInstruction(ctx, taskQAUser, run.RunID, fmt.Sprintf("late-client-key-%d", i), fmt.Sprintf("Late instruction %d", i)); e != nil {
			t.Fatal(e)
		}
	}
	run.Status = runtime.StatusCompleted
	run.Seq++
	run.UpdatedAt = time.Now().UTC()
	if err := s.CompleteRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	queue, e := s.PendingRuns(ctx, taskQAUser, run.SessionID)
	if e != nil || len(queue) != 3 {
		t.Fatalf("late inputs lost: %v %+v", e, queue)
	}
	for i, v := range queue {
		if v.Message != fmt.Sprintf("Late instruction %d", i) || v.ModelID != run.ModelID || v.Effort != run.Effort || v.Timezone != "Asia/Shanghai" {
			t.Fatal("late input order/selection/timezone changed")
		}
	}
	items, _ := s.Instructions(ctx, taskQAUser, run.RunID)
	for _, v := range items {
		if v.Status != "queued" || v.QueuedRunID == nil || v.CanonicalSeq != nil {
			t.Fatal("late queue disposition inconsistent")
		}
	}
	if err := s.CompleteRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	queue, _ = s.PendingRuns(ctx, taskQAUser, run.SessionID)
	if len(queue) != 3 {
		t.Fatal("finalization queued a supplement twice")
	}
}

func TestStoppedOrCrashedRunDoesNotRestartSupplement(t *testing.T) {
	for _, status := range []string{runtime.StatusCancelled, runtime.StatusInterrupted, runtime.StatusFailed} {
		t.Run(status, func(t *testing.T) {
			s, _, run := taskTestStore(t)
			ctx := context.Background()
			if _, e := s.AcceptInstruction(ctx, taskQAUser, run.RunID, "not-replay-client-key", "Continue only if I approve."); e != nil {
				t.Fatal(e)
			}
			run.Status = status
			run.Seq++
			run.UpdatedAt = time.Now().UTC()
			if e := s.CompleteRun(ctx, run); e != nil {
				t.Fatal(e)
			}
			pending, e := s.PendingRuns(ctx, taskQAUser, run.SessionID)
			if e != nil || len(pending) != 0 {
				t.Fatal("cancel/failure/crash automatically restarted work")
			}
			v, e := s.AcceptInstruction(ctx, taskQAUser, run.RunID, "not-replay-client-key", "Continue only if I approve.")
			if e != nil || v.Status != "not_applied" {
				t.Fatal("idempotent acknowledgement lost unapplied status")
			}
			if _, e = s.AcceptInstruction(ctx, taskQAUser, run.RunID, "new-terminal-client-key", "new"); !errors.Is(e, ErrRunNotSteerable) {
				t.Fatal("terminal run accepted new steering")
			}
			if _, e = s.ConsumeInstructions(ctx, taskQAUser, run.SessionID, run.RunID); e == nil {
				t.Fatal("terminal run consumed pending input")
			}
		})
	}
}

func TestStartupRecoveryDoesNotReplayAcceptedSteering(t *testing.T) {
	s, session, run := taskTestStore(t)
	ctx := context.Background()
	if _, err := s.AcceptInstruction(ctx, taskQAUser, run.RunID, "crash-client-key", "Do not repeat uncertain work."); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverStartup(ctx); err != nil {
		t.Fatal(err)
	}
	read, err := s.GetRun(ctx, taskQAUser, run.RunID)
	if err != nil || read.Status != runtime.StatusInterrupted {
		t.Fatal("admitted running work was replayed on startup")
	}
	items, err := s.Instructions(ctx, taskQAUser, run.RunID)
	if err != nil || len(items) != 1 || items[0].Status != "not_applied" || items[0].CanonicalSeq != nil || items[0].QueuedRunID != nil {
		t.Fatal("startup lost or applied uncertain input")
	}
	pending, err := s.PendingRuns(ctx, taskQAUser, session.ID)
	if err != nil || len(pending) != 0 {
		t.Fatal("startup blindly queued executed work")
	}
}

func TestContextDiagnosticsPersistenceBoundedAndOwned(t *testing.T) {
	s, _, run := taskTestStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 70)
	for i := 0; i < 70; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- s.SaveContextInspection(ctx, run.RunID, agent.ContextInspection{Round: fmt.Sprintf("round-%d", i), Request: json.RawMessage(`{"model":"same","input":"actual"}`), SHA256: "exact-hash"})
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	index, e := s.ContextInspections(ctx, taskQAUser, run.RunID, "")
	if e != nil || len(index) != 64 {
		t.Fatal("parallel inspection records exceeded the bound")
	}
	for _, v := range index {
		if v.Request != nil {
			t.Fatal("metadata index exposed full prompts")
		}
	}
	selected, e := s.ContextInspections(ctx, taskQAUser, run.RunID, index[0].Round)
	if e != nil || len(selected) != 1 || len(selected[0].Request) == 0 {
		t.Fatal("owned selected context not inspectable")
	}
	if _, e := s.ContextInspections(ctx, "task-other-fixture", run.RunID, index[0].Round); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("foreign model input exposed")
	}
	for i := 0; i < 130; i++ {
		if e := s.SaveDiagnostic(ctx, run.RunID, agent.Diagnostic{Kind: "bounded", Class: "transient"}); e != nil {
			t.Fatal(e)
		}
	}
	diagnostics, e := s.Diagnostics(ctx, taskQAUser, run.RunID)
	if e != nil || len(diagnostics) != 128 {
		t.Fatal("diagnostic cap")
	}
	if _, e := s.Diagnostics(ctx, "task-other-fixture", run.RunID); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("foreign run diagnostics")
	}
}
