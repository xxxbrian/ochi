package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestResourceWaitCancellationAndRunRelease(t *testing.T) {
	resources := newResourceManager()
	first := resourceOwner{RunID: "first", UserID: "user", SessionID: "a"}
	second := resourceOwner{RunID: "second", UserID: "user", SessionID: "b"}
	key := "project:/data/projects/shared"
	if err := resources.acquire(context.Background(), key, first, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	waited := false
	if err := resources.acquire(ctx, key, second, func(waiting bool) { waited = waiting }); !errors.Is(err, context.DeadlineExceeded) || !waited {
		t.Fatalf("waiting cancellation: %v %v", err, waited)
	}
	if err := resources.acquire(context.Background(), "project:/data/projects/other", second, nil); err != nil {
		t.Fatal(err)
	}
	resources.releaseRun(first.RunID)
	if err := resources.acquire(context.Background(), key, second, nil); err != nil {
		t.Fatal(err)
	}
	resources.releaseRun(second.RunID)
	if err := resources.AcquireDesktopControl(context.Background(), "user", "a"); err != nil {
		t.Fatal(err)
	}
	if state := resources.DesktopState("user"); state["control"] != true || state["session_id"] != "a" {
		t.Fatal(state)
	}
	resources.releaseRun(first.RunID)
	if state := resources.DesktopState("user"); state["control"] != true {
		t.Fatal("run cleanup released manual control")
	}
	resources.ReleaseDesktopControl("user", "a")
	if state := resources.DesktopState("user"); state["busy"] != false {
		t.Fatal(state)
	}
}
