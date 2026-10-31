package api

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type resourceWaitResult struct {
	admission resourceAdmission
	err       error
}

func resourceTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

func queuedResourceWait(t *testing.T, resources *resourceManager, ctx context.Context, request resourceRequest) <-chan resourceWaitResult {
	t.Helper()
	waiting := make(chan struct{})
	result := make(chan resourceWaitResult, 1)
	var once sync.Once
	go func() {
		admission, err := resources.wait(ctx, request, func(active bool) {
			if active {
				once.Do(func() { close(waiting) })
			}
		})
		result <- resourceWaitResult{admission, err}
	}()
	select {
	case <-waiting:
	case early := <-result:
		t.Fatalf("expected a blocked foreground wait, got %+v %v", early.admission, early.err)
	case <-time.After(3 * time.Second):
		t.Fatal("resource request did not reach waiting state")
	}
	return result
}

func resourceResult(t *testing.T, results <-chan resourceWaitResult) resourceWaitResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("resource wait did not finish")
		return resourceWaitResult{}
	}
}

func queueOwner(run string) resourceOwner {
	return resourceOwner{UserID: "owner", SessionID: run, RunID: run}
}

func TestResourceReadyFIFO(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	if err := resources.acquire(context.Background(), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	results := []<-chan resourceWaitResult{}
	for i := range 8 {
		results = append(results, queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
			Owner: queueOwner(fmt.Sprintf("run-%d", i)), Keys: []string{key}, NoCheckpoint: true,
		}))
	}
	resources.releaseRun("holder")
	for i, result := range results {
		value := resourceResult(t, result)
		if value.err != nil || !slices.Equal(value.admission.Acquired, []string{key}) || value.admission.Checkpoint != nil {
			t.Fatalf("request %d was not granted: %+v %v", i, value.admission, value.err)
		}
		for _, later := range results[i+1:] {
			select {
			case value := <-later:
				t.Fatalf("later request overtook FIFO: %+v %v", value.admission, value.err)
			default:
			}
		}
		resources.releaseRun(fmt.Sprintf("run-%d", i))
	}
}

func TestResourceManualConnectionsShareTheirExistingControlIdentity(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	owner := resourceOwner{UserID: "owner", SessionID: "viewer", ControlID: desktopControlID("viewer"), Manual: true}
	first := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{key}, NoCheckpoint: true,
	})
	second := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{key}, NoCheckpoint: true,
	})
	resources.releaseRun("holder")
	if result := resourceResult(t, first); result.err != nil {
		t.Fatal(result.err)
	}
	if result := resourceResult(t, second); result.err != nil {
		t.Fatal(result.err)
	}
	if state := resources.DesktopState("owner"); state["control"] != true || state["session_id"] != "viewer" {
		t.Fatal("manual connections lost their shared control identity")
	}
	resources.releaseRun("holder")
	if state := resources.DesktopState("owner"); state["control"] != true {
		t.Fatal("run cleanup released human control")
	}
	resources.ReleaseDesktopControl("owner", "viewer")
}

func TestResourceMultipleKeysAreAtomicAndReadyConflictsKeepOrder(t *testing.T) {
	resources := newResourceManager()
	first, second := "desktop:owner", "project:/data/projects/shared"
	if err := resources.acquire(resourceTestContext(t), first, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(resourceTestContext(t))
	both := queuedResourceWait(t, resources, ctx, resourceRequest{
		Owner: queueOwner("both"), Keys: []string{second, first, second}, NoCheckpoint: true,
	})
	resources.mu.Lock()
	_, secondHeld := resources.owners[second]
	resources.mu.Unlock()
	if secondHeld {
		t.Fatal("request held one resource while waiting for another")
	}
	later := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("later"), Keys: []string{second}, NoCheckpoint: true,
	})
	cancel()
	if result := resourceResult(t, both); !errors.Is(result.err, context.Canceled) {
		t.Fatal(result.err)
	}
	if result := resourceResult(t, later); result.err != nil {
		t.Fatal(result.err)
	}
	resources.releaseRun("holder")
	resources.releaseRun("later")
}

func TestResourceUpgradeReleasesPreviousSegmentBeforeWaiting(t *testing.T) {
	resources := newResourceManager()
	desktop, project := "desktop:owner", "project:/data/projects/shared"
	owner := queueOwner("upgrade")
	if err := resources.acquire(resourceTestContext(t), project, owner, nil); err != nil {
		t.Fatal(err)
	}
	earlier := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("earlier"), Keys: []string{project}, NoCheckpoint: true,
	})
	upgrade := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{desktop, project}, NoCheckpoint: true,
	})
	if result := resourceResult(t, earlier); result.err != nil {
		t.Fatal(result.err)
	}
	resources.mu.Lock()
	if _, held := resources.owners[desktop]; held || resources.owners[project].RunID != "earlier" {
		t.Fatal("upgrading owner retained a partial set or bypassed the earlier waiter")
	}
	resources.mu.Unlock()
	resources.releaseRun("earlier")
	result := resourceResult(t, upgrade)
	if result.err != nil || !result.admission.Fresh || !slices.Equal(result.admission.Acquired, []string{desktop, project}) {
		t.Fatalf("upgraded set was not granted atomically: %+v %v", result.admission, result.err)
	}
}

func TestResourceDisjointSetChangesCannotHoldAndWait(t *testing.T) {
	resources := newResourceManager()
	desktop, project := "desktop:owner", "project:/data/projects/shared"
	desktopOwner, projectOwner := queueOwner("desktop"), queueOwner("project")
	if err := resources.acquire(resourceTestContext(t), desktop, desktopOwner, nil); err != nil {
		t.Fatal(err)
	}
	if err := resources.acquire(resourceTestContext(t), project, projectOwner, nil); err != nil {
		t.Fatal(err)
	}
	first := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: desktopOwner, Keys: []string{project}, NoCheckpoint: true,
	})
	second, err := resources.wait(resourceTestContext(t), resourceRequest{
		Owner: projectOwner, Keys: []string{desktop}, NoCheckpoint: true,
	}, nil)
	if err != nil || !slices.Equal(second.Acquired, []string{desktop}) {
		t.Fatalf("opposite set change deadlocked or lost its grant: %+v %v", second, err)
	}
	if result := resourceResult(t, first); result.err != nil || !slices.Equal(result.admission.Acquired, []string{project}) {
		t.Fatalf("first set change did not drain: %+v %v", result.admission, result.err)
	}
}

func TestResourceUpgradeCheckpointHasNoPartialOwnership(t *testing.T) {
	resources := newResourceManager()
	desktop, project := "desktop:owner", "project:/data/projects/shared"
	owner := queueOwner("upgrade")
	if err := resources.acquire(resourceTestContext(t), project, owner, nil); err != nil {
		t.Fatal(err)
	}
	if err := resources.acquire(resourceTestContext(t), desktop, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{desktop, project}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	result := resourceResult(t, wait)
	if result.err != nil || result.admission.Checkpoint == nil || result.admission.Checkpoint.Resource != "desktop" {
		t.Fatalf("upgrade did not return a desktop checkpoint: %+v %v", result.admission, result.err)
	}
	resources.mu.Lock()
	for _, held := range resources.owners {
		if sameResourceOwner(held, owner) {
			t.Fatal("paused upgrade retained an owned resource")
		}
	}
	resources.mu.Unlock()
	if _, err := resources.wait(resourceTestContext(t), resourceRequest{Owner: queueOwner("other"), Keys: []string{project}}, nil); err != nil {
		t.Fatal("a paused request blocked otherwise free project access")
	}
	resources.releaseRun("other")
	if err := resources.acquire(resourceTestContext(t), project, owner, nil); err != nil {
		t.Fatal(err)
	}
	continued := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, RequestID: result.admission.Checkpoint.RequestID, NoCheckpoint: true,
	})
	resources.mu.Lock()
	_, held := resources.owners[project]
	resources.mu.Unlock()
	if held {
		t.Fatal("continuation retained a newly acquired partial resource set")
	}
	resources.releaseRun("holder")
	if value := resourceResult(t, continued); value.err != nil || !slices.Equal(value.admission.Acquired, []string{desktop, project}) {
		t.Fatalf("continued upgrade did not acquire the full set: %+v %v", value.admission, value.err)
	}
}

func TestResourceCheckpointReleasesPreviouslyOwnedSetBlockedByActualJob(t *testing.T) {
	resources := newResourceManager()
	key, owner := "desktop:owner", queueOwner("owner")
	if err := resources.acquire(resourceTestContext(t), key, owner, nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{key}, checkpoint: checkpoint,
		Available: func(context.Context) (bool, error) { return false, nil },
	})
	checkpoint <- time.Now()
	result := resourceResult(t, wait)
	if result.err != nil || result.admission.Checkpoint == nil || resources.DesktopState("owner")["busy"] != false {
		t.Fatalf("paused actual-Job wait retained Go ownership: %+v %v", result.admission, result.err)
	}
}

func TestResourceCheckpointParksWithoutExpiryAndContinuationKeepsSequence(t *testing.T) {
	resources := newResourceManager()
	base := time.Now()
	var elapsed atomic.Int64
	resources.now = func() time.Time { return base.Add(time.Duration(elapsed.Load())) }
	key := "desktop:owner"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	first := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("first"), Keys: []string{key}, checkpoint: checkpoint,
	})
	elapsed.Store(int64(time.Minute))
	checkpoint <- base
	paused := resourceResult(t, first)
	if paused.err != nil || paused.admission.Checkpoint == nil || paused.admission.Checkpoint.Status != "paused" {
		t.Fatalf("checkpoint was not a non-error paused result: %+v %v", paused.admission, paused.err)
	}
	requestID := paused.admission.Checkpoint.RequestID
	sequence := paused.admission.Checkpoint.Sequence
	if paused.admission.Checkpoint.ActiveWaitMS != time.Minute.Milliseconds() {
		t.Fatal(paused.admission.Checkpoint)
	}
	if paused.admission.Checkpoint.Resource != "desktop" {
		t.Fatal("desktop queue was labeled as a project queue")
	}
	resources.releaseRun("holder")
	elapsed.Store(int64(365 * 24 * time.Hour))
	resources.wake()
	if state := resources.DesktopState("owner"); state["busy"] != false {
		t.Fatal("parked request was granted while the model was deciding")
	}
	if _, err := resources.requestKeys(queueOwner("first"), requestID); err != nil {
		t.Fatalf("model inference time expired the request: %v", err)
	}
	if _, err := resources.wait(resourceTestContext(t), resourceRequest{Owner: queueOwner("second"), Keys: []string{key}}, nil); err != nil {
		t.Fatal(err)
	}
	last := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("last"), Keys: []string{key}, NoCheckpoint: true,
	})
	continued := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("first"), RequestID: requestID, NoCheckpoint: true,
	})
	resources.mu.Lock()
	if resources.tickets[requestID].sequence != sequence {
		t.Fatal("continuation lost its original sequence")
	}
	resources.mu.Unlock()
	resources.releaseRun("second")
	if result := resourceResult(t, continued); result.err != nil || !result.admission.Fresh {
		t.Fatalf("continuation was not granted first: %+v %v", result.admission, result.err)
	}
	if _, err := resources.requestKeys(queueOwner("first"), requestID); !errors.Is(err, errResourceTicketMissing) {
		t.Fatal("grant did not consume the old queue priority")
	}
	resources.releaseRun("first")
	again := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("first"), Keys: []string{key}, NoCheckpoint: true,
	})
	if result := resourceResult(t, last); result.err != nil {
		t.Fatal(result.err)
	}
	resources.releaseRun("last")
	if result := resourceResult(t, again); result.err != nil {
		t.Fatal(result.err)
	}
	resources.releaseRun("first")
}

func TestResourcePausedReplayDoesNotResumeOrDuplicateRequest(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("waiting"), Keys: []string{key}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	paused := resourceResult(t, wait).admission.Checkpoint
	resources.releaseRun("holder")
	again, err := resources.wait(resourceTestContext(t), resourceRequest{Owner: queueOwner("waiting"), Keys: []string{key}}, nil)
	if err != nil || again.Checkpoint == nil || again.Checkpoint.RequestID != paused.RequestID {
		t.Fatalf("repeated acquire duplicated or resumed a parked request: %+v %v", again, err)
	}
	if state := resources.DesktopState("owner"); state["busy"] != false {
		t.Fatal("repeated tool dispatched without explicit continuation")
	}
}

func TestResourceCheckpointAndGrantHaveExactlyOneOutcome(t *testing.T) {
	for range 100 {
		resources := newResourceManager()
		key := "desktop:owner"
		if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
			t.Fatal(err)
		}
		checkpoint := make(chan time.Time, 1)
		wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
			Owner: queueOwner("waiting"), Keys: []string{key}, checkpoint: checkpoint,
		})
		gate := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-gate
			resources.releaseRun("holder")
		}()
		go func() {
			defer workers.Done()
			<-gate
			checkpoint <- time.Now()
		}()
		close(gate)
		workers.Wait()
		result := resourceResult(t, wait)
		if result.err != nil {
			t.Fatal(result.err)
		}
		resources.wake()
		state := resources.DesktopState("owner")
		if result.admission.Checkpoint != nil {
			if state["busy"] != false {
				t.Fatal("request was granted after returning a checkpoint")
			}
		} else if state["run_id"] != "waiting" || !result.admission.Fresh {
			t.Fatalf("request lost an already committed grant: %+v %+v", result.admission, state)
		}
	}
}

func TestResourceQueueCancellationOwnershipAndLeaseOnlyRelease(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	project := "project:/data/projects/shared"
	if err := resources.acquire(resourceTestContext(t), project, queueOwner("waiting"), nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("waiting"), Keys: []string{key}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	paused := resourceResult(t, wait).admission.Checkpoint
	if err := resources.cancelRequest(queueOwner("foreign"), paused.RequestID); !errors.Is(err, errResourceTicketOwner) {
		t.Fatal("foreign run cancelled a waiting request")
	}
	resources.releaseRunLeases("waiting")
	resources.mu.Lock()
	_, projectHeld := resources.owners[project]
	resources.mu.Unlock()
	if projectHeld {
		t.Fatal("lease-only cleanup retained the run's shared project claim")
	}
	if _, err := resources.requestKeys(queueOwner("waiting"), paused.RequestID); err != nil {
		t.Fatal("ordinary computation or AskUser cleanup deleted the parked request")
	}
	resources.cancelSessionRequests("foreign-user", "waiting")
	if _, err := resources.requestKeys(queueOwner("waiting"), paused.RequestID); err != nil {
		t.Fatal("foreign session cancelled request")
	}
	resources.cancelSessionRequests("owner", "waiting")
	if _, err := resources.requestKeys(queueOwner("waiting"), paused.RequestID); !errors.Is(err, errResourceTicketMissing) {
		t.Fatal("permission revocation retained request")
	}
	if state := resources.DesktopState("owner"); state["run_id"] != "holder" {
		t.Fatal("cancelling a queued request released another run's live lease")
	}
	active := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("active"), Keys: []string{key}, NoCheckpoint: true,
	})
	resources.releaseRun("active")
	if result := resourceResult(t, active); !errors.Is(result.err, errResourceTicketMissing) {
		t.Fatal("run completion left foreground wait active")
	}
}

func TestResourceGuardRevocationCancelsWithoutGrant(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	var revoked atomic.Bool
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("waiting"), Keys: []string{key}, NoCheckpoint: true,
		Guard: func() error {
			if revoked.Load() {
				return errComputerModeChanged
			}
			return nil
		},
	})
	revoked.Store(true)
	resources.wake()
	if result := resourceResult(t, wait); !errors.Is(result.err, errComputerModeChanged) {
		t.Fatal(result.err)
	}
	resources.mu.Lock()
	defer resources.mu.Unlock()
	if len(resources.tickets) != 0 || resources.owners[key].RunID != "holder" {
		t.Fatal("revoked request retained queue state or changed ownership")
	}
}

func TestResourceExternalJobsBlockWithoutOwningGoLease(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	var busy atomic.Bool
	busy.Store(true)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("waiting"), Keys: []string{key}, NoCheckpoint: true,
		Available: func(context.Context) (bool, error) { return !busy.Load(), nil },
	})
	if state := resources.DesktopState("owner"); state["busy"] != false {
		t.Fatal("Go claimed a desktop still occupied by an actual workspace Job")
	}
	busy.Store(false)
	resources.wake()
	if result := resourceResult(t, wait); result.err != nil || !result.admission.Fresh {
		t.Fatalf("drained job did not admit waiter: %+v %v", result.admission, result.err)
	}
}

func TestResourceOwnedLeaseStillChecksActualJobBeforeAnotherAction(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	owner := queueOwner("same-run")
	if err := resources.acquire(resourceTestContext(t), key, owner, nil); err != nil {
		t.Fatal(err)
	}
	var busy atomic.Bool
	busy.Store(true)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: owner, Keys: []string{key}, NoCheckpoint: true,
		Available: func(context.Context) (bool, error) { return !busy.Load(), nil },
	})
	busy.Store(false)
	resources.wake()
	result := resourceResult(t, wait)
	if result.err != nil || result.admission.Fresh || len(result.admission.Acquired) != 0 {
		t.Fatalf("owned lease skipped the actual Job gate or was reacquired: %+v %v", result.admission, result.err)
	}
}

func TestResourceExternalAvailabilitySnapshotMustMatchGeneration(t *testing.T) {
	resources := newResourceManager()
	key := "desktop:owner"
	queried, unblock, refreshed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	checkpoint := make(chan time.Time, 1)
	result := make(chan resourceWaitResult, 1)
	waiting := make(chan struct{})
	var once sync.Once
	go func() {
		admission, err := resources.wait(resourceTestContext(t), resourceRequest{
			Owner: queueOwner("waiting"), Keys: []string{key}, checkpoint: checkpoint,
			Available: func(context.Context) (bool, error) {
				switch calls.Add(1) {
				case 1:
					close(queried)
					<-unblock
					return true, nil
				case 2:
					close(refreshed)
				}
				return false, nil
			},
		}, func(active bool) {
			if active {
				once.Do(func() { close(waiting) })
			}
		})
		result <- resourceWaitResult{admission, err}
	}()
	select {
	case <-queried:
	case <-time.After(3 * time.Second):
		t.Fatal("availability query did not start")
	}
	resources.mu.Lock()
	resources.owners[key] = queueOwner("job-starter")
	resources.notify()
	delete(resources.owners, key)
	resources.notify()
	resources.mu.Unlock()
	close(unblock)
	select {
	case <-waiting:
	case <-time.After(3 * time.Second):
		t.Fatal("stale availability was incorrectly granted")
	}
	select {
	case <-refreshed:
	case <-time.After(3 * time.Second):
		t.Fatal("stale availability was not refreshed")
	}
	checkpoint <- time.Now()
	value := resourceResult(t, result)
	if value.err != nil || value.admission.Checkpoint == nil || calls.Load() < 2 {
		t.Fatalf("did not refresh stale external Job snapshot: %+v %v calls=%d", value.admission, value.err, calls.Load())
	}
	if state := resources.DesktopState("owner"); state["busy"] != false {
		t.Fatal("stale Job snapshot granted a Go lease")
	}
}

func TestResourceCheckpointIntervalsAreBounded(t *testing.T) {
	for i, expected := range []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute} {
		if got := resourceCheckpointDuration(i); got != expected {
			t.Fatalf("checkpoint %d: got %s want %s", i, got, expected)
		}
	}
}

func TestResourceProjectCheckpointReportsItsResource(t *testing.T) {
	resources := newResourceManager()
	key := "project:/data/projects/shared"
	if err := resources.acquire(resourceTestContext(t), key, queueOwner("holder"), nil); err != nil {
		t.Fatal(err)
	}
	checkpoint := make(chan time.Time, 1)
	wait := queuedResourceWait(t, resources, resourceTestContext(t), resourceRequest{
		Owner: queueOwner("waiting"), Keys: []string{key}, checkpoint: checkpoint,
	})
	checkpoint <- time.Now()
	if result := resourceResult(t, wait); result.err != nil || result.admission.Checkpoint.Resource != "project" {
		t.Fatalf("project queue was mislabeled: %+v %v", result.admission, result.err)
	}
}
