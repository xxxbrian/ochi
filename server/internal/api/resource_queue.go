package api

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

type resourceManager struct {
	mu         sync.Mutex
	owners     map[string]resourceOwner
	tickets    map[string]*resourceTicket
	next       uint64
	generation uint64
	changed    chan struct{}
	now        func() time.Time
}

type resourceTicket struct {
	id          string
	sequence    uint64
	owner       resourceOwner
	keys        []string
	created     time.Time
	readySince  time.Time
	waited      time.Duration
	ready       bool
	checkpoints int
}

type resourceRequest struct {
	Owner              resourceOwner
	Keys               []string
	RequestID          string
	CheckpointDuration time.Duration
	NoCheckpoint       bool
	Guard              func() error
	Available          func(context.Context) (bool, error)
	OnState            func(resourceQueueCheckpoint)

	// Tests drive the reporting boundary without waiting for wall-clock timers.
	checkpoint <-chan time.Time
}

type resourceAdmission struct {
	Acquired   []string
	Fresh      bool
	Checkpoint *resourceQueueCheckpoint
}

type resourceQueueCheckpoint struct {
	RequestID       string `json:"request_id"`
	Status          string `json:"status"`
	Resource        string `json:"resource"`
	Executed        bool   `json:"executed"`
	Sequence        uint64 `json:"sequence"`
	ElapsedMS       int64  `json:"elapsed_ms"`
	ActiveWaitMS    int64  `json:"active_wait_ms"`
	ObservedAt      string `json:"observed_at"`
	WaitingAhead    int    `json:"waiting_ahead"`
	ReadyCount      int    `json:"ready_count"`
	CheckpointCount int    `json:"checkpoint_count"`
}

var (
	errResourceTicketMissing = errors.New("resource waiting ticket is no longer active")
	errResourceTicketOwner   = errors.New("resource waiting ticket belongs to another operation")
	errResourceTicketActive  = errors.New("resource waiting ticket already has an active wait")
)

func newResourceManager() *resourceManager {
	return &resourceManager{
		owners: map[string]resourceOwner{}, tickets: map[string]*resourceTicket{},
		changed: make(chan struct{}), now: time.Now,
	}
}

func (r *resourceManager) notify() {
	r.generation++
	close(r.changed)
	r.changed = make(chan struct{})
}

func (r *resourceManager) wake() {
	r.mu.Lock()
	r.notify()
	r.mu.Unlock()
}

func sameResourceOwner(left, right resourceOwner) bool {
	if left.Manual || right.Manual {
		return left.Manual && right.Manual && left.UserID == right.UserID && left.ControlID == right.ControlID
	}
	return left.RunID != "" && left.RunID == right.RunID && left.UserID == right.UserID && left.SessionID == right.SessionID
}

func resourceKeys(keys []string) []string {
	keys = slices.Clone(keys)
	slices.Sort(keys)
	keys = slices.Compact(keys)
	return slices.DeleteFunc(keys, func(key string) bool { return key == "" })
}

func resourcesOverlap(left, right []string) bool {
	for _, key := range left {
		if slices.Contains(right, key) {
			return true
		}
	}
	return false
}

// A new resource set ends the previous segment before joining the queue.
// Dispatch drains resource-bound calls first; actual Jobs retain their claims.
func (r *resourceManager) releaseForResourceSet(owner resourceOwner, keys []string) {
	for _, key := range keys {
		current, owned := r.owners[key]
		if !owned || !sameResourceOwner(current, owner) {
			r.releaseOwnerLeases(owner)
			return
		}
	}
}

func (r *resourceManager) releaseOwnerLeases(owner resourceOwner) {
	for key, current := range r.owners {
		if sameResourceOwner(current, owner) {
			delete(r.owners, key)
		}
	}
}

func (r *resourceManager) register(request resourceRequest) (*resourceTicket, *resourceQueueCheckpoint, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := resourceKeys(request.Keys)
	if request.RequestID != "" {
		ticket, ok := r.tickets[request.RequestID]
		if !ok {
			return nil, nil, errResourceTicketMissing
		}
		if !sameResourceOwner(ticket.owner, request.Owner) || len(keys) > 0 && !slices.Equal(keys, ticket.keys) {
			return nil, nil, errResourceTicketOwner
		}
		if ticket.ready {
			return nil, nil, errResourceTicketActive
		}
		r.releaseForResourceSet(request.Owner, ticket.keys)
		ticket.ready, ticket.readySince = true, r.now()
		r.notify()
		return ticket, nil, nil
	}
	for _, ticket := range r.tickets {
		if !request.Owner.Manual && sameResourceOwner(ticket.owner, request.Owner) && slices.Equal(keys, ticket.keys) {
			if ticket.ready {
				return nil, nil, errResourceTicketActive
			}
			status := r.queueState(ticket)
			return ticket, &status, nil
		}
	}
	r.releaseForResourceSet(request.Owner, keys)
	r.next++
	ticket := &resourceTicket{
		id: fmt.Sprintf("resource-%d", r.next), sequence: r.next, owner: request.Owner,
		keys: keys, created: r.now(), readySince: r.now(), ready: true,
	}
	r.tickets[ticket.id] = ticket
	r.notify()
	return ticket, nil, nil
}

func (r *resourceManager) grantable(ticket *resourceTicket) bool {
	allOwned := true
	for _, key := range ticket.keys {
		owner, owned := r.owners[key]
		if owned && !sameResourceOwner(owner, ticket.owner) {
			return false
		}
		allOwned = allOwned && owned
	}
	if allOwned {
		return true
	}
	for _, earlier := range r.tickets {
		if earlier.ready && earlier.sequence < ticket.sequence && resourcesOverlap(earlier.keys, ticket.keys) {
			return false
		}
	}
	return true
}

func (r *resourceManager) removeTicket(ticket *resourceTicket) {
	if r.tickets[ticket.id] == ticket {
		delete(r.tickets, ticket.id)
		ticket.ready = false
		r.notify()
	}
}

func (r *resourceManager) queueState(ticket *resourceTicket) resourceQueueCheckpoint {
	now := r.now()
	waited := ticket.waited
	state := "paused"
	if ticket.ready {
		waited += now.Sub(ticket.readySince)
		state = "waiting"
	}
	status := resourceQueueCheckpoint{
		RequestID: ticket.id, Status: state, Sequence: ticket.sequence,
		Resource:  "project",
		ElapsedMS: max(0, now.Sub(ticket.created).Milliseconds()), ActiveWaitMS: max(0, waited.Milliseconds()),
		ObservedAt:      now.UTC().Format(time.RFC3339Nano),
		CheckpointCount: ticket.checkpoints,
	}
	for _, key := range ticket.keys {
		if strings.HasPrefix(key, "desktop:") {
			status.Resource = "desktop"
			break
		}
	}
	for _, other := range r.tickets {
		if other.ready && resourcesOverlap(other.keys, ticket.keys) {
			status.ReadyCount++
			if other.sequence < ticket.sequence {
				status.WaitingAhead++
			}
		}
	}
	return status
}

func (r *resourceManager) checkpointTicket(ticket *resourceTicket) *resourceQueueCheckpoint {
	ticket.waited += r.now().Sub(ticket.readySince)
	ticket.ready = false
	ticket.checkpoints++
	r.releaseOwnerLeases(ticket.owner)
	status := r.queueState(ticket)
	r.notify()
	return &status
}

func resourceCheckpointDuration(checkpoints int) time.Duration {
	return min(15*time.Minute, 2*time.Minute<<min(checkpoints, 3))
}

// wait never grants a parked ticket. Each continuation is a new foreground call.
func (r *resourceManager) wait(ctx context.Context, request resourceRequest, onWait func(bool)) (resourceAdmission, error) {
	if err := ctx.Err(); err != nil {
		return resourceAdmission{}, err
	}
	if request.Guard != nil {
		if err := request.Guard(); err != nil {
			return resourceAdmission{}, err
		}
	}
	ticket, parked, err := r.register(request)
	if err != nil {
		return resourceAdmission{}, err
	}
	if parked != nil {
		return resourceAdmission{Checkpoint: parked}, nil
	}
	checkpoint := request.checkpoint
	var report *time.Timer
	if checkpoint == nil && !request.NoCheckpoint {
		duration := request.CheckpointDuration
		if duration == 0 {
			duration = resourceCheckpointDuration(ticket.checkpoints)
		} else {
			duration = max(time.Second, min(15*time.Minute, duration))
		}
		report = time.NewTimer(duration)
		checkpoint = report.C
		defer report.Stop()
	}
	waiting := false
	var lastState *resourceQueueCheckpoint
	publish := func(status resourceQueueCheckpoint) {
		if request.OnState == nil {
			return
		}
		if lastState != nil && lastState.Status == status.Status &&
			lastState.WaitingAhead == status.WaitingAhead && lastState.ReadyCount == status.ReadyCount &&
			lastState.CheckpointCount == status.CheckpointCount {
			return
		}
		lastState = &status
		request.OnState(status)
	}
	defer func() {
		if waiting && onWait != nil {
			onWait(false)
		}
	}()
	fail := func(err error) (resourceAdmission, error) {
		r.mu.Lock()
		r.removeTicket(ticket)
		r.mu.Unlock()
		return resourceAdmission{}, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if request.Guard != nil {
			if err := request.Guard(); err != nil {
				return fail(err)
			}
		}
		r.mu.Lock()
		if r.tickets[ticket.id] != ticket {
			r.mu.Unlock()
			return resourceAdmission{}, errResourceTicketMissing
		}
		eligible := r.grantable(ticket)
		changed := r.changed
		generation := r.generation
		r.mu.Unlock()

		available := eligible
		if eligible && request.Available != nil {
			available, err = request.Available(ctx)
			if err != nil {
				return fail(err)
			}
		}

		r.mu.Lock()
		if r.tickets[ticket.id] != ticket {
			r.mu.Unlock()
			return resourceAdmission{}, errResourceTicketMissing
		}
		if err := ctx.Err(); err != nil {
			r.removeTicket(ticket)
			r.mu.Unlock()
			return resourceAdmission{}, err
		}
		if available && r.generation == generation && r.grantable(ticket) {
			acquired := []string{}
			for _, key := range ticket.keys {
				if _, owned := r.owners[key]; !owned {
					acquired = append(acquired, key)
				}
				r.owners[key] = ticket.owner
			}
			r.removeTicket(ticket)
			r.mu.Unlock()
			return resourceAdmission{Acquired: acquired, Fresh: len(acquired) > 0}, nil
		}
		status := r.queueState(ticket)
		r.mu.Unlock()
		publish(status)
		if !waiting {
			waiting = true
			if onWait != nil {
				onWait(true)
			}
		}
		var poll *time.Timer
		var jobChanged <-chan time.Time
		if eligible && !available {
			poll = time.NewTimer(500 * time.Millisecond)
			jobChanged = poll.C
		}
		stopPoll := func() {
			if poll != nil {
				poll.Stop()
			}
		}
		select {
		case <-ctx.Done():
			stopPoll()
			return fail(ctx.Err())
		case <-checkpoint:
			stopPoll()
			r.mu.Lock()
			if r.tickets[ticket.id] != ticket {
				r.mu.Unlock()
				return resourceAdmission{}, errResourceTicketMissing
			}
			if err := ctx.Err(); err != nil {
				r.removeTicket(ticket)
				r.mu.Unlock()
				return resourceAdmission{}, err
			}
			status := r.checkpointTicket(ticket)
			r.mu.Unlock()
			publish(*status)
			return resourceAdmission{Checkpoint: status}, nil
		case <-changed:
			stopPoll()
		case <-jobChanged:
		}
	}
}

func (r *resourceManager) requestKeys(owner resourceOwner, requestID string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ticket, ok := r.tickets[requestID]
	if !ok {
		return nil, errResourceTicketMissing
	}
	if !sameResourceOwner(ticket.owner, owner) {
		return nil, errResourceTicketOwner
	}
	return slices.Clone(ticket.keys), nil
}

func (r *resourceManager) cancelRequest(owner resourceOwner, requestID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	ticket, ok := r.tickets[requestID]
	if !ok {
		return errResourceTicketMissing
	}
	if !sameResourceOwner(ticket.owner, owner) {
		return errResourceTicketOwner
	}
	r.removeTicket(ticket)
	return nil
}

func (r *resourceManager) cancelRunRequests(runID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ticket := range r.tickets {
		if !ticket.owner.Manual && ticket.owner.RunID == runID {
			r.removeTicket(ticket)
		}
	}
}

func (r *resourceManager) cancelSessionRequests(userID, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ticket := range r.tickets {
		if !ticket.owner.Manual && ticket.owner.UserID == userID && ticket.owner.SessionID == sessionID {
			r.removeTicket(ticket)
		}
	}
}

func (r *resourceManager) acquire(ctx context.Context, key string, owner resourceOwner, onWait func(bool), guards ...func() error) error {
	request := resourceRequest{Owner: owner, Keys: []string{key}, NoCheckpoint: true}
	if len(guards) > 0 {
		request.Guard = guards[0]
	}
	_, err := r.wait(ctx, request, onWait)
	return err
}
