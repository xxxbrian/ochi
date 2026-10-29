package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func recordedExecution(id, jobID, command, status, output string) runtime.Step {
	args, _ := json.Marshal(map[string]string{"command": command})
	result := map[string]any{"job_id": jobID, "status": status, "stdout": output}
	if status == "completed" {
		result["exit_code"] = 0
	}
	raw, _ := json.Marshal(result)
	return runtime.Step{ID: id, Name: "exec", Status: "completed", Arguments: args, Output: string(raw)}
}

func recordedJob(id, requestedID, jobID, status string, exit any, stdout string) runtime.Step {
	args, _ := json.Marshal(map[string]string{"action": "wait", "job_id": requestedID})
	raw, _ := json.Marshal(map[string]any{"job_id": jobID, "status": status, "exit_code": exit, "stdout": stdout})
	return runtime.Step{ID: id, Name: "job", Status: "completed", Arguments: args, Output: string(raw)}
}

func TestJobCompletionSuppliesTaskAndMemoryEvidenceWithoutChangingItems(t *testing.T) {
	steps := []runtime.Step{
		recordedExecution("exec-item", "job-a", "go test ./...", "running", "ok fixture"),
		recordedJob("poll-item", "job-a", "job-a", "completed", 0, ""),
	}
	snapshot := fixtureSteps("run", steps...)
	proof := commandEvidence(storage.TaskCriterion{ID: "test", Target: "go test ./..."}, snapshot)
	if !proof.Passed || !strings.Contains(proof.Detail, "exec-item") || !strings.Contains(proof.Detail, "poll-item") {
		t.Fatal("terminal job evidence did not retain both source occurrences", proof)
	}
	if !verifiedMemorySteps(snapshot.Steps())["exec-item"] {
		t.Fatal("completed job with earlier streamed test logs was not eligible evidence")
	}
	if snapshot.Items[0].Step.Output != steps[0].Output || strings.Contains(snapshot.Items[0].Step.Output, `"exit_code"`) {
		t.Fatal("evidence projection rewrote the initial running exec")
	}
}

func TestJobCompletionNeverCompletesAnUnobservedOrDifferentExecution(t *testing.T) {
	initial := recordedExecution("exec-a", "job-a", "go test ./...", "running", "")
	for _, poll := range []runtime.Step{
		recordedJob("other", "job-b", "job-b", "completed", 0, "ok"),
		recordedJob("mismatch", "job-b", "job-a", "completed", 0, "ok"),
		recordedJob("running", "job-a", "job-a", "running", 0, "ok"),
		recordedJob("cancelled", "job-a", "job-a", "cancelled", 0, "ok"),
		recordedJob("timed-out", "job-a", "job-a", "timed_out", 0, "ok"),
		recordedJob("failed", "job-a", "job-a", "failed", 0, "ok"),
		recordedJob("nonzero", "job-a", "job-a", "completed", 1, "FAIL"),
	} {
		t.Run(poll.ID, func(t *testing.T) {
			snapshot := fixtureSteps("run", initial, poll)
			if commandEvidence(storage.TaskCriterion{Target: "go test ./..."}, snapshot).Passed || len(verifiedMemorySteps(snapshot.Steps())) != 0 {
				t.Fatal("unrelated or unfinished job was treated as verified", poll)
			}
		})
	}
	if values := executionObservations([]runtime.Step{recordedJob("old-service", "old-job", "old-job", "completed", 0, "ok")}); len(values) != 0 {
		t.Fatal("polling a job from an earlier run invented a current execution", values)
	}
}

func TestLaterAttemptSupersedesAnEarlierJobEvenWhenThatJobFinishesLast(t *testing.T) {
	steps := []runtime.Step{
		recordedExecution("first-exec", "first-job", "go test ./...", "running", ""),
		recordedExecution("second-exec", "second-job", "go test ./...", "running", ""),
		recordedJob("first-finish", "first-job", "first-job", "completed", 0, "ok"),
	}
	proof := commandEvidence(storage.TaskCriterion{Target: "go test ./..."}, fixtureSteps("run", steps...))
	if proof.Passed || !strings.Contains(proof.Detail, "second-exec") {
		t.Fatal("completion order replaced execution order", proof)
	}
	steps = append(steps, recordedJob("second-finish", "second-job", "second-job", "completed", 0, "ok"))
	if !commandEvidence(storage.TaskCriterion{Target: "go test ./..."}, fixtureSteps("run", steps...)).Passed {
		t.Fatal("latest successful attempt remained unfinished")
	}
}

func TestMemoryJobEvidenceRetainsEarlierNoTestOutput(t *testing.T) {
	steps := []runtime.Step{
		recordedExecution("exec-item", "job-a", "go test ./...", "running", "no tests to run"),
		recordedJob("poll-item", "job-a", "job-a", "completed", 0, "ok"),
	}
	if len(verifiedMemorySteps(steps)) != 0 {
		t.Fatal("terminal poll hid an earlier no-test result")
	}
}

func TestTaskVerificationPersistsActualDeferredJobOutcome(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	task := storage.TaskState{Objective: "Verify the report", Acceptance: []storage.TaskCriterion{{ID: "checks", Kind: "test_success", Target: "go test ./..."}}}
	if _, err := f.server.store.SaveTask(ctx, f.owner, f.session.ID, f.run.RunID, task, 0, false); err != nil {
		t.Fatal(err)
	}
	live, _ := f.server.runtime.Get(f.run.RunID)
	if err := live.UpdateStep("round-1", recordedExecution("call-0", "job-a", "go test ./...", "running", "")); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{UserID: f.owner, SessionID: f.session.ID, RunID: f.run.RunID, CWD: f.session.WorkspacePath}
	proof, err := f.server.verifyCurrentTask(ctx, scope)
	if err != nil || proof.Status != "active" || proof.Verification[0].Passed {
		t.Fatal("running job was prematurely verified", proof, err)
	}
	if err := live.UpdateStep("round-2", recordedJob("call-0", "job-a", "job-a", "completed", 0, "ok fixture")); err != nil {
		t.Fatal(err)
	}
	proof, err = f.server.verifyCurrentTask(ctx, scope)
	if err != nil || proof.Status != "complete" || !proof.Verification[0].Passed {
		t.Fatal("observed job completion did not satisfy the task", proof, err)
	}
	stored, err := f.server.store.Task(ctx, f.owner, f.session.ID)
	if err != nil || stored.Status != "complete" || stored.Verification[0].RunID != f.run.RunID ||
		!strings.Contains(stored.Verification[0].Detail, live.Snapshot().Items[1].ID) {
		t.Fatal("persisted verification lost the actual result occurrence", stored, err)
	}
	if err := live.UpdateStep("round-3", recordedExecution("call-0", "job-b", "go test ./...", "running", "")); err != nil {
		t.Fatal(err)
	}
	proof, err = f.server.verifyCurrentTask(ctx, scope)
	if err != nil || proof.Status != "active" || proof.Verification[0].Passed {
		t.Fatal("later unfinished recheck retained stale completion", proof, err)
	}
}
