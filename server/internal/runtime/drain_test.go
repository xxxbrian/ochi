package runtime

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDrainRejectsNewRunsWithoutCancellingExistingRun(t *testing.T) {
	m := NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	started, release := make(chan struct{}), make(chan struct{})
	run, err := m.Start(Snapshot{RunID: "active", SessionID: "session"}, func(run *Run) {
		close(started)
		select {
		case <-release:
			run.Finish(StatusCompleted, "")
		case <-run.Context().Done():
			run.Finish(StatusInterrupted, "")
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := m.Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("active drain = %v", err)
	}
	if run.Context().Err() != nil {
		t.Fatal("drain cancelled the existing run")
	}
	if _, err := m.Start(Snapshot{RunID: "new", SessionID: "other"}, nil); !errors.Is(err, ErrShutdown) {
		t.Fatalf("draining runtime accepted new run: %v", err)
	}
	close(release)
	if err := m.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if run.Snapshot().Status != StatusCompleted {
		t.Fatal("graceful run did not complete")
	}
}
