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

func TestHistoryPublicReplyKeepsInterruptedProseWithoutExposingPrivateWork(t *testing.T) {
	timeline := []ProcessEntry{
		{ID: "public-1", Kind: "progress", Text: "I checked the first result."},
		{ID: "reasoning", Kind: "reasoning", Reasoning: &agent.ReasoningPart{Text: "Private reasoning"}},
		{ID: "tool", Kind: "tool", Step: &Step{Output: "Raw tool output"}},
		{ID: "blank", Kind: "progress", Text: "\n\n", Pending: true},
		{ID: "public-2", Kind: "progress", Text: "First ", Pending: true},
		{ID: "public-3", Kind: "progress", Text: "second", Pending: true},
	}
	for _, status := range []string{StatusFailed, StatusCancelled, StatusInterrupted} {
		snapshot := Snapshot{Status: status, Output: "First second", Timeline: timeline}
		if got := PublicReply(snapshot); got != "I checked the first result.\n\n\n\nFirst second" {
			t.Fatalf("%s lost or duplicated public prose: %q", status, got)
		}
		if snapshot.Output != "First second" || !snapshot.Timeline[3].Pending || snapshot.Timeline[4].Final {
			t.Fatal("history projection mutated the provider buffer or classified partial output as final")
		}
	}
}

func TestHistoryPublicReplyPreservesMathAndCodeAcrossReasoning(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("math", "$E = ", true)
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "thought-1", Kind: "reasoning", Text: "Private calculation"})
	_ = r.AppendText("math", "mc^2$", true)
	_ = r.ResetOutput()
	_ = r.AppendText("code", "    first()\n", true)
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "thought-2", Kind: "reasoning", Text: "Private check"})
	_ = r.AppendText("code", "    second()\n", true)
	if err := r.Finalize(StatusFailed, "stream failed", func(snapshot Snapshot) error {
		if got := PublicReply(snapshot); got != "$E = mc^2$\n\n    first()\n    second()\n" {
			t.Fatalf("history projection corrupted Markdown fragments: %q", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryPublicReplyPrefersCompletedAnswerAndPreservesProgressOnlyTurns(t *testing.T) {
	timeline := []ProcessEntry{
		{Kind: "progress", Text: "A useful intermediate result."},
		{Kind: "progress", Text: "\n", Pending: true},
		{Kind: "progress", Text: "The answer.", Final: true},
	}
	if got := PublicReply(Snapshot{Status: StatusCompleted, Output: "The answer.", Timeline: timeline}); got != "The answer." {
		t.Fatalf("stray provisional whitespace hid the final answer: %q", got)
	}
	if got := PublicReply(Snapshot{Status: StatusCompleted, Timeline: timeline[:1]}); got != timeline[0].Text {
		t.Fatalf("a turn without a final answer hid all public progress: %q", got)
	}
	if got := PublicReply(Snapshot{Status: StatusFailed, Output: "A partial answer."}); got != "A partial answer." {
		t.Fatalf("output without timeline vanished: %q", got)
	}
	if got := PublicReply(Snapshot{Status: StatusFailed, Output: "New partial answer.", Timeline: timeline[:1]}); got != "A useful intermediate result.\n\nNew partial answer." {
		t.Fatalf("unrepresented output vanished: %q", got)
	}
	if got := PublicReply(Snapshot{Status: StatusRunning, Output: "Streaming", Timeline: timeline}); got != "Streaming" {
		t.Fatal("history projection reclassified a live run")
	}
}
