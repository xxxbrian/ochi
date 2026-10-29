package runtime

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"ochi/server/internal/agent"
)

// Item is one public occurrence. Provider transcript records have their own
// lifecycle; source and round identities connect occurrences without text matching.
type Item struct {
	// Live items own the only writable text buffer. Snapshots expose its immutable
	// string view and never retain the builder.
	text          *strings.Builder
	ID            string `json:"id"`
	Seq           uint64 `json:"seq"`
	Kind          string `json:"kind"`
	SourceID      string `json:"source_id"`
	RoundID       string `json:"round_id"`
	Phase         string `json:"phase,omitempty"`
	State         string `json:"state"`
	Text          string `json:"text,omitempty"`
	ReasoningKind string `json:"reasoning_kind,omitempty"`
	Step          *Step  `json:"step,omitempty"`
}

type ItemPatch struct {
	ItemID string `json:"item_id"`
	Phase  string `json:"phase,omitempty"`
	State  string `json:"state,omitempty"`
	Step   *Step  `json:"step,omitempty"`
}

type Head struct {
	RunID     string    `json:"run_id"`
	Seq       uint64    `json:"seq"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (r *Run) Head() Head {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Head{RunID: r.snapshot.RunID, Seq: r.snapshot.Seq, Status: r.snapshot.Status, UpdatedAt: r.snapshot.UpdatedAt}
}

func (r *Run) emitItemLocked(event Event) {
	r.snapshot.Seq++
	r.snapshot.UpdatedAt = time.Now().UTC()
	event.RunID, event.Seq = r.snapshot.RunID, r.snapshot.Seq
	r.publishLocked(event)
}

func (r *Run) startItemLocked(item Item) int {
	item.ID = "item-" + strconv.FormatUint(r.snapshot.Seq+1, 10)
	item.Seq = r.snapshot.Seq + 1
	r.snapshot.Items = append(r.snapshot.Items, item)
	r.emitItemLocked(Event{Type: "item_started", Item: &item})
	return len(r.snapshot.Items) - 1
}

// Even a provider's oversized chunk has a fixed transport bound. UTF-8 code
// points are kept intact; the snapshot is only materialized on a reader request.
const maxItemDeltaBytes = 4096

func (r *Run) appendDeltaLocked(index int, text string) {
	item := &r.snapshot.Items[index]
	if item.text == nil {
		item.text = &strings.Builder{}
		item.text.WriteString(item.Text)
		item.Text = ""
	}
	for len(text) > 0 {
		size := min(len(text), maxItemDeltaBytes)
		if size < len(text) {
			for size > 0 && !utf8.RuneStart(text[size]) {
				size--
			}
		}
		delta := text[:size]
		text = text[size:]
		item.text.WriteString(delta)
		r.emitItemLocked(Event{Type: "item_delta", ItemID: item.ID, Delta: delta})
	}
}

func (r *Run) AppendText(roundID, sourceID, text, phase string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	if roundID == "" || sourceID == "" {
		return errors.New("public text requires round and source identity")
	}
	if phase != "pending" && phase != "commentary" && phase != "final" {
		return errors.New("invalid public text phase")
	}
	var patches []ItemPatch
	for i := range r.snapshot.Items {
		item := &r.snapshot.Items[i]
		if item.Kind == "text" && item.RoundID == roundID && item.SourceID == sourceID && item.Phase != phase {
			item.Phase = phase
			patches = append(patches, ItemPatch{ItemID: item.ID, Phase: phase})
		}
	}
	if len(patches) > 0 {
		r.emitItemLocked(Event{Type: "item_updated", Patches: patches})
	}
	if text == "" {
		return nil
	}
	index := len(r.snapshot.Items) - 1
	if index < 0 || r.snapshot.Items[index].Kind != "text" || r.snapshot.Items[index].RoundID != roundID || r.snapshot.Items[index].SourceID != sourceID || r.snapshot.Items[index].State != "streaming" {
		index = r.startItemLocked(Item{Kind: "text", SourceID: sourceID, RoundID: roundID, Phase: phase, State: "streaming"})
	}
	r.appendDeltaLocked(index, text)
	return nil
}

func (r *Run) AppendReasoning(roundID string, delta agent.ReasoningPart) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	if roundID == "" || delta.ID == "" || (delta.Kind != "reasoning" && delta.Kind != "summary") {
		return errors.New("invalid reasoning part")
	}
	index := -1
	// A completion names all occurrences of a provider reasoning part. New text
	// after another public item gets its own chronological occurrence.
	if delta.Text != "" {
		index = len(r.snapshot.Items) - 1
		if index < 0 || r.snapshot.Items[index].Kind != "reasoning" || r.snapshot.Items[index].RoundID != roundID || r.snapshot.Items[index].SourceID != delta.ID || r.snapshot.Items[index].State != "streaming" {
			index = r.startItemLocked(Item{Kind: "reasoning", SourceID: delta.ID, RoundID: roundID, ReasoningKind: delta.Kind, State: "streaming"})
		}
		r.appendDeltaLocked(index, delta.Text)
	}
	if delta.Done {
		var patches []ItemPatch
		for i := range r.snapshot.Items {
			item := &r.snapshot.Items[i]
			if item.Kind == "reasoning" && item.RoundID == roundID && item.SourceID == delta.ID && item.State == "streaming" {
				item.State = "completed"
				patches = append(patches, ItemPatch{ItemID: item.ID, State: item.State})
			}
		}
		if len(patches) > 0 {
			r.emitItemLocked(Event{Type: "item_updated", Patches: patches})
		}
	}
	return nil
}

func (r *Run) EndRound(roundID string, final bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) || r.ctx.Err() != nil {
		return context.Canceled
	}
	var patches []ItemPatch
	for i := range r.snapshot.Items {
		item := &r.snapshot.Items[i]
		if item.RoundID != roundID || item.Kind == "tool" {
			continue
		}
		patch := ItemPatch{ItemID: item.ID}
		if item.Kind == "text" && item.Phase != "commentary" {
			phase := "commentary"
			if final {
				phase = "final"
			}
			if item.Phase != phase {
				item.Phase = phase
				patch.Phase = phase
			}
		}
		if item.State == "streaming" {
			item.State = "completed"
			patch.State = item.State
		}
		if patch.State != "" || patch.Phase != "" {
			patches = append(patches, patch)
		}
	}
	if len(patches) > 0 {
		r.emitItemLocked(Event{Type: "item_updated", Patches: patches})
	}
	return nil
}

func (r *Run) UpdateStep(roundID string, step Step) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if IsTerminal(r.snapshot.Status) {
		return context.Canceled
	}
	index := -1
	for i, item := range r.snapshot.Items {
		if item.Kind == "tool" && item.RoundID == roundID && item.SourceID == step.ID {
			index = i
			break
		}
	}
	if r.ctx.Err() != nil && (index < 0 || r.snapshot.Items[index].Step.Status != "running" || step.Status == "running") {
		return context.Canceled
	}
	if roundID == "" || step.ID == "" {
		return errors.New("tool requires round and source identity")
	}
	step = cloneStep(step)
	state := "streaming"
	if step.Status != "running" {
		state = "completed"
	}
	if index < 0 {
		r.startItemLocked(Item{Kind: "tool", SourceID: step.ID, RoundID: roundID, State: state, Step: &step})
	} else {
		r.snapshot.Items[index].Step, r.snapshot.Items[index].State = &step, state
		r.emitItemLocked(Event{Type: "item_updated", Patches: []ItemPatch{{ItemID: r.snapshot.Items[index].ID, State: state, Step: &step}}})
	}
	return nil
}

func cloneItem(item Item) Item {
	if item.text != nil {
		item.Text = item.text.String()
		item.text = nil
	}
	if item.Step != nil {
		step := cloneStep(*item.Step)
		item.Step = &step
	}
	return item
}
func cloneItems(items []Item) []Item {
	result := make([]Item, len(items))
	for i, item := range items {
		result[i] = cloneItem(item)
	}
	return result
}
func clonePatches(patches []ItemPatch) []ItemPatch {
	result := append([]ItemPatch(nil), patches...)
	for i := range result {
		if result[i].Step != nil {
			step := cloneStep(*result[i].Step)
			result[i].Step = &step
		}
	}
	return result
}
func closeItems(snapshot *Snapshot) []ItemPatch {
	var patches []ItemPatch
	for i := range snapshot.Items {
		item := &snapshot.Items[i]
		if item.State != "streaming" {
			continue
		}
		item.State = "interrupted"
		patch := ItemPatch{ItemID: item.ID, State: item.State}
		if item.Step != nil && item.Step.Status == "running" {
			item.Step.Status = "failed"
			item.Step.Outcome = "failure"
			patch.Step = item.Step
		}
		patches = append(patches, patch)
	}
	return patches
}
func ReconcileTerminal(snapshot Snapshot) Snapshot {
	snapshot = cloneSnapshot(snapshot)
	if IsTerminal(snapshot.Status) {
		closeItems(&snapshot)
		snapshot.WaitingInput = nil
		snapshot.Resource = ""
		snapshot.ComputerGranted = false
	}
	return snapshot
}

func (s Snapshot) Steps() []Step {
	steps := []Step{}
	for _, item := range s.Items {
		if item.Kind == "tool" && item.Step != nil {
			step := cloneStep(*item.Step)
			// Evidence references an occurrence, not a provider call ID that may
			// be reused in another round. The original remains on SourceID.
			step.ID = item.ID
			steps = append(steps, step)
		}
	}
	return steps
}

// PublicReply is a pure history projection. Identity joins fragments exactly,
// including code/math split by intervening reasoning; it never compares content.
func PublicReply(snapshot Snapshot) string {
	finalOnly := snapshot.Status == StatusCompleted
	hasFinal := false
	for _, item := range snapshot.Items {
		if item.Kind == "text" && item.Phase == "final" && strings.TrimSpace(item.Text) != "" {
			hasFinal = true
		}
	}
	type block struct{ source, round, text string }
	var blocks []block
	for _, item := range snapshot.Items {
		if item.Kind != "text" || (finalOnly && hasFinal && item.Phase != "final") {
			continue
		}
		if len(blocks) > 0 && blocks[len(blocks)-1].source == item.SourceID && blocks[len(blocks)-1].round == item.RoundID {
			blocks[len(blocks)-1].text += item.Text
		} else {
			blocks = append(blocks, block{item.SourceID, item.RoundID, item.Text})
		}
	}
	var text []string
	for _, b := range blocks {
		if strings.TrimSpace(b.text) != "" {
			text = append(text, b.text)
		}
	}
	return strings.Join(text, "\n\n")
}
