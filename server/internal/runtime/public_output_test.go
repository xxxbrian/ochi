package runtime

import (
	"encoding/json"
	"testing"

	"ochi/server/internal/agent"
)

func TestPublicReplyStreamsInPlaceThroughRoundClassification(t *testing.T) {
	r := processRun(t)
	_, events, stop := r.Subscribe()
	defer stop()
	_ = r.AppendText("", "Checking ", true)
	first := <-events
	_ = r.AppendText("", "sources.", true)
	second := <-events
	if first.TimelineEntry == nil || !first.TimelineEntry.Pending || second.TimelineEntry.Text != "Checking sources." || second.TimelineEntry.Seq != first.Seq {
		t.Fatal("unclassified text did not stream into its stable pending occurrence")
	}
	if first.UpdatedAt.IsZero() || second.UpdatedAt.Before(first.UpdatedAt) {
		t.Fatal("event did not carry the authoritative run timestamp")
	}
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "next", Kind: "reasoning", Text: "Pick a query."})
	<-events
	_ = r.ResetOutput()
	reset := <-events
	if r.Snapshot().Output != "" || reset.Timeline[0].Pending || reset.Timeline[0].Seq != first.Seq || reset.Timeline[1].Kind != "reasoning" {
		t.Fatal("tool boundary lost or moved the preamble")
	}
	_ = r.UpdateStep(Step{ID: "search", Name: "web_search", Status: "completed"})
	<-events
	_ = r.AppendText("answer", "The answer.", true)
	<-events
	before, _, unsubscribe := r.Subscribe()
	unsubscribe()
	if len(before.Timeline) != 4 || !before.Timeline[3].Pending {
		t.Fatal("reconnect did not retain pending presentation")
	}
	_ = r.CommitOutput()
	commit := <-events
	if commit.Type != "output_commit" || commit.Text != "The answer." || len(commit.Timeline) != 4 || !commit.Timeline[3].Final || commit.Timeline[3].Pending ||
		commit.Timeline[3].ID != before.Timeline[3].ID || commit.Timeline[3].Seq != before.Timeline[3].Seq {
		t.Fatal("final boundary replaced or moved the streamed answer")
	}
}

func TestAnswerOnlyCommitRetainsStablePublicBlock(t *testing.T) {
	r := processRun(t)
	_, events, stop := r.Subscribe()
	defer stop()
	_ = r.AppendText("answer", "Hello", true)
	first := <-events
	_ = r.CommitOutput()
	commit := <-events
	data, _ := json.Marshal(commit)
	var wire Event
	_ = json.Unmarshal(data, &wire)
	if wire.Type != "output_commit" || wire.Text != "Hello" || len(wire.Timeline) != 1 || !wire.Timeline[0].Final || wire.Timeline[0].Pending ||
		wire.Timeline[0].ID != first.TimelineEntry.ID || wire.Timeline[0].Text != first.TimelineEntry.Text {
		t.Fatal("answer-only commit did not preserve the visible public block")
	}
}

func TestLateCommentaryRemovesOnlyMatchingAnswerSegment(t *testing.T) {
	for _, pending := range []bool{false, true} {
		r := processRun(t)
		_ = r.AppendText("commentary", "Same bytes. ", pending)
		firstSeq := r.Snapshot().Seq
		_ = r.AppendText("answer", "Same bytes. ", pending)
		_ = r.AppendProgress("commentary", "")
		classified := r.Snapshot()
		if classified.Output != "Same bytes. " || classified.Timeline[0].Text != "Same bytes. " || classified.Timeline[0].Pending || classified.Timeline[0].Seq != firstSeq {
			t.Fatal("late phase removed unrelated bytes or moved the commentary")
		}
		_ = r.AppendProgress("commentary", "More progress.")
		_ = r.AppendText("answer", "Answer.", pending)
		_ = r.CommitOutput()
		final := r.Snapshot()
		if final.Output != "Same bytes. Answer." || len(final.Timeline) != 4 || final.Timeline[0].Text != "Same bytes. " || final.Timeline[0].Final ||
			final.Timeline[2].Text != "More progress." || final.Timeline[2].Final || !final.Timeline[1].Final || !final.Timeline[3].Final {
			t.Fatal("late classification duplicated commentary in the final answer")
		}
	}
}

func TestFailedPendingReplyRemainsReadableWithoutBecomingFinal(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("partial", "Checking incomplete sources", true)
	if err := r.Finalize(StatusFailed, "upstream lost", func(snapshot Snapshot) error {
		if len(snapshot.Timeline) != 1 || !snapshot.Timeline[0].Pending || snapshot.Timeline[0].Text != snapshot.Output {
			t.Fatal("failure discarded unconfirmed text or marked it final")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.CommitOutput(); err == nil {
		t.Fatal("a failed run must not later promote its text")
	}
}

func TestInterleavedProviderTextKeepsOccurrencesAndLatePhase(t *testing.T) {
	r := processRun(t)
	_, events, stop := r.Subscribe()
	defer stop()
	_ = r.AppendText("message", "First ", true)
	first := <-events
	_ = r.AppendText("message", "sentence.", true)
	second := <-events
	if second.TimelineEntry.ID != first.TimelineEntry.ID || second.TimelineEntry.Text != "First sentence." {
		t.Fatal("contiguous provider chunks did not share one stable block")
	}
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "inspect", Kind: "summary", Text: "Inspect code.", Done: true})
	<-events
	_ = r.AppendText("message", "Verify this.", true)
	next := <-events
	if next.TimelineEntry.ID == first.TimelineEntry.ID || next.TimelineEntry.Seq <= first.TimelineEntry.Seq {
		t.Fatal("provider item merged across an intervening reasoning occurrence")
	}
	_ = r.AppendProgress("message", "")
	phase := <-events
	if len(phase.Timeline) != 3 || phase.Timeline[0].Pending || phase.Timeline[2].Pending || phase.Timeline[0].Final || phase.Timeline[2].Final || phase.Text != "" {
		t.Fatal("late commentary did not reclassify all occurrences atomically")
	}
	_ = r.AppendProgress("message", " Still checking.")
	<-events
	_ = r.ResetOutput()
	<-events
	_ = r.AppendText("answer-1", "Final one. ", false)
	<-events
	_ = r.AppendText("answer-2", "Final two.", true)
	<-events
	_ = r.CommitOutput()
	commit := <-events
	if commit.Text != "Final one. Final two." || len(commit.Timeline) != 5 || !commit.Timeline[3].Final || !commit.Timeline[4].Final || commit.Timeline[4].Pending ||
		commit.Timeline[2].Text != "Verify this. Still checking." || commit.Timeline[0].Seq != first.Seq {
		t.Fatal("multiple final items lost content, identity, or chronological commentary")
	}
}

func TestDeclaredFinalBecomesProgressWithoutDisappearing(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("early-final", "Conclusion; let me verify.", false)
	before := r.Snapshot().Timeline[0]
	_ = r.ResetOutput()
	after := r.Snapshot().Timeline[0]
	if !before.Final || after.Final || after.Pending || after.ID != before.ID || after.Text != before.Text || after.Seq != before.Seq {
		t.Fatal("a subsequent round moved, removed, or kept final status on public text")
	}
}
