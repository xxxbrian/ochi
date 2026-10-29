package runtime

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"ochi/server/internal/agent"
)

func TestPublicItemsKeepIdentityThroughInterleavingAndClassification(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("r1", "same", "$E = ", "pending")
	first := r.Snapshot().Items[0]
	_ = r.AppendReasoning("r1", agent.ReasoningPart{ID: "reason", Kind: "summary", Text: "Check units.", Done: true})
	_ = r.AppendText("r1", "same", "mc^2$", "pending")
	_ = r.AppendText("r1", "other", "$E = mc^2$", "pending")
	_ = r.AppendText("r1", "same", "", "commentary")
	_ = r.EndRound("r1", true)
	s := r.Snapshot()
	s.Status = StatusCompleted
	if len(s.Items) != 4 || s.Items[0].ID != first.ID || s.Items[0].Seq != first.Seq || s.Items[0].Phase != "commentary" || s.Items[2].Phase != "commentary" || s.Items[3].Phase != "final" {
		t.Fatalf("phase corrupted identity: %+v", s.Items)
	}
	if got := PublicReply(s); got != "$E = mc^2$" {
		t.Fatalf("identity classification lost distinct identical text: %q", got)
	}
	s.Status = StatusInterrupted
	if got := PublicReply(s); got != "$E = mc^2$\n\n$E = mc^2$" {
		t.Fatalf("interleaved Markdown bytes lost: %q", got)
	}
}

func TestInterruptedPublicTextNeverBecomesFinal(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("r1", "preamble", "I checked one source.", "pending")
	_ = r.EndRound("r1", false)
	_ = r.AppendText("r2", "partial", "The partial conclusion", "pending")
	_ = r.AppendReasoning("r2", agent.ReasoningPart{ID: "secret", Kind: "reasoning", Text: "Raw reasoning"})
	err := r.Finalize(StatusFailed, errors.New("stream failed"), func(s Snapshot) error {
		if PublicReply(s) != "I checked one source.\n\nThe partial conclusion" || s.Items[1].State != "interrupted" || s.Items[1].Phase != "pending" {
			t.Fatalf("partial state changed: %+v", s)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.EndRound("r2", true) == nil {
		t.Fatal("late completion accepted")
	}
}

func TestCompletedFallbackRetainsProgressWithoutFinal(t *testing.T) {
	s := Snapshot{Status: StatusCompleted, Items: []Item{{Kind: "text", SourceID: "one", Text: "Useful partial result", Phase: "commentary"}}}
	if PublicReply(s) != "Useful partial result" {
		t.Fatal("progress-only completed run vanished")
	}
}

func TestTextWireCostIsLinearAndNoAccumulatedBodyInEvents(t *testing.T) {
	r := processRun(t)
	_, events, stop := r.Subscribe()
	defer stop()
	const count = 4096
	total := 0
	for i := 0; i < count; i++ {
		if err := r.AppendText("r", "source", strings.Repeat("x", 16), "pending"); err != nil {
			t.Fatal(err)
		}
		n := 1
		if i == 0 {
			n = 2
		}
		for j := 0; j < n; j++ {
			e := <-events
			data, _ := json.Marshal(e)
			total += len(data)
			if e.Type == "item_started" && e.Item.Text != "" {
				t.Fatal("start resent text")
			}
			if e.Type == "item_delta" && len(e.Delta) != 16 {
				t.Fatal("delta is accumulated text")
			}
		}
	}
	if total > count*350 {
		t.Fatalf("event cost not bounded by payload plus envelope: %d", total)
	}
	_ = r.EndRound("r", true)
	e := <-events
	data, _ := json.Marshal(e)
	if len(data) > 400 || e.Patches[0].Phase != "final" {
		t.Fatalf("commit resent body: %d", len(data))
	}
	if len(r.Snapshot().Items[0].Text) != count*16 {
		t.Fatal("snapshot lost text")
	}
	t.Logf("%d text bytes across %d chunks serialize to %d event bytes", count*16, count, total)
}

func TestOversizedProviderChunkUsesBoundedUTF8Deltas(t *testing.T) {
	r := processRun(t)
	_, events, stop := r.Subscribe()
	defer stop()
	text := strings.Repeat("语", 6000)
	if err := r.AppendText("r", "source", text, "pending"); err != nil {
		t.Fatal(err)
	}
	rebuilt := ""
	for len(events) > 0 {
		e := <-events
		if e.Type == "item_delta" {
			if len(e.Delta) > maxItemDeltaBytes || !json.Valid([]byte(`"`+e.Delta+`"`)) {
				t.Fatal("invalid/oversized delta")
			}
			rebuilt += e.Delta
		}
	}
	frozen := r.Snapshot()
	_ = r.AppendText("r", "source", "tail", "pending")
	if rebuilt != text || frozen.Items[0].Text != text || r.Snapshot().Items[0].Text != text+"tail" {
		t.Fatal("buffer alias or chunk corruption")
	}
}
