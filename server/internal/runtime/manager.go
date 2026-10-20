// Package runtime owns live run state. It deliberately keeps only a short-lived
// in-memory projection; durable run history belongs in storage.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"ochi/server/internal/agent"
	"sync"
	"time"
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
	Arguments  json.RawMessage `json:"arguments,omitempty"`
	Output     string          `json:"output,omitempty"`
	Screenshot string          `json:"screenshot,omitempty"`
}

type Snapshot struct {
	RunID           string                `json:"run_id"`
	SessionID       string                `json:"session_id"`
	Status          string                `json:"status"`
	Output          string                `json:"output"`
	Reasoning       []agent.ReasoningPart `json:"reasoning"`
	Error           string                `json:"error,omitempty"`
	Seq             uint64                `json:"seq"`
	CreatedAt       time.Time             `json:"created_at"`
	UpdatedAt       time.Time             `json:"updated_at"`
	Steps           []Step                `json:"steps"`
	Timeline        []ProcessEntry        `json:"timeline"`
	ModelID         string                `json:"model_id,omitempty"`
	ModelName       string                `json:"model_name,omitempty"`
	Effort          string                `json:"effort,omitempty"`
	Usage           agent.Usage           `json:"usage"`
	Artifacts       []agent.Attachment    `json:"artifacts"`
	WaitingInput    *agent.WaitingInput   `json:"waiting_input,omitempty"`
	Resource        string                `json:"resource,omitempty"`
	ComputerGranted bool                  `json:"computer_granted"`
}

type Event struct {
	Type            string               `json:"type"`
	RunID           string               `json:"run_id"`
	Seq             uint64               `json:"seq"`
	UpdatedAt       time.Time            `json:"updated_at"`
	Text            string               `json:"text,omitempty"`
	Reasoning       *agent.ReasoningPart `json:"reasoning,omitempty"`
	Status          string               `json:"status,omitempty"`
	Error           string               `json:"error,omitempty"`
	Step            *Step                `json:"step,omitempty"`
	Usage           *agent.Usage         `json:"usage,omitempty"`
	WaitingInput    *agent.WaitingInput  `json:"waiting_input,omitempty"`
	Artifacts       []agent.Attachment   `json:"artifacts,omitempty"`
	Resource        string               `json:"resource,omitempty"`
	ComputerGranted *bool                `json:"computer_granted,omitempty"`
	TimelineEntry   *ProcessEntry        `json:"timeline_entry,omitempty"`
	Timeline        []ProcessEntry       `json:"timeline,omitempty"`
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
	mu           sync.Mutex
	snapshot     Snapshot
	subs         map[uint64]chan Event
	nextSub      uint64
	ctx          context.Context
	cancel       context.CancelFunc
	answer       chan string
	started      bool           // guarded by the manager lock
	public       []ProcessEntry // current reply candidates, also visible in the timeline
	publicOpen   bool
	publicSource string
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

func (m *Manager) ApplySnapshot(snapshot Snapshot) *Run {
	run := m.Restore(snapshot)
	run.mu.Lock()
	if !run.started && snapshot.Seq >= run.snapshot.Seq {
		run.snapshot = ReconcileTerminal(snapshot)
		run.publishLocked(Event{Type: "status", RunID: snapshot.RunID, Seq: snapshot.Seq, Status: snapshot.Status, Resource: snapshot.Resource})
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

func (r *Run) Append(text string) error {
	return r.AppendText("", text, false)
}

// AppendText retains provider item identity for late phase classification.
func (r *Run) AppendText(id, text string, pending bool) error {
	if text == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	r.snapshot.Output += text
	r.snapshot.Seq++
	part := r.appendPublicLocked(id, text)
	part.Pending, part.Final = pending, !pending
	if len(r.public) > 0 && r.public[len(r.public)-1].ID == part.ID {
		r.public[len(r.public)-1] = part
	} else {
		r.public = append(r.public, part)
	}
	entry := r.upsertProcessLocked(part)
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "text_delta", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Text: text, TimelineEntry: entry})
	return nil
}

func (r *Run) AppendProgress(id, text string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	key := "progress:" + id
	// A gateway may reveal commentary only when the message item completes.
	// Reclassify every occurrence in place, without moving or hiding its text.
	var current *ProcessEntry
	changed := 0
	changedID := ""
	for _, item := range r.snapshot.Timeline {
		if item.Kind == "progress" && publicSourceMatches(item.ID, key) {
			if item.Pending || item.Final {
				changed++
				changedID = item.ID
			}
			item.Pending, item.Final = false, false
			current = r.upsertProcessLocked(item)
		}
	}
	remaining := r.public[:0]
	for _, item := range r.public {
		if !publicSourceMatches(item.ID, key) {
			remaining = append(remaining, item)
		}
	}
	r.public = remaining
	if text == "" && current == nil {
		return nil
	}
	r.snapshot.Output = ""
	for _, item := range r.public {
		r.snapshot.Output += item.Text
	}
	r.snapshot.Seq++
	if text != "" {
		entry := r.appendPublicLocked(id, text)
		entry.Pending, entry.Final = false, false
		current = r.upsertProcessLocked(entry)
	}
	r.snapshot.UpdatedAt = time.Now().UTC()
	event := Event{Type: "progress", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Text: r.snapshot.Output, TimelineEntry: current}
	if changed > 1 || (changed == 1 && current.ID != changedID) {
		event.Timeline = r.snapshot.Timeline
	}
	r.publishLocked(event)
	return nil
}

// CommitOutput classifies the reply without replacing the blocks that have
// already streamed. Only terminal completion allows the UI to fold its prefix.
func (r *Run) CommitOutput() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	for i := range r.public {
		r.public[i].Pending, r.public[i].Final = false, true
		r.upsertProcessLocked(r.public[i])
	}
	r.publicOpen = false
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "output_commit", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Text: r.snapshot.Output, Timeline: r.snapshot.Timeline})
	return nil
}

func (r *Run) AppendReasoning(delta agent.ReasoningPart) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	if delta.ID == "" || (delta.Kind != "reasoning" && delta.Kind != "summary") {
		return errors.New("invalid reasoning part")
	}
	found := false
	part := delta
	for i := range r.snapshot.Reasoning {
		existing := &r.snapshot.Reasoning[i]
		if existing.ID == delta.ID {
			existing.Text += delta.Text
			existing.Done = delta.Done
			part = *existing
			found = true
			break
		}
	}
	if !found {
		if delta.Text == "" {
			return nil
		}
		r.snapshot.Reasoning = append(r.snapshot.Reasoning, delta)
	}
	r.snapshot.Seq++
	entry := r.upsertProcessLocked(ProcessEntry{ID: "reasoning:" + part.ID, Seq: r.snapshot.Seq, Kind: "reasoning", Reasoning: &part})
	if delta.Text != "" {
		r.publicOpen = false
	}
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "reasoning_delta", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Reasoning: &delta, TimelineEntry: entry})
	return nil
}

func (r *Run) UpdateStep(step Step) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) {
		return context.Canceled
	}
	if r.ctx.Err() != nil {
		finishing := false
		for _, existing := range r.snapshot.Steps {
			if existing.ID == step.ID && existing.Status == "running" && (step.Status == "completed" || step.Status == "failed") {
				finishing = true
				break
			}
		}
		if !finishing {
			return context.Canceled
		}
	}
	step = cloneStep(step)
	found := false
	for i := range r.snapshot.Steps {
		if r.snapshot.Steps[i].ID == step.ID {
			r.snapshot.Steps[i] = step
			found = true
			break
		}
	}
	if !found {
		r.snapshot.Steps = append(r.snapshot.Steps, step)
	}
	r.snapshot.Seq++
	entry := r.upsertProcessLocked(ProcessEntry{ID: "tool:" + step.ID, Seq: r.snapshot.Seq, Kind: "tool", Step: &step})
	r.publicOpen = false
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "step", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Step: &step, TimelineEntry: entry})
	return nil
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

func (r *Run) Finish(status, message string) {
	if !IsTerminal(status) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) {
		return
	}
	for i := range r.snapshot.Steps {
		if r.snapshot.Steps[i].Status == "running" {
			r.snapshot.Steps[i].Status = "failed"
		}
	}
	for i := range r.snapshot.Reasoning {
		r.snapshot.Reasoning[i].Done = true
	}
	reconcileTimeline(&r.snapshot)
	r.snapshot.WaitingInput = nil
	r.snapshot.Resource = ""
	r.snapshot.ComputerGranted = false
	r.snapshot.Status, r.snapshot.Error = status, message
	r.public = nil
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	grant := false
	r.publishLocked(Event{Type: "status", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: status, Error: message, ComputerGranted: &grant, Timeline: r.snapshot.Timeline})
	r.cancel()
}

// Finalize freezes output while it is committed, then publishes a terminal
// status. A cancellation racing the commit either wins before this lock or
// sees the already completed run; it never changes saved completed output.
func (r *Run) Finalize(status, message string, persist func(Snapshot) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) {
		return nil
	}
	if r.snapshot.Status == StatusCancelling {
		status, message = StatusCancelled, ""
	} else if r.ctx.Err() != nil {
		status, message = StatusInterrupted, "server stopped before the run completed"
	}
	final := cloneSnapshot(r.snapshot)
	var changedSteps []Step
	var changedReasoning []agent.ReasoningPart
	for i := range final.Steps {
		if final.Steps[i].Status == "running" {
			final.Steps[i].Status = "failed"
			changedSteps = append(changedSteps, final.Steps[i])
		}
	}
	for i := range final.Reasoning {
		if !final.Reasoning[i].Done {
			final.Reasoning[i].Done = true
			delta := final.Reasoning[i]
			delta.Text = ""
			changedReasoning = append(changedReasoning, delta)
		}
	}
	reconcileTimeline(&final)
	final.WaitingInput = nil
	final.Resource = ""
	final.ComputerGranted = false
	final.Status, final.Error = status, message
	final.Seq += uint64(len(changedSteps)+len(changedReasoning)) + 1
	final.UpdatedAt = time.Now().UTC()
	err := persist(cloneSnapshot(final))
	if err != nil {
		final.Status, final.Error = StatusFailed, "could not save run result"
		// The retry keeps live and durable status aligned after a transient DB
		// failure without introducing a queue or automatic run resumption.
		_ = persist(cloneSnapshot(final))
	}
	seq := r.snapshot.Seq
	r.snapshot = final
	r.public = nil
	for _, step := range changedSteps {
		seq++
		r.publishLocked(Event{Type: "step", RunID: final.RunID, Seq: seq, Step: &step, TimelineEntry: processEntry(final.Timeline, "tool:"+step.ID)})
	}
	for _, part := range changedReasoning {
		seq++
		delta := part
		r.publishLocked(Event{Type: "reasoning_delta", RunID: final.RunID, Seq: seq, Reasoning: &delta, TimelineEntry: processEntry(final.Timeline, "reasoning:"+part.ID)})
	}
	grant := false
	r.publishLocked(Event{Type: "status", RunID: final.RunID, Seq: final.Seq, Status: final.Status, Error: final.Error, ComputerGranted: &grant, Timeline: final.Timeline})
	r.cancel()
	return err
}

func (r *Run) publishLocked(event Event) {
	event.UpdatedAt = r.snapshot.UpdatedAt
	for id, ch := range r.subs {
		copy := event
		if event.Step != nil {
			step := cloneStep(*event.Step)
			copy.Step = &step
		}
		if event.Reasoning != nil {
			part := *event.Reasoning
			copy.Reasoning = &part
		}
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
		if event.TimelineEntry != nil {
			entry := cloneProcessEntry(*event.TimelineEntry)
			copy.TimelineEntry = &entry
		}
		copy.Timeline = cloneTimeline(event.Timeline)
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
	snapshot.Reasoning = append([]agent.ReasoningPart{}, snapshot.Reasoning...)
	snapshot.Artifacts = cloneArtifacts(snapshot.Artifacts)
	snapshot.Usage = cloneUsage(snapshot.Usage)
	if snapshot.WaitingInput != nil {
		input := *snapshot.WaitingInput
		input.Options = append([]string{}, input.Options...)
		snapshot.WaitingInput = &input
	}
	snapshot.Steps = append([]Step{}, snapshot.Steps...)
	for i := range snapshot.Steps {
		snapshot.Steps[i] = cloneStep(snapshot.Steps[i])
	}
	snapshot.Timeline = cloneTimeline(snapshot.Timeline)
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

func (r *Run) ResetOutput() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	// A tool-bearing assistant reply is public progress, not hidden reasoning.
	// Its first token's sequence is retained even when reasoning interleaved.
	for _, entry := range r.public {
		if hasPublicText(entry) {
			entry.Pending, entry.Final = false, false
			r.upsertProcessLocked(entry)
		}
	}
	r.public = nil
	r.publicOpen = false
	r.snapshot.Output = ""
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	r.publishLocked(Event{Type: "output_reset", RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Timeline: r.snapshot.Timeline})
	return nil
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
