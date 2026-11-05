// Package runtime owns live run state. It deliberately keeps only a short-lived
// in-memory projection; durable run history belongs in storage.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"sync"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/i18n"
)

var (
	ErrRunExists = errors.New("session already has an active run")
	ErrShutdown  = errors.New("runtime manager is shutting down")
)

const (
	StatusRunning         = "running"
	StatusQueued          = "queued"
	StatusWaitingResource = "waiting_resource"
	StatusWaitingUser     = "waiting_user"
	StatusCancelling      = "cancelling"
	StatusCompleted       = "completed"
	StatusCancelled       = "cancelled"
	StatusFailed          = "failed"
	StatusInterrupted     = "interrupted"
)

type Step struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Outcome    string          `json:"outcome,omitempty"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
	Output     string          `json:"output,omitempty"`
	Screenshot string          `json:"screenshot,omitempty"`
}

type Snapshot struct {
	RunID           string              `json:"run_id"`
	SessionID       string              `json:"session_id"`
	Status          string              `json:"status"`
	Error           string              `json:"error,omitempty"`
	ErrorCode       string              `json:"error_code,omitempty"`
	Seq             uint64              `json:"seq"`
	CreatedAt       time.Time           `json:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at"`
	Items           []Item              `json:"items"`
	ModelID         string              `json:"model_id,omitempty"`
	ModelName       string              `json:"model_name,omitempty"`
	Effort          string              `json:"effort,omitempty"`
	Usage           agent.Usage         `json:"usage"`
	Artifacts       []agent.Attachment  `json:"artifacts"`
	WaitingInput    *agent.WaitingInput `json:"waiting_input,omitempty"`
	Resource        string              `json:"resource,omitempty"`
	ComputerGranted bool                `json:"computer_granted"`
}

type Event struct {
	Type            string              `json:"type"`
	RunID           string              `json:"run_id"`
	Seq             uint64              `json:"seq"`
	UpdatedAt       time.Time           `json:"updated_at"`
	Item            *Item               `json:"item,omitempty"`
	ItemID          string              `json:"item_id,omitempty"`
	Delta           string              `json:"delta,omitempty"`
	Patches         []ItemPatch         `json:"patches,omitempty"`
	Status          string              `json:"status,omitempty"`
	Error           string              `json:"error,omitempty"`
	ErrorCode       string              `json:"error_code,omitempty"`
	Usage           *agent.Usage        `json:"usage,omitempty"`
	WaitingInput    *agent.WaitingInput `json:"waiting_input,omitempty"`
	Artifacts       []agent.Attachment  `json:"artifacts,omitempty"`
	Resource        string              `json:"resource,omitempty"`
	ComputerGranted *bool               `json:"computer_granted,omitempty"`
}

func IsTerminal(status string) bool {
	switch status {
	case StatusCompleted, StatusCancelled, StatusFailed, StatusInterrupted:
		return true
	default:
		return false
	}
}

func IsActive(status string) bool {
	return status == StatusRunning || status == StatusCancelling || status == StatusWaitingUser || status == StatusWaitingResource
}

type Run struct {
	mu       sync.Mutex
	snapshot Snapshot
	subs     map[uint64]chan Event
	nextSub  uint64
	ctx      context.Context
	cancel   context.CancelFunc
	answer   chan string
	started  bool // guarded by the manager lock
}

type Manager struct {
	mu      sync.RWMutex
	runs    map[string]*Run
	active  map[string]string // session ID -> run ID
	ctx     context.Context
	cancel  context.CancelFunc
	stopped bool
	wg      sync.WaitGroup
}

func NewManager() *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{runs: make(map[string]*Run), active: make(map[string]string), ctx: ctx, cancel: cancel}
}

// Start registers a run and executes fn in a manager-owned goroutine. The
// request that created the run may safely return while fn continues running.
func (m *Manager) Start(snapshot Snapshot, fn func(*Run)) (*Run, error) {
	if snapshot.UpdatedAt.IsZero() {
		snapshot.UpdatedAt = time.Now().UTC()
	}
	if snapshot.CreatedAt.IsZero() {
		snapshot.CreatedAt = snapshot.UpdatedAt
	}
	if snapshot.Status == "" {
		snapshot.Status = StatusRunning
	}
	snapshot = cloneSnapshot(snapshot)
	m.mu.Lock()
	m.pruneLocked()
	if m.stopped {
		m.mu.Unlock()
		return nil, ErrShutdown
	}
	if existingID, ok := m.active[snapshot.SessionID]; ok && existingID != snapshot.RunID {
		if existing := m.runs[existingID]; existing != nil && IsActive(existing.Snapshot().Status) {
			m.mu.Unlock()
			return nil, ErrRunExists
		}
		delete(m.active, snapshot.SessionID)
	}
	run, exists := m.runs[snapshot.RunID]
	if exists && run.started {
		m.mu.Unlock()
		return nil, ErrRunExists
	}
	if !exists {
		runCtx, runCancel := context.WithCancel(m.ctx)
		run = &Run{snapshot: snapshot, subs: make(map[uint64]chan Event), ctx: runCtx, cancel: runCancel, answer: make(chan string, 1)}
	}
	// A GET may Restore this just-committed run before Start is reached. Keep
	// that run's manager-child context and subscribers, including an early
	// cancellation, rather than replacing the object beneath SSE readers.
	if exists && run.Snapshot().Status == StatusQueued {
		run.mu.Lock()
		run.snapshot = snapshot
		run.publishLocked(Event{Type: "status", RunID: snapshot.RunID, Seq: snapshot.Seq, Status: snapshot.Status})
		run.mu.Unlock()
	}
	run.started = true
	m.runs[snapshot.RunID] = run
	if IsActive(snapshot.Status) {
		m.active[snapshot.SessionID] = snapshot.RunID
	}
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		defer func() {
			m.mu.Lock()
			if m.active[snapshot.SessionID] == snapshot.RunID {
				delete(m.active, snapshot.SessionID)
			}
			m.mu.Unlock()
		}()
		if fn != nil {
			fn(run)
		}
	}()
	return run, nil
}

// Restore installs a terminal or interrupted snapshot loaded from PostgreSQL.
// It never replaces a live run that was already started in this process.
func (m *Manager) Restore(snapshot Snapshot) *Run {
	snapshot = ReconcileTerminal(snapshot)
	m.mu.Lock()
	m.pruneLocked()
	if existing, ok := m.runs[snapshot.RunID]; ok {
		m.mu.Unlock()
		return existing
	}
	runCtx, runCancel := context.WithCancel(m.ctx)
	run := &Run{snapshot: snapshot, subs: make(map[uint64]chan Event), ctx: runCtx, cancel: runCancel, answer: make(chan string, 1)}
	m.runs[snapshot.RunID] = run
	m.mu.Unlock()
	return run
}

func (m *Manager) Get(runID string) (*Run, bool) {
	m.mu.RLock()
	run, ok := m.runs[runID]
	m.mu.RUnlock()
	return run, ok
}

// ForgetSessions removes the short-lived projections after account deletion.
// The caller has already excluded active executions and new admissions.
func (m *Manager) ForgetSessions(sessionIDs []string) {
	sessions := make(map[string]bool, len(sessionIDs))
	for _, id := range sessionIDs {
		sessions[id] = true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, run := range m.runs {
		run.mu.Lock()
		if sessions[run.snapshot.SessionID] {
			run.cancel()
			for key, subscriber := range run.subs {
				delete(run.subs, key)
				close(subscriber)
			}
			delete(m.runs, id)
			delete(m.active, run.snapshot.SessionID)
		}
		run.mu.Unlock()
	}
}

func (m *Manager) ApplySnapshot(snapshot Snapshot) *Run {
	run := m.Restore(snapshot)
	run.mu.Lock()
	if !run.started && snapshot.Seq >= run.snapshot.Seq {
		run.snapshot = ReconcileTerminal(snapshot)
		run.publishLocked(Event{Type: "status", RunID: snapshot.RunID, Seq: snapshot.Seq, Status: snapshot.Status, Error: snapshot.Error, ErrorCode: snapshot.ErrorCode, Resource: snapshot.Resource})
	}
	run.mu.Unlock()
	return run
}

func (r *Run) SetResource(resource string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return
	}
	r.snapshot.Resource = resource
	if resource == "" {
		r.snapshot.Status = StatusRunning
	} else {
		r.snapshot.Status = StatusWaitingResource
	}
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "status", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: r.snapshot.Status, Resource: resource})
}

// Drain closes admission and waits for current executions without cancelling
// them. A deadline does not cancel runs; Shutdown remains the forced fallback.
func (m *Manager) Drain(ctx context.Context) error {
	m.mu.Lock()
	m.stopped = true
	m.mu.Unlock()
	return m.wait(ctx)
}

// Shutdown asks all manager-owned runs to stop and waits for their execution
// functions before the caller closes its database, including after Drain.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.stopped = true
	m.cancel()
	for _, run := range m.runs {
		run.requestContextCancel()
	}
	m.mu.Unlock()
	return m.wait(ctx)
}

func (m *Manager) wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Run) Context() context.Context { return r.ctx }

func (r *Run) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneSnapshot(r.snapshot)
}

// Subscribe registers the listener and captures the baseline snapshot under
// one lock, preventing a delta from being missed between those operations.
func (r *Run) Subscribe() (Snapshot, <-chan Event, func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextSub++
	id := r.nextSub
	ch := make(chan Event, 64)
	r.subs[id] = ch
	snapshot := cloneSnapshot(r.snapshot)
	return snapshot, ch, func() {
		r.mu.Lock()
		if current, ok := r.subs[id]; ok {
			delete(r.subs, id)
			close(current)
		}
		r.mu.Unlock()
	}
}

// Cancel only requests cancellation. The executor remains responsible for
// saving its final output and calling Finish, so cancellation cannot race a
// premature terminal status or lose the final assistant message.
func (r *Run) Cancel() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.snapshot.Status != StatusRunning && r.snapshot.Status != StatusWaitingUser && r.snapshot.Status != StatusWaitingResource {
		return false
	}
	r.snapshot.Status = StatusCancelling
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "status", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: StatusCancelling})
	r.cancel()
	return true
}

func (r *Run) requestContextCancel() { r.cancel() }

func FailureCode(err error) string {
	if err == nil {
		return ""
	}
	if code, params, public := i18n.Details(err); public {
		// Run history carries a viewer-localized identity, not HTTP parameters.
		// Keep transport details in diagnostics and use complete run messages.
		switch code {
		case "image_provider_http_error":
			return "image_generation_failed"
		case "search_http_error":
			return "search_failed"
		case "provider_model_list_rejected":
			return "provider_request_failed"
		case "update_http_error":
			return "update_failed"
		}
		if len(params) > 0 {
			return "run_failed"
		}
		return code
	}
	if errors.Is(err, context.Canceled) {
		return "run_interrupted"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "run_timeout"
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return "run_timeout"
	}
	var model *agent.ModelError
	if errors.As(err, &model) {
		switch model.Class {
		case "authentication", "permission", "configuration", "billing", "rate_limit", "unavailable", "connection", "context", "output_limit", "content_filter":
			return "model_" + model.Class
		case "timeout":
			return "run_timeout"
		case "stream", "invalid_stream":
			return "model_stream"
		case "tool_protocol":
			return "model_tool_protocol"
		}
	}
	var budget *agent.ContextBudgetError
	if errors.As(err, &budget) {
		return "model_context"
	}
	return "run_failed"
}

func failureText(err error) string {
	if err == nil {
		return ""
	}
	return i18n.Text(i18n.English, FailureCode(err), nil)
}

func (r *Run) Finish(status string, failure error) {
	if IsTerminal(status) {
		_ = r.Finalize(status, failure, func(Snapshot) error { return nil })
	}
}

// Finalize freezes the authoritative items while persistence commits, then
// publishes only lifecycle patches and terminal metadata.
func (r *Run) Finalize(status string, failure error, persist func(Snapshot) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) {
		return nil
	}
	if r.snapshot.Status == StatusCancelling {
		status, failure = StatusCancelled, nil
	} else if r.ctx.Err() != nil {
		status, failure = StatusInterrupted, i18n.New("run_interrupted")
	}
	final := cloneSnapshot(r.snapshot)
	patches := closeItems(&final)
	final.WaitingInput, final.Resource, final.ComputerGranted = nil, "", false
	if failure != nil {
		log.Printf("run %s finished with %s: %v", r.snapshot.RunID, FailureCode(failure), failure)
	}
	final.Status, final.Error, final.ErrorCode = status, failureText(failure), FailureCode(failure)
	final.Seq++
	if len(patches) > 0 {
		final.Seq++
	}
	final.UpdatedAt = time.Now().UTC()
	err := persist(cloneSnapshot(final))
	if err != nil {
		final.Status, final.Error, final.ErrorCode = StatusFailed, i18n.New("run_save_failed").Error(), "run_save_failed"
		_ = persist(cloneSnapshot(final))
	}
	r.snapshot = final
	if len(patches) > 0 {
		r.publishLocked(Event{Type: "item_updated", RunID: final.RunID, Seq: final.Seq - 1, Patches: patches})
	}
	grant := false
	r.publishLocked(Event{Type: "status", RunID: final.RunID, Seq: final.Seq, Status: final.Status, Error: final.Error, ErrorCode: final.ErrorCode, ComputerGranted: &grant})
	r.cancel()
	return err
}

func (r *Run) publishLocked(event Event) {
	event.UpdatedAt = r.snapshot.UpdatedAt
	for id, ch := range r.subs {
		copy := event
		if event.Item != nil {
			item := cloneItem(*event.Item)
			copy.Item = &item
		}
		copy.Patches = clonePatches(event.Patches)
		if event.Usage != nil {
			usage := cloneUsage(*event.Usage)
			copy.Usage = &usage
		}
		if event.WaitingInput != nil {
			input := *event.WaitingInput
			input.Options = append([]string{}, input.Options...)
			copy.WaitingInput = &input
		}
		copy.Artifacts = cloneArtifacts(event.Artifacts)
		select {
		case ch <- copy:
		default:
			// A slow reader reconnects and receives the latest complete snapshot.
			delete(r.subs, id)
			close(ch)
		}
	}
}

func cloneStep(step Step) Step {
	if step.Arguments != nil {
		step.Arguments = append(json.RawMessage(nil), step.Arguments...)
	}
	return step
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	snapshot.Artifacts = cloneArtifacts(snapshot.Artifacts)
	snapshot.Usage = cloneUsage(snapshot.Usage)
	if snapshot.WaitingInput != nil {
		input := *snapshot.WaitingInput
		input.Options = append([]string{}, input.Options...)
		snapshot.WaitingInput = &input
	}
	snapshot.Items = cloneItems(snapshot.Items)
	return snapshot
}

func cloneUsage(usage agent.Usage) agent.Usage {
	if usage.CachedTokens != nil {
		value := *usage.CachedTokens
		usage.CachedTokens = &value
	}
	if usage.ReasoningTokens != nil {
		value := *usage.ReasoningTokens
		usage.ReasoningTokens = &value
	}
	return usage
}

func cloneArtifacts(items []agent.Attachment) []agent.Attachment {
	if items == nil {
		return []agent.Attachment{}
	}
	copy := append([]agent.Attachment{}, items...)
	for i := range copy {
		if copy[i].Generation != nil {
			generation := *copy[i].Generation
			copy[i].Generation = &generation
		}
	}
	return copy
}

func (r *Run) AddUsage(usage agent.Usage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshot.Usage.PromptTokens += usage.PromptTokens
	r.snapshot.Usage.CompletionTokens += usage.CompletionTokens
	r.snapshot.Usage.TotalTokens += usage.TotalTokens
	if usage.CachedTokens != nil {
		v := *usage.CachedTokens
		if r.snapshot.Usage.CachedTokens != nil {
			v += *r.snapshot.Usage.CachedTokens
		}
		r.snapshot.Usage.CachedTokens = &v
	}
	if usage.ReasoningTokens != nil {
		v := *usage.ReasoningTokens
		if r.snapshot.Usage.ReasoningTokens != nil {
			v += *r.snapshot.Usage.ReasoningTokens
		}
		r.snapshot.Usage.ReasoningTokens = &v
	}
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	v := r.snapshot.Usage
	r.publishLocked(Event{Type: "usage", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Usage: &v})
}
func (r *Run) SetArtifacts(items []agent.Attachment) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshot.Artifacts = cloneArtifacts(items)
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "artifacts", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Artifacts: items})
}
func (r *Run) WaitForInput(ctx context.Context, input agent.WaitingInput, persist ...func(Snapshot) error) (string, error) {
	r.mu.Lock()
	if r.ctx.Err() != nil || IsTerminal(r.snapshot.Status) {
		r.mu.Unlock()
		return "", context.Canceled
	}
	previous := cloneSnapshot(r.snapshot)
	r.snapshot.Status = StatusWaitingUser
	input.Options = append([]string{}, input.Options...)
	r.snapshot.WaitingInput = &input
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	if len(persist) > 0 {
		if err := persist[0](cloneSnapshot(r.snapshot)); err != nil {
			r.snapshot = previous
			r.mu.Unlock()
			return "", err
		}
	}
	r.publishLocked(Event{Type: "waiting", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: StatusWaitingUser, WaitingInput: &input})
	r.mu.Unlock()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case answer := <-r.answer:
		return answer, nil
	}
}
func (r *Run) Resume(answer string) bool {
	ok, _ := r.ResumeWithGrant(answer, nil, nil)
	return ok
}

// Consent is committed before waking the executor. The grant is never inferred
// from model text and only an actual pending permission card accepts these IDs.
func (r *Run) ResumeWithGrant(answer string, grant *bool, persist func(Snapshot) error) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.snapshot.Status != StatusWaitingUser || r.ctx.Err() != nil {
		return false, nil
	}
	if r.snapshot.WaitingInput != nil && r.snapshot.WaitingInput.Kind == "computer_permission" && answer != "allow_once" && answer != "allow_session" && answer != "deny" {
		return false, errors.New("invalid computer permission choice")
	}
	next := cloneSnapshot(r.snapshot)
	next.Status = StatusRunning
	next.WaitingInput = nil
	if grant != nil {
		next.ComputerGranted = *grant
	}
	next.Seq++
	next.UpdatedAt = time.Now().UTC()
	if persist != nil {
		if err := persist(next); err != nil {
			return false, err
		}
	}
	select {
	case r.answer <- answer:
	default:
		return false, nil
	}
	r.snapshot = next
	r.publishLocked(Event{Type: "status", RunID: next.RunID, Seq: next.Seq, Status: StatusRunning, ComputerGranted: grant})
	return true, nil
}

func (r *Run) RevokeComputerGrant() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshot.ComputerGranted = false
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	grant := false
	r.publishLocked(Event{Type: "status", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: r.snapshot.Status, ComputerGranted: &grant})
}

// Finished projections are reloadable from PostgreSQL; do not keep screenshots
// and long transcripts alive indefinitely in a small long-running server.
func (m *Manager) pruneLocked() {
	for id, run := range m.runs {
		run.mu.Lock()
		stale := IsTerminal(run.snapshot.Status) && len(run.subs) == 0 && (time.Since(run.snapshot.UpdatedAt) > 15*time.Minute || len(m.runs) > 100)
		run.mu.Unlock()
		if stale {
			delete(m.runs, id)
		}
	}
}
