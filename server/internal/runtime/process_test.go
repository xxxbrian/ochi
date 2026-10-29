package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"

	"ochi/server/internal/agent"
)

func processRun(t *testing.T) *Run {
	t.Helper()
	m := NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	return m.Restore(Snapshot{RunID: "process", SessionID: "session", Status: StatusRunning})
}
func applyItemEvent(t *testing.T, s *Snapshot, e Event) {
	t.Helper()
	if e.Seq != s.Seq+1 {
		t.Fatalf("gap %d -> %d", s.Seq, e.Seq)
	}
	s.Seq = e.Seq
	s.UpdatedAt = e.UpdatedAt
	switch e.Type {
	case "item_started":
		s.Items = append(s.Items, cloneItem(*e.Item))
	case "item_delta":
		for i := range s.Items {
			if s.Items[i].ID == e.ItemID {
				s.Items[i].Text += e.Delta
			}
		}
	case "item_updated":
		for _, p := range e.Patches {
			for i := range s.Items {
				item := &s.Items[i]
				if item.ID == p.ItemID {
					if p.Phase != "" {
						item.Phase = p.Phase
					}
					if p.State != "" {
						item.State = p.State
					}
					if p.Step != nil {
						copy := cloneStep(*p.Step)
						item.Step = &copy
					}
				}
			}
		}
	case "status":
		s.Status = e.Status
		s.Error = e.Error
		s.ErrorCode = e.ErrorCode
	}
}
func TestItemEventsExactlyReconstructSnapshot(t *testing.T) {
	r := processRun(t)
	snapshot, events, stop := r.Subscribe()
	defer stop()
	actions := []func() error{
		func() error {
			return r.AppendReasoning("r1", agent.ReasoningPart{ID: "thought", Kind: "summary", Text: "Check ", Done: false})
		},
		func() error { return r.AppendText("r1", "text", "Let me check.", "pending") },
		func() error {
			return r.AppendReasoning("r1", agent.ReasoningPart{ID: "thought", Kind: "summary", Text: "the source.", Done: true})
		},
		func() error { return r.EndRound("r1", false) },
		func() error { return r.UpdateStep("r1", Step{ID: "search", Name: "web_search", Status: "running"}) },
		func() error {
			return r.UpdateStep("r1", Step{ID: "search", Name: "web_search", Status: "completed", Outcome: "needs_user", Output: "Verification required"})
		},
		func() error { return r.AppendText("r2", "answer", "Result.", "pending") },
		func() error { return r.EndRound("r2", true) },
		func() error { return r.Finalize(StatusCompleted, nil, func(Snapshot) error { return nil }) },
	}
	for _, action := range actions {
		if err := action(); err != nil {
			t.Fatal(err)
		}
		for len(events) > 0 {
			applyItemEvent(t, &snapshot, <-events)
		}
	}
	actual := r.Snapshot()
	if !reflect.DeepEqual(snapshot.Items, actual.Items) || snapshot.Seq != actual.Seq || snapshot.Status != actual.Status {
		t.Fatalf("snapshot diverged: %+v %+v", snapshot, actual)
	}
	for i, item := range actual.Items {
		if i > 0 && item.Seq <= actual.Items[i-1].Seq {
			t.Fatal("occurrence order not stable")
		}
	}
	if PublicReply(actual) != "Result." {
		t.Fatal("final phase projection wrong")
	}
}
func TestItemSnapshotsAndSubscribersAreIsolated(t *testing.T) {
	r := processRun(t)
	_, a, stopA := r.Subscribe()
	_, b, stopB := r.Subscribe()
	defer stopA()
	defer stopB()
	args := json.RawMessage(`{"path":"file"}`)
	_ = r.UpdateStep("r", Step{ID: "read", Name: "files_read", Status: "running", Arguments: args})
	args[0] = '['
	one, two := <-a, <-b
	one.Item.Step.Name = "mutated"
	one.Item.Step.Arguments[0] = '['
	if two.Item.Step.Name != "files_read" || string(two.Item.Step.Arguments) != `{"path":"file"}` {
		t.Fatal("event aliases")
	}
	snap := r.Snapshot()
	snap.Items[0].Step.Name = "mutated"
	_ = r.Finalize(StatusFailed, errors.New("failed"), func(s Snapshot) error {
		if s.Items[0].Step.Status != "failed" {
			t.Fatal("unfinished tool left active")
		}
		s.Items[0].Step.Name = "mutated"
		return nil
	})
	repair := <-a
	repair.Patches[0].Step.Name = "mutation"
	if r.Snapshot().Items[0].Step.Name != "files_read" {
		t.Fatal("snapshot/patch alias")
	}
}
func TestTerminalItemRoundTripAndEmptyArray(t *testing.T) {
	r := processRun(t)
	_ = r.AppendText("r", "p", "Public partial", "pending")
	_ = r.UpdateStep("r", Step{ID: "read", Status: "running"})
	_ = r.AppendReasoning("r", agent.ReasoningPart{ID: "reason", Kind: "reasoning", Text: "Partial thought"})
	s := r.Snapshot()
	s.Status = StatusInterrupted
	data, _ := json.Marshal(s)
	var decoded Snapshot
	_ = json.Unmarshal(data, &decoded)
	restored := ReconcileTerminal(decoded)
	if restored.Items[1].Step.Status != "failed" || restored.Items[2].State != "interrupted" || PublicReply(restored) != "Public partial" || s.Items[1].Step.Status != "running" {
		t.Fatal("restoration changed public text or kept active work")
	}
	empty := ReconcileTerminal(Snapshot{Status: StatusCompleted})
	data, _ = json.Marshal(empty)
	var payload map[string]any
	_ = json.Unmarshal(data, &payload)
	if value, present := payload["items"]; !present || value == nil || len(value.([]any)) != 0 {
		t.Fatal("items must be []")
	}
	for _, key := range []string{"output", "reasoning", "steps", "timeline"} {
		if _, exists := payload[key]; exists {
			t.Fatal("parallel public owner leaked", key)
		}
	}
}
func TestCancelAndSnapshotRacePreservesActualToolCompletion(t *testing.T) {
	r := processRun(t)
	_ = r.UpdateStep("r", Step{ID: "read", Name: "read", Status: "running"})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			s := r.Snapshot()
			s.Items[0].Step.Name = "mutation"
		}
	}()
	go func() {
		defer wg.Done()
		r.Cancel()
		if e := r.UpdateStep("r", Step{ID: "read", Name: "read", Status: "completed", Outcome: "success"}); e != nil {
			t.Error(e)
		}
		_ = r.Finalize(StatusCompleted, nil, func(Snapshot) error { return nil })
	}()
	wg.Wait()
	s := r.Snapshot()
	if s.Status != StatusCancelled || s.Items[0].Step.Status != "completed" || s.Items[0].Seq != 1 {
		t.Fatal("lost real result during cancellation")
	}
}

func TestReusedProviderToolIDInAnotherRoundKeepsBothOccurrences(t *testing.T) {
	r := processRun(t)
	snapshot, events, stop := r.Subscribe()
	defer stop()
	for _, round := range []string{"r1", "r2"} {
		for _, status := range []string{"running", "completed"} {
			if err := r.UpdateStep(round, Step{ID: "call-0", Name: "exec", Status: status, Output: round}); err != nil {
				t.Fatal(err)
			}
			for len(events) > 0 {
				applyItemEvent(t, &snapshot, <-events)
			}
		}
	}
	final := r.Snapshot()
	if len(final.Items) != 2 || final.Items[0].ID == final.Items[1].ID || final.Items[0].Step.Output != "r1" || final.Items[1].Step.Output != "r2" || !reflect.DeepEqual(snapshot.Items, final.Items) {
		t.Fatal("reused provider tool ID overwrote another round")
	}
	steps := final.Steps()
	for index, step := range steps {
		if step.ID != final.Items[index].ID || final.Items[index].SourceID != "call-0" || final.Items[index].Step.ID != "call-0" {
			t.Fatal("evidence lost occurrence identity or changed the provider call ID")
		}
	}
}
