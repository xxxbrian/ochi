package storage

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func verifiedTaskFixture(run string) TaskState {
	return TaskState{Objective: "Build the requested file", Status: "complete", Revision: 3,
		Acceptance:   []TaskCriterion{{ID: "test", Kind: "test_success", Target: "go test ./..."}},
		Verification: []TaskEvidence{{ID: "test", Passed: true, Source: "recorded_exec", RunID: run, CheckedAt: time.Now().UTC(), Detail: "Recorded test call exited successfully."}}}
}

func TestVerifiedMethodRequiresCurrentRunGenuineEvidence(t *testing.T) {
	task := verifiedTaskFixture("current")
	if proof, err := VerifiedMethodEvidence(task, "current"); err != nil || len(proof) != 1 {
		t.Fatal("genuine current-run evidence was rejected")
	}
	for _, mutate := range []func(*TaskState){
		func(v *TaskState) { v.Status = "active" },
		func(v *TaskState) { v.Remaining = []string{"not done"} },
		func(v *TaskState) { v.Verification[0].Passed = false },
		func(v *TaskState) { v.Verification[0].RunID = "old-run" },
		func(v *TaskState) { v.Verification[0].CheckedAt = time.Time{} },
		func(v *TaskState) { v.Verification[0].Source = "model_assertion" },
		func(v *TaskState) { v.Verification[0].Source = "scoped_files_list" },
		func(v *TaskState) { v.Verification[0].ID = "different-check" },
	} {
		v := verifiedTaskFixture("current")
		mutate(&v)
		if _, err := VerifiedMethodEvidence(v, "current"); err == nil {
			t.Fatal("unverified, stale or source-mismatched method was promotable")
		}
	}
	for _, input := range []VerifiedSkillInput{
		{Name: "../escape", Description: "Method", Body: "Steps"},
		{Name: "test", Description: " ", Body: "Steps"},
		{Name: "test", Description: "Method", Body: strings.Repeat("x", MaxVerifiedSkillBody+1)},
		{Name: "test", Description: "Method", Body: " "},
	} {
		if ValidateVerifiedSkill(input) == nil {
			t.Fatal("invalid private skill was accepted")
		}
	}
}

func TestVerifiedSkillsDatabaseIsolationAndDemandRead(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	seedMemorySource(t, s)
	if _, err := s.db.Exec(ctx, `UPDATE runs SET status='running' WHERE id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	input := VerifiedSkillInput{Name: "build-file", Description: "A verified file-building method", Body: "When needed, build the file and run its test."}
	if _, err := s.PromoteVerifiedSkill(ctx, memoryQAUser, memoryQASession, memoryQARun, input); err == nil {
		t.Fatal("missing task was promotable")
	}
	task := verifiedTaskFixture(memoryQARun)
	state, _ := json.Marshal(task)
	if _, err := s.db.Exec(ctx, `INSERT INTO session_tasks(session_id,user_id,state,revision) VALUES($1,$2,$3,3)`, memoryQASession, memoryQAUser, state); err != nil {
		t.Fatal(err)
	}
	v, err := s.PromoteVerifiedSkill(ctx, memoryQAUser, memoryQASession, memoryQARun, input)
	if err != nil || v.ID != "private:build-file" || len(v.SourceEvidence) != 1 || v.Body != "" {
		t.Fatalf("promotion metadata/evidence: %#v %v", v, err)
	}
	list, total, err := s.VerifiedSkills(ctx, memoryQAUser, "", 32)
	if err != nil || total != 1 || len(list) != 1 || list[0].Body != "" || list[0].SourceEvidence != nil {
		t.Fatal("metadata query read private instruction bodies")
	}
	read, err := s.ReadVerifiedSkill(ctx, memoryQAUser, "", v.ID)
	if err != nil || read.Body != input.Body || read.SourceRunID != memoryQARun || read.SourceTaskRevision != 3 {
		t.Fatal("demand read lost method or source provenance")
	}
	for _, owner := range []string{"other-user", "__admin__"} {
		list, total, err := s.VerifiedSkills(ctx, owner, "", 32)
		if err != nil || total != 0 || len(list) != 0 {
			t.Fatal("private method leaked to another owner/global administrator")
		}
		if _, err = s.ReadVerifiedSkill(ctx, owner, "", v.ID); err == nil {
			t.Fatal("cross-owner private body was readable")
		}
	}
	project := "33333333-aaaa-4333-8333-333333333333"
	if _, err = s.db.Exec(ctx, `INSERT INTO projects(id,user_id,name) VALUES($1,$2,'Owned project')`, project, memoryQAUser); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(ctx, `UPDATE sessions SET project_id=$2 WHERE id=$1`, memoryQASession, project); err != nil {
		t.Fatal(err)
	}
	input.Name, input.ProjectScoped = "project-method", true
	v, err = s.PromoteVerifiedSkill(ctx, memoryQAUser, memoryQASession, memoryQARun, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadVerifiedSkill(ctx, memoryQAUser, "", v.ID); err == nil {
		t.Fatal("project method leaked into ordinary conversation")
	}
	if _, err = s.ReadVerifiedSkill(ctx, memoryQAUser, "44444444-aaaa-4444-8444-444444444444", v.ID); err == nil {
		t.Fatal("project method crossed projects")
	}
	if _, err = s.ReadVerifiedSkill(ctx, memoryQAUser, project, v.ID); err != nil {
		t.Fatal(err)
	}
	task.Verification[0].RunID = "stale"
	state, _ = json.Marshal(task)
	if _, err = s.db.Exec(ctx, `UPDATE session_tasks SET state=$2 WHERE session_id=$1`, memoryQASession, state); err != nil {
		t.Fatal(err)
	}
	input.Body = "This stale attempt must not overwrite the verified method."
	if _, err = s.PromoteVerifiedSkill(ctx, memoryQAUser, memoryQASession, memoryQARun, input); err == nil {
		t.Fatal("stale-run evidence replaced verified method")
	}
}
