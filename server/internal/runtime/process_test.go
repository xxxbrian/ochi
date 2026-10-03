package runtime

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"ochi/server/internal/agent"
)

func processRun(t *testing.T) *Run {
	t.Helper()
	m := NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	return m.Restore(Snapshot{RunID: "process", SessionID: "session", Status: StatusRunning, Timeline: []ProcessEntry{}})
}

func TestProcessTimelineMixedOrderStableUpsertsAndReplyBoundary(t *testing.T) {
	r := processRun(t)
	_, events, unsubscribe := r.Subscribe()
	defer unsubscribe()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(r.AppendReasoning(agent.ReasoningPart{ID: "round-1:reasoning", Kind: "reasoning", Text: "Check "}))
	first := <-events
	must(r.AppendReasoning(agent.ReasoningPart{ID: "round-1:reasoning", Kind: "reasoning", Text: "the request.", Done: true}))
	updated := <-events
	if updated.TimelineEntry.Seq != first.Seq || updated.TimelineEntry.Reasoning.Text != "Check the request." || updated.Seq != first.Seq+1 {
		t.Fatalf("delta was not a full stable upsert: %+v", updated)
	}
	must(r.Append("I will "))
	text := <-events
	must(r.Append("search."))
	<-events
	must(r.AppendReasoning(agent.ReasoningPart{ID: "round-1:reasoning:segment-2", Kind: "reasoning", Text: "Choose sources.", Done: true}))
	thought := <-events
	must(r.Append(" Then read them."))
	secondText := <-events
	if before := r.Snapshot(); len(before.Timeline) != 4 || before.Output != "I will search. Then read them." ||
		text.TimelineEntry == nil || text.TimelineEntry.Text != "I will " {
		t.Fatal("public reply did not stream in place from its first token")
	}
	must(r.ResetOutput())
	reset := <-events
	wantKinds := []string{"reasoning", "progress", "reasoning", "progress"}
	kinds := []string{}
	for _, entry := range reset.Timeline {
		kinds = append(kinds, entry.Kind)
	}
	if !reflect.DeepEqual(kinds, wantKinds) || reset.Timeline[1].Seq != text.Seq || reset.Timeline[2].Seq != thought.Seq || reset.Timeline[3].Seq != secondText.Seq || r.Snapshot().Output != "" {
		t.Fatalf("public progress moved to the reset time or was lost: %+v", reset.Timeline)
	}
	if reset.Timeline[1].Text != "I will search." || reset.Timeline[3].Text != " Then read them." || reset.Timeline[1].Reasoning != nil {
		t.Fatal("public progress changed bytes or became private reasoning")
	}
	step := Step{ID: "search", Name: "web_search", Status: "running", Arguments: json.RawMessage(`{"query":"example"}`)}
	must(r.UpdateStep(step))
	started := <-events
	step.Status, step.Output = "completed", "two results"
	must(r.UpdateStep(step))
	completed := <-events
	if completed.TimelineEntry.Seq != started.Seq || completed.TimelineEntry.Step.Status != "completed" || len(r.Snapshot().Timeline) != 5 {
		t.Fatal("tool completion created a second occurrence")
	}
	must(r.AppendReasoning(agent.ReasoningPart{ID: "round-2:summary", Kind: "summary", Text: "Synthesize.", Done: true}))
	<-events
	must(r.Append("Here is the final answer."))
	<-events
	must(r.Finalize(StatusCompleted, "", func(saved Snapshot) error { return nil }))
	terminal := <-events
	final := r.Snapshot()
	if len(final.Timeline) != 7 || final.Output != "Here is the final answer." || !final.Timeline[6].Final || !reflect.DeepEqual(terminal.Timeline, final.Timeline) {
		t.Fatal("terminal event lost the stable final answer or process state")
	}
	for i, entry := range final.Timeline {
		if i > 0 && entry.Seq <= final.Timeline[i-1].Seq {
			t.Fatal("timeline occurrence order is not strictly increasing")
		}
	}
}

func TestProcessSnapshotsAndSubscribersAreIsolated(t *testing.T) {
	r := processRun(t)
	_, a, stopA := r.Subscribe()
	_, b, stopB := r.Subscribe()
	defer stopA()
	defer stopB()
	args := json.RawMessage(`{"path":"file"}`)
	if err := r.UpdateStep(Step{ID: "read", Name: "files_read", Status: "running", Arguments: args}); err != nil {
		t.Fatal(err)
	}
	args[0] = '['
	first, other := <-a, <-b
	first.TimelineEntry.Step.Arguments[0] = '['
	first.TimelineEntry.Step.Name = "mutated"
	if other.TimelineEntry.Step.Name != "files_read" || string(other.TimelineEntry.Step.Arguments) != `{"path":"file"}` {
		t.Fatal("subscriber payloads share writable entry state")
	}
	snapshot := r.Snapshot()
	snapshot.Timeline[0].Step.Status = "completed"
	if r.Snapshot().Timeline[0].Step.Status != "running" {
		t.Fatal("returned snapshot shares writable timeline")
	}
	if err := r.Finalize(StatusFailed, "upstream lost", func(saved Snapshot) error {
		if saved.Timeline[0].Step.Status != "failed" {
			t.Fatal("unfinished tool was not closed before persistence")
		}
		saved.Timeline[0].Step.Name = "persist mutation"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if r.Snapshot().Timeline[0].Step.Name != "files_read" {
		t.Fatal("persistence callback changed live process state")
	}
	<-a // terminal repair step
	terminal := <-a
	terminal.Timeline[0].Step.Name = "terminal mutation"
	if r.Snapshot().Timeline[0].Step.Name != "files_read" {
		t.Fatal("terminal event shares writable timeline")
	}
}

func TestTerminalProcessJSONRoundTripAndEmptyTimeline(t *testing.T) {
	r := processRun(t)
	_ = r.Append("I will read the file.")
	_ = r.ResetOutput()
	_ = r.UpdateStep(Step{ID: "read", Name: "files_read", Status: "running"})
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "round-2:reasoning", Kind: "reasoning", Text: "Partial thought"})
	checkpoint := r.Snapshot()
	checkpoint.Status = StatusInterrupted
	data, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Snapshot
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	restored := m.Restore(decoded).Snapshot()
	if restored.Timeline[0].Text != "I will read the file." || restored.Timeline[1].Step.Status != "failed" || !restored.Timeline[2].Reasoning.Done || restored.Timeline[2].Seq != checkpoint.Timeline[2].Seq {
		t.Fatalf("restart lost public progress/order or left active work: %+v", restored.Timeline)
	}
	if checkpoint.Timeline[1].Step.Status != "running" || checkpoint.Timeline[2].Reasoning.Done {
		t.Fatal("restart normalization mutated the original checkpoint")
	}
	empty := m.Restore(Snapshot{RunID: "empty", Status: StatusCompleted}).Snapshot()
	emptyJSON, _ := json.Marshal(empty)
	var payload map[string]any
	_ = json.Unmarshal(emptyJSON, &payload)
	if value, present := payload["timeline"]; !present || value == nil || len(value.([]any)) != 0 {
		t.Fatal("an empty process must serialize as an array")
	}
	newRun, err := m.Start(Snapshot{RunID: "new", SessionID: "new-session"}, nil)
	if err != nil || newRun.Snapshot().Timeline == nil {
		t.Fatal("new run did not advertise exact timeline support")
	}
}

func TestProcessCancelAndSnapshotRaceKeepsCompletionOrder(t *testing.T) {
	r := processRun(t)
	_ = r.UpdateStep(Step{ID: "read", Name: "files_read", Status: "running"})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			snapshot := r.Snapshot()
			snapshot.Timeline[0].Step.Name = "reader mutation"
		}
	}()
	go func() {
		defer wg.Done()
		r.Cancel()
		if err := r.UpdateStep(Step{ID: "read", Name: "files_read", Status: "completed", Output: "observed before cancellation"}); err != nil {
			t.Error(err)
		}
		if err := r.Finalize(StatusCompleted, "", func(saved Snapshot) error { return nil }); err != nil {
			t.Error(err)
		}
	}()
	wg.Wait()
	final := r.Snapshot()
	if final.Status != StatusCancelled || len(final.Timeline) != 1 || final.Timeline[0].Step.Status != "completed" || final.Timeline[0].Seq != 1 {
		t.Fatalf("cancel moved/dropped the in-flight result: %+v", final)
	}
}
