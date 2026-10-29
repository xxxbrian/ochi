package runtime

import (
	"context"
	"testing"
	"time"

	"ochi/server/internal/agent"
)

func TestCancelWaitsForPersistenceAndKeepsSessionBusy(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown(context.Background())
	cancelled, release := make(chan struct{}), make(chan struct{})
	persisted := make(chan Snapshot, 1)
	run, err := manager.Start(Snapshot{RunID: "run", SessionID: "session"}, func(run *Run) {
		<-run.Context().Done()
		close(cancelled)
		<-release
		if err := run.UpdateStep("r", Step{ID: "tool", Name: "read_file", Status: "completed", Output: "finished before releasing the workspace"}); err != nil {
			t.Errorf("cancel prevented an in-flight tool from finishing: %v", err)
		}
		if err := run.Finalize(StatusCompleted, nil, func(snapshot Snapshot) error {
			persisted <- snapshot
			return nil
		}); err != nil {
			t.Error(err)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.UpdateStep("r", Step{ID: "tool", Name: "read_file", Status: "running"}); err != nil {
		t.Fatal(err)
	}
	_, events, unsubscribe := run.Subscribe()
	defer unsubscribe()
	if !run.Cancel() {
		t.Fatal("cancel was not accepted")
	}
	<-cancelled
	if got := run.Snapshot().Status; got != StatusCancelling {
		t.Fatalf("cancel published premature terminal state: %q", got)
	}
	if err := run.AppendText("r", "text", "late output", "pending"); err == nil {
		t.Fatal("cancelled run accepted new text")
	}
	if err := run.UpdateStep("r", Step{ID: "another-tool", Status: "running"}); err == nil {
		t.Fatal("cancelled run started another tool")
	}
	if _, err := manager.Start(Snapshot{RunID: "other", SessionID: "session"}, nil); err != ErrRunExists {
		t.Fatalf("active session accepted a second run: %v", err)
	}
	first := <-events
	if first.Status != StatusCancelling {
		t.Fatalf("first event = %+v", first)
	}
	close(release)
	select {
	case final := <-persisted:
		if final.Status != StatusCancelled {
			t.Fatalf("saved status = %q", final.Status)
		}
		if len(final.Steps()) != 1 || final.Steps()[0].Status != "completed" {
			t.Fatalf("in-flight tool result was not saved: %+v", final.Steps())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("result was not persisted")
	}
	select {
	case step := <-events:
		if step.Type != "item_updated" || step.Patches[0].Step.Status != "completed" {
			t.Fatalf("tool completion event = %+v", step)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tool completion event not published")
	}
	select {
	case final := <-events:
		if final.Status != StatusCancelled {
			t.Fatalf("terminal event = %+v", final)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("terminal event not published")
	}
}

func TestShutdownWaitsForRunCleanup(t *testing.T) {
	manager := NewManager()
	cancelled, release, saved := make(chan struct{}), make(chan struct{}), make(chan struct{})
	run, err := manager.Start(Snapshot{RunID: "run", SessionID: "session"}, func(run *Run) {
		<-run.Context().Done()
		close(cancelled)
		<-release
		if err := run.Finalize(StatusCompleted, nil, func(snapshot Snapshot) error {
			if snapshot.Status != StatusInterrupted || snapshot.ErrorCode != "run_interrupted" || snapshot.Error == "" {
				t.Errorf("shutdown snapshot = %+v", snapshot)
			}
			close(saved)
			return nil
		}); err != nil {
			t.Error(err)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- manager.Shutdown(context.Background()) }()
	<-cancelled
	select {
	case err := <-shutdownResult:
		t.Fatalf("shutdown returned before cleanup: %v", err)
	default:
	}
	close(release)
	select {
	case err := <-shutdownResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not wait for cleanup")
	}
	<-saved
	if run.Snapshot().Status != StatusInterrupted {
		t.Fatal("run was not interrupted")
	}
	if _, err := manager.Start(Snapshot{RunID: "new", SessionID: "other"}, nil); err != ErrShutdown {
		t.Fatalf("stopped manager accepted a run: %v", err)
	}
}

func TestWaitingInputReconnectAndResume(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown(context.Background())
	persisted := make(chan struct{}, 1)
	done := make(chan string, 1)
	run, err := manager.Start(Snapshot{RunID: "waiting", SessionID: "session"}, func(r *Run) {
		answer, err := r.WaitForInput(r.Context(), agent.WaitingInput{Question: "Which file?", Options: []string{"A", "B"}}, func(snapshot Snapshot) error {
			if snapshot.Status != StatusWaitingUser {
				t.Error("waiting not persisted")
			}
			persisted <- struct{}{}
			return nil
		})
		if err != nil {
			t.Error(err)
		}
		done <- answer
		r.Finish(StatusCompleted, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	<-persisted
	snapshot, _, unsubscribe := run.Subscribe()
	defer unsubscribe()
	if snapshot.Status != StatusWaitingUser || snapshot.WaitingInput.Question != "Which file?" {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if !run.Resume("A") {
		t.Fatal("resume failed")
	}
	if got := <-done; got != "A" {
		t.Fatalf("answer=%q", got)
	}
}

func TestComputerConsentIsTypedAndPersistedBeforeResume(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown(context.Background())
	waiting := make(chan struct{})
	done := make(chan string, 1)
	run, err := manager.Start(Snapshot{RunID: "permission", SessionID: "session"}, func(r *Run) {
		answer, err := r.WaitForInput(r.Context(), agent.WaitingInput{Kind: "computer_permission", Question: "打开登录网站", Options: []string{"allow_once", "allow_session", "deny"}}, func(Snapshot) error { close(waiting); return nil })
		if err != nil {
			t.Error(err)
		}
		done <- answer
	})
	if err != nil {
		t.Fatal(err)
	}
	<-waiting
	snapshot, events, unsubscribe := run.Subscribe()
	defer unsubscribe()
	if snapshot.WaitingInput.Kind != "computer_permission" {
		t.Fatal("reconnect lost pending permission")
	}
	if ok, err := run.ResumeWithGrant("yes", nil, nil); ok || err == nil {
		t.Fatal("freeform answer authorized computer")
	}
	grant := true
	persisted := false
	ok, err := run.ResumeWithGrant("allow_once", &grant, func(v Snapshot) error {
		if !v.ComputerGranted || v.WaitingInput != nil {
			t.Fatal("invalid durable consent checkpoint")
		}
		persisted = true
		return nil
	})
	if !ok || err != nil || !persisted || <-done != "allow_once" {
		t.Fatalf("consent resume failed: %v %v", ok, err)
	}
	event := <-events
	if event.ComputerGranted == nil || !*event.ComputerGranted {
		t.Fatal("SSE did not carry live grant")
	}
	run.RevokeComputerGrant()
	if run.Snapshot().ComputerGranted {
		t.Fatal("manual off kept once grant")
	}
	event = <-events
	if event.ComputerGranted == nil || *event.ComputerGranted {
		t.Fatal("SSE did not revoke grant")
	}
}

func TestTerminalRunExpiresComputerGrant(t *testing.T) {
	for _, finalize := range []bool{false, true} {
		manager := NewManager()
		run := manager.Restore(Snapshot{RunID: "once", SessionID: "session", Status: StatusRunning, ComputerGranted: true})
		_, events, unsubscribe := run.Subscribe()
		if finalize {
			if err := run.Finalize(StatusCompleted, nil, func(snapshot Snapshot) error {
				if snapshot.ComputerGranted {
					t.Fatal("terminal checkpoint kept one-turn grant")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		} else {
			run.Finish(StatusCancelled, nil)
		}
		if run.Snapshot().ComputerGranted {
			t.Fatal("terminal snapshot kept one-turn grant")
		}
		event := <-events
		if event.ComputerGranted == nil || *event.ComputerGranted {
			t.Fatal("terminal SSE did not expire one-turn grant")
		}
		unsubscribe()
		_ = manager.Shutdown(context.Background())
	}
}
