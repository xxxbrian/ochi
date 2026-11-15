package storage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func TestSessionMemoryChoicePreservesConversationAndTaskContinuity(t *testing.T) {
	s, defaultSession, _ := taskTestStore(t)
	ctx := context.Background()
	off, err := s.CreateSessionWithMemory(ctx, taskQAUser, "", false)
	if err != nil || off.MemoryEnabled || !defaultSession.MemoryEnabled {
		t.Fatalf("session creation did not retain the selected memory policy: on=%+v off=%+v err=%v", defaultSession, off, err)
	}
	for _, enabled := range []bool{true, false, true} {
		if _, err = s.PatchPreferences(ctx, taskQAUser, PreferencesPatch{MemoryEnabled: &enabled}); err != nil {
			t.Fatal(err)
		}
		if effective, err := s.SessionMemoryEnabled(ctx, taskQAUser, off.ID); err != nil || effective {
			t.Fatalf("account preference enabled memory in an off session: %t %v", effective, err)
		}
		if effective, err := s.SessionMemoryEnabled(ctx, taskQAUser, defaultSession.ID); err != nil || effective != enabled {
			t.Fatalf("account preference did not bound the on session: %t %v", effective, err)
		}
	}
	if _, err = s.SetSessionComputer(ctx, taskQAUser, off.ID, true, true); err != nil {
		t.Fatal(err)
	}
	off, err = s.UpdateSession(ctx, taskQAUser, off.ID, "Retained off conversation", "", "")
	if err != nil || off.MemoryEnabled || !off.ComputerEnabled {
		t.Fatal("ordinary session edits changed memory policy or Computer behavior")
	}
	head, err := s.SessionHead(ctx, taskQAUser, off.ID)
	if err != nil || head.Session.MemoryEnabled {
		t.Fatal("session head lost the memory choice")
	}
	page, err := s.SessionsPage(ctx, taskQAUser, "Retained off conversation", "", "", 50)
	if err != nil || len(page.Items) != 1 || page.Items[0].MemoryEnabled {
		t.Fatal("session listing lost the memory choice")
	}
	encoded, _ := json.Marshal(head.Session)
	if !strings.Contains(string(encoded), `"memory_enabled":false`) {
		t.Fatal("off was omitted from the required session wire field")
	}

	const runID = "55555555-bbbb-4555-8555-555555555555"
	run, history, err := s.CreateConfiguredRun(ctx, taskQAUser, off.ID, "Create the requested report", runID,
		Model{ID: taskQAModel, Name: "Same model"}, "", agent.SystemPrompt, nil)
	if err != nil || len(history) != 1 {
		t.Fatalf("normal off-session turn was rejected: %v", err)
	}
	task, err := s.SaveTask(ctx, taskQAUser, off.ID, runID, TaskState{
		Objective:   "Create report",
		Constraints: []TaskConstraint{{Text: "Only create the requested report", SourceExcerpt: "Create the requested report"}},
		Acceptance:  []TaskCriterion{{ID: "test", Kind: "test_success", Target: "go test ./..."}}},
		0, false)
	if err != nil {
		t.Fatalf("off-session accepted-source constraint was rejected: %v", err)
	}
	if err = s.SaveCompaction(ctx, off.ID, agent.Compaction{ThroughSeq: history[0].Seq, Summary: "Current report task and its accepted constraint"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcceptInstruction(ctx, taskQAUser, runID, "off-session-instruction", "Keep the report concise."); err != nil {
		t.Fatal(err)
	}
	instructions, err := s.ConsumeInstructions(ctx, taskQAUser, off.ID, runID)
	if err != nil || len(instructions) != 1 {
		t.Fatal("off-session supplemental input did not enter canonical history")
	}
	task.Constraints = append(task.Constraints, TaskConstraint{Text: "Keep the report concise", SourceExcerpt: "Keep the report concise."})
	task, err = s.SaveTask(ctx, taskQAUser, off.ID, runID, task, task.Revision, false)
	if err != nil {
		t.Fatalf("off-session supplemental-source constraint was rejected: %v", err)
	}
	verified, err := s.VerifyTask(ctx, taskQAUser, off.ID, task.Revision,
		[]TaskEvidence{{ID: "test", Passed: true, Source: "recorded_exec", RunID: runID, CheckedAt: time.Now().UTC()}})
	if err != nil || verified.Status != "complete" {
		t.Fatal("off-session task verification stopped working")
	}
	if _, err = s.PromoteVerifiedSkill(ctx, taskQAUser, off.ID, runID, VerifiedSkillInput{Name: "off-method", Description: "Private learned method", Body: "Create and test the report."}); !errors.Is(err, ErrMemoryChanged) {
		t.Fatalf("off-session task was promoted to a private skill: %v", err)
	}
	if err = s.QueueMemoryPreservation(ctx, taskQAUser, runID); err != nil {
		t.Fatal(err)
	}
	run.Status, run.Seq, run.UpdatedAt = runtime.StatusCompleted, run.Seq+1, time.Now().UTC()
	run.Items = []runtime.Item{{ID: "reply", Kind: "text", Phase: "final", State: "completed", Text: "Report completed."}}
	if err = s.CompleteRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.MemoryJobs(ctx, taskQAUser)
	if err != nil || len(jobs) != 0 {
		t.Fatal("normal completion or compaction preservation enqueued an off source")
	}
	messages, err := s.Messages(ctx, taskQAUser, off.ID)
	if err != nil || len(messages) != 2 || messages[1].Content != "Report completed." {
		t.Fatal("off-session visible chat was not normally stored")
	}
	compaction, err := s.Compaction(ctx, off.ID)
	if err != nil || compaction == nil || compaction.Summary != "Current report task and its accepted constraint" {
		t.Fatal("off-session current context compaction was lost")
	}
	_, nextHistory, err := s.CreateConfiguredRun(ctx, taskQAUser, off.ID, "Continue the report", "66666666-bbbb-4666-8666-666666666666",
		Model{ID: taskQAModel, Name: "Same model"}, "", agent.SystemPrompt, nil)
	if err != nil || len(nextHistory) != 2 || !strings.Contains(string(nextHistory[0].Payload), "Keep the report concise.") {
		t.Fatal("next off-session turn lost post-compaction canonical continuity")
	}
}

func TestSessionMemoryOffSourceCannotEscapeThroughLongTermStorage(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	off, err := s.CreateSessionWithMemory(ctx, memoryQAUser, "", false)
	if err != nil {
		t.Fatal(err)
	}
	const offRun = "77777777-bbbb-4777-8777-777777777777"
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO runs(id,session_id,status) VALUES($1,$2,'completed')`, []any{offRun, off.ID}},
		{`INSERT INTO messages(session_id,run_id,role,content) VALUES($1,$2,'user','I prefer Go. Private off-session evidence.')`, []any{off.ID, offRun}},
		{`INSERT INTO canonical_messages(session_id,run_id,payload) VALUES($1,$2,'{"role":"user","content":"I prefer Go. Private off-session evidence."}'),($3,$4,'{"role":"user","content":"I prefer Go."}')`, []any{off.ID, offRun, memoryQASession, memoryQARun}},
	} {
		if _, err = s.db.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	pref, err := s.Preferences(ctx, memoryQAUser)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"automatic", "agent", "user"} {
		for _, kind := range []string{"preference", "session_summary", "method"} {
			input := Memory{Content: "Private off-session " + source + " " + kind, Kind: kind, Source: source, Admission: "durable",
				SourceSessionID: off.ID, SourceRunID: offRun, SourceExcerpt: "I prefer Go.", ExpectedRevision: &pref.MemoryRevision}
			if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, input); !errors.Is(err, ErrMemoryChanged) {
				t.Fatalf("off-session %s/%s passed the independent write boundary: %v", source, kind, err)
			}
		}
	}
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Run-only off source", Source: "user", SourceRunID: offRun}); !errors.Is(err, ErrMemoryChanged) {
		t.Fatalf("omitting source_session_id bypassed the off source boundary: %v", err)
	}
	if _, err = s.MemoryRunPrompt(ctx, memoryQAUser, offRun); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("off source was readable for extraction or admission")
	}
	if _, err = s.FreezeMemoryProfile(ctx, memoryQAUser, off.ID, "Private profile", pref.MemoryRevision); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("off-session stable profile was persisted")
	}
	if _, err = s.FreezeMemoryContext(ctx, memoryQAUser, off.ID, "Private profile"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("off-session context writer bypassed the boundary")
	}
	if _, err = s.db.Exec(ctx, `UPDATE sessions SET memory_context='fixture stale profile' WHERE id=$1`, off.ID); err != nil {
		t.Fatal(err)
	}
	if value, exists, err := s.FrozenMemoryContext(ctx, memoryQAUser, off.ID); err != nil || exists || value != "" {
		t.Fatal("off session read a retained memory profile")
	}
	hits, err := s.SearchHistory(ctx, memoryQAUser, "", "", "prefer", 20)
	if err != nil || len(hits) != 1 || hits[0].SessionID != memoryQASession {
		t.Fatalf("cross-session search did not exclude the off source: %+v %v", hits, err)
	}
	if _, err = s.ReadHistory(ctx, memoryQAUser, "", off.ID, 0, 20); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("cross-session read exposed the off source by ID")
	}
	if page, err := s.ReadHistory(ctx, memoryQAUser, "", memoryQASession, 0, 20); err != nil || len(page.Items) != 1 {
		t.Fatal("on-session original history regressed")
	}
	if messages, err := s.Messages(ctx, memoryQAUser, off.ID); err != nil || len(messages) != 1 {
		t.Fatal("off source ceased to be readable as its own ordinary conversation")
	}
	onMemory := Memory{Content: "Prefers Go", Kind: "preference", Source: "automatic", Admission: "durable",
		SourceSessionID: memoryQASession, SourceRunID: memoryQARun, SourceExcerpt: "I prefer Go.", ExpectedRevision: &pref.MemoryRevision}
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, onMemory); err != nil {
		t.Fatalf("on-session source stopped saving admitted memory: %v", err)
	}
	for _, runID := range []string{offRun, memoryQARun} {
		if err = s.EnqueueMemoryJob(ctx, runID); err != nil {
			t.Fatal(err)
		}
		if err = s.QueueMemoryPreservation(ctx, memoryQAUser, runID); err != nil {
			t.Fatal(err)
		}
	}
	jobs, err := s.MemoryJobs(ctx, memoryQAUser)
	if err != nil || len(jobs) != 1 || jobs[0].RunID != memoryQARun {
		t.Fatal("off source entered extraction or preservation queue")
	}
	const forgedLease = "88888888-bbbb-4888-8888-888888888888"
	if _, err = s.db.Exec(ctx, `INSERT INTO memory_jobs(run_id,user_id,session_id,memory_revision,status,attempts,lease_token,lease_until)
 VALUES($1,$2,$3,$4,'leased',1,$5,now()+interval '2 minutes')`, offRun, memoryQAUser, off.ID, pref.MemoryRevision, forgedLease); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveMemoryExtraction(ctx, MemoryJob{RunID: offRun, LeaseToken: forgedLease}, json.RawMessage(`{"facts":[],"summary":"must not persist"}`)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatalf("a retained off-source worker lease persisted extraction: %v", err)
	}
	job, err := s.ClaimMemoryJob(ctx)
	if err != nil || job == nil || job.RunID != memoryQARun {
		t.Fatalf("worker claimed an off source or lost the on source: %+v %v", job, err)
	}
	if err = s.SaveMemoryExtraction(ctx, *job, json.RawMessage(`{"facts":[],"summary":"on source"}`)); err != nil {
		t.Fatalf("on-source worker extraction regressed: %v", err)
	}
	jobs, err = s.MemoryJobs(ctx, memoryQAUser)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range jobs {
		if status.RunID == offRun && status.Status != "skipped" {
			t.Fatal("worker retained an off source as extractable work")
		}
	}
}
