package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func drainTestServer(t *testing.T) *Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{runtime: runtime.NewManager(), backgroundCtx: ctx, backgroundCancel: cancel, desktops: newDesktopHub()}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), time.Second)
		defer done()
		if err := s.Shutdown(cleanup); err != nil {
			t.Errorf("drain fixture shutdown: %v", err)
		}
	})
	return s
}

func TestDrainWaitsForClaimedPreparationAndRunningCleanup(t *testing.T) {
	s := drainTestServer(t)
	if !s.beginQueueAdmission() {
		t.Fatal("initial queue admission rejected")
	}
	s.stopQueueAdmissions()
	if s.beginQueueAdmission() {
		s.queueAdmissions.Done()
		t.Fatal("draining server admitted another queue claim")
	}
	// A closed claim boundary must not reach storage, even when the runtime
	// has not entered its final drain yet.
	s.launchQueued("unclaimed")
	result := make(chan error, 1)
	go func() { result <- s.Drain(context.Background()) }()
	select {
	case err := <-result:
		s.queueAdmissions.Done()
		t.Fatalf("drain missed an admitted preparation: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	started, release := make(chan struct{}), make(chan struct{})
	run, err := s.runtime.Start(runtime.Snapshot{RunID: "prepared", SessionID: "session"}, func(run *runtime.Run) {
		close(started)
		select {
		case <-release:
			run.Finish(runtime.StatusCompleted, "")
		case <-run.Context().Done():
			run.Finish(runtime.StatusInterrupted, "unexpected cancellation")
		}
	})
	s.queueAdmissions.Done()
	if err != nil {
		t.Fatal(err)
	}
	<-started
	select {
	case err := <-result:
		t.Fatalf("drain returned while execution was active: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if run.Context().Err() != nil {
		t.Fatal("graceful drain cancelled the run")
	}
	close(release)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("drain did not finish after run cleanup")
	}
	if run.Snapshot().Status != runtime.StatusCompleted {
		t.Fatal("drained run did not complete normally")
	}
	if _, err := s.runtime.Start(runtime.Snapshot{RunID: "late", SessionID: "other"}, nil); !errors.Is(err, runtime.ErrShutdown) {
		t.Fatalf("drained runtime accepted a new run: %v", err)
	}
}

func TestDrainDeadlineLeavesRunAliveUntilForcedShutdown(t *testing.T) {
	s := drainTestServer(t)
	started, saved := make(chan struct{}), make(chan struct{})
	run, err := s.runtime.Start(runtime.Snapshot{RunID: "slow", SessionID: "session"}, func(run *runtime.Run) {
		close(started)
		<-run.Context().Done()
		if err := run.Finalize(runtime.StatusCompleted, "", func(snapshot runtime.Snapshot) error {
			if snapshot.Status != runtime.StatusInterrupted {
				t.Errorf("forced shutdown snapshot = %s", snapshot.Status)
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
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain deadline = %v", err)
	}
	if run.Context().Err() != nil {
		t.Fatal("drain deadline cancelled the run before forced shutdown")
	}
	shutdown, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err := s.Shutdown(shutdown); err != nil {
		t.Fatal(err)
	}
	select {
	case <-saved:
	default:
		t.Fatal("forced shutdown returned before final persistence")
	}
}

func TestShutdownWaitsForPreparationAfterDrainDeadline(t *testing.T) {
	s := drainTestServer(t)
	if !s.beginQueueAdmission() {
		t.Fatal("initial queue admission rejected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		s.queueAdmissions.Done()
		t.Fatalf("preparation drain deadline = %v", err)
	}
	result := make(chan error, 1)
	go func() { result <- s.Shutdown(context.Background()) }()
	select {
	case err := <-result:
		s.queueAdmissions.Done()
		t.Fatalf("shutdown missed unfinished preparation: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := s.runtime.Start(runtime.Snapshot{RunID: "late", SessionID: "session"}, nil); !errors.Is(err, runtime.ErrShutdown) {
		s.queueAdmissions.Done()
		t.Fatalf("forced shutdown accepted prepared work: %v", err)
	}
	s.queueAdmissions.Done()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish after preparation cleanup")
	}
}

func TestDrainKeepsNewInputsQueuedForRestart(t *testing.T) {
	f := newCoreHTTPFixture(t)
	f.server.agent = agent.DemoGenerator{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := f.server.store.CreateSession(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	queued, err := f.server.startRun(ctx, f.owner, session.ID, "Keep this input for the next process", "", "", nil)
	if err != nil || queued.Status != runtime.StatusQueued {
		t.Fatalf("new input during drain = %s, %v", queued.Status, err)
	}
	pending, err := f.server.store.PendingRuns(ctx, f.owner, session.ID)
	if err != nil || len(pending) != 1 || pending[0].RunID != queued.RunID {
		t.Fatalf("durable pending input = %+v, %v", pending, err)
	}
	restarted, err := NewServer(f.server.store, agent.DemoGenerator{}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Shutdown(context.Background()) })
	restarted.SetTools(nil)
	restarted.launchQueued(session.ID)
	live, ok := restarted.runtime.Get(queued.RunID)
	if !ok || (!runtime.IsActive(live.Snapshot().Status) && live.Snapshot().Status != runtime.StatusCompleted) {
		t.Fatal("new process did not admit the durable pending input")
	}
}
