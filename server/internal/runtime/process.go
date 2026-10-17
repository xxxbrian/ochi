package runtime

import (
	"strconv"
	"strings"

	"ochi/server/internal/agent"
)

// ProcessEntry is a renderable occurrence, not a provider transcript message.
// Seq is fixed at first appearance; status/text updates retain that position.
type ProcessEntry struct {
	ID        string               `json:"id"`
	Seq       uint64               `json:"seq"`
	Kind      string               `json:"kind"`
	Reasoning *agent.ReasoningPart `json:"reasoning,omitempty"`
	Text      string               `json:"text,omitempty"`
	Pending   bool                 `json:"pending,omitempty"`
	Final     bool                 `json:"final,omitempty"`
	Step      *Step                `json:"step,omitempty"`
}

func (r *Run) appendPublicLocked(id, text string) ProcessEntry {
	if r.publicOpen && r.publicSource == id && len(r.snapshot.Timeline) > 0 {
		last := r.snapshot.Timeline[len(r.snapshot.Timeline)-1]
		if last.Kind == "progress" {
			last.Text += text
			return last
		}
	}
	key := "progress:" + id
	if id == "" {
		key += strconv.FormatUint(r.snapshot.Seq, 10)
	} else {
		occurrences := 0
		for _, entry := range r.snapshot.Timeline {
			if publicSourceMatches(entry.ID, key) {
				occurrences++
			}
		}
		if occurrences > 0 {
			key += ":segment-" + strconv.Itoa(occurrences+1)
		}
	}
	r.publicOpen, r.publicSource = true, id
	return ProcessEntry{ID: key, Seq: r.snapshot.Seq, Kind: "progress", Text: text}
}

func publicSourceMatches(entryID, key string) bool {
	return entryID == key || strings.HasPrefix(entryID, key+":segment-")
}

func (r *Run) upsertProcessLocked(entry ProcessEntry) *ProcessEntry {
	entry = cloneProcessEntry(entry)
	for i, existing := range r.snapshot.Timeline {
		if existing.ID == entry.ID {
			entry.Seq = existing.Seq
			r.snapshot.Timeline[i] = entry
			return &entry
		}
	}
	// Provider-declared final text can still become a preamble at a later
	// boundary. Preserve its original occurrence, never the classification time.
	index := len(r.snapshot.Timeline)
	for i, existing := range r.snapshot.Timeline {
		if entry.Seq < existing.Seq {
			index = i
			break
		}
	}
	r.snapshot.Timeline = append(r.snapshot.Timeline, ProcessEntry{})
	copy(r.snapshot.Timeline[index+1:], r.snapshot.Timeline[index:])
	r.snapshot.Timeline[index] = entry
	return &entry
}

func cloneProcessEntry(entry ProcessEntry) ProcessEntry {
	if entry.Reasoning != nil {
		part := *entry.Reasoning
		entry.Reasoning = &part
	}
	if entry.Step != nil {
		step := cloneStep(*entry.Step)
		entry.Step = &step
	}
	return entry
}

func cloneTimeline(items []ProcessEntry) []ProcessEntry {
	copy := make([]ProcessEntry, len(items))
	for i, item := range items {
		copy[i] = cloneProcessEntry(item)
	}
	return copy
}

func processEntry(items []ProcessEntry, id string) *ProcessEntry {
	for _, item := range items {
		if item.ID == id {
			copy := cloneProcessEntry(item)
			return &copy
		}
	}
	return nil
}

func reconcileTimeline(snapshot *Snapshot) {
	for i := range snapshot.Timeline {
		entry := &snapshot.Timeline[i]
		switch entry.Kind {
		case "reasoning":
			if entry.Reasoning == nil {
				continue
			}
			for _, part := range snapshot.Reasoning {
				if part.ID == entry.Reasoning.ID {
					copy := part
					entry.Reasoning = &copy
					break
				}
			}
			entry.Reasoning.Done = true
		case "tool":
			if entry.Step == nil {
				continue
			}
			for _, step := range snapshot.Steps {
				if step.ID == entry.Step.ID {
					copy := cloneStep(step)
					entry.Step = &copy
					break
				}
			}
			if entry.Step.Status == "running" {
				entry.Step.Status = "failed"
			}
		}
	}
}

// ReconcileTerminal closes activity in an interrupted database checkpoint.
// Restart never resumes a model; saved entries keep their IDs/order and public
// text, but cannot claim that unfinished tools are still running or succeeded.
func ReconcileTerminal(snapshot Snapshot) Snapshot {
	snapshot = cloneSnapshot(snapshot)
	if !IsTerminal(snapshot.Status) {
		return snapshot
	}
	for i := range snapshot.Steps {
		if snapshot.Steps[i].Status == "running" {
			snapshot.Steps[i].Status = "failed"
		}
	}
	for i := range snapshot.Reasoning {
		snapshot.Reasoning[i].Done = true
	}
	reconcileTimeline(&snapshot)
	snapshot.WaitingInput = nil
	snapshot.Resource = ""
	snapshot.ComputerGranted = false
	return snapshot
}

func hasPublicText(entry ProcessEntry) bool { return strings.TrimSpace(entry.Text) != "" }

// PublicReply is the history projection, not the provider's final-answer buffer.
// An interrupted turn keeps everything it already told the user visible; only
// a completed turn with an answer replaces its interim public updates.
func PublicReply(snapshot Snapshot) string {
	if !IsTerminal(snapshot.Status) {
		return snapshot.Output
	}
	if snapshot.Status == StatusCompleted && strings.TrimSpace(snapshot.Output) != "" {
		return snapshot.Output
	}
	var public []ProcessEntry
	var candidates strings.Builder
	for _, entry := range snapshot.Timeline {
		if entry.Kind != "progress" {
			continue
		}
		public = append(public, entry)
		if entry.Pending || entry.Final {
			candidates.WriteString(entry.Text)
		}
	}
	output := strings.TrimSpace(snapshot.Output)
	candidatesMatch := output != "" && strings.TrimSpace(candidates.String()) == output
	type publicBlock struct {
		id, text  string
		candidate bool
	}
	var blocks []publicBlock
	for _, entry := range public {
		candidate := entry.Pending || entry.Final
		if len(blocks) > 0 {
			last := &blocks[len(blocks)-1]
			// A reasoning occurrence can split one public message in the
			// middle of math/code. Its fragments must retain their exact bytes.
			if (last.id != "" && publicSourceMatches(entry.ID, last.id)) || (candidatesMatch && last.candidate && candidate) {
				last.text += entry.Text
				last.candidate = last.candidate && candidate
				continue
			}
		}
		blocks = append(blocks, publicBlock{id: entry.ID, text: entry.Text, candidate: candidate})
	}
	var paragraphs []string
	for _, block := range blocks {
		if strings.TrimSpace(block.text) != "" {
			paragraphs = append(paragraphs, block.text)
		}
	}
	represented := candidatesMatch
	suffix := ""
	for i := len(public) - 1; i >= 0 && !represented; i-- {
		suffix = public[i].Text + suffix
		represented = strings.TrimSpace(suffix) == output
	}
	// The output can span multiple public occurrences. Compare the full buffer,
	// not individual rows, so interleaved reasoning cannot duplicate its text.
	if output != "" && !represented {
		paragraphs = append(paragraphs, snapshot.Output)
	}
	return strings.Join(paragraphs, "\n\n")
}
