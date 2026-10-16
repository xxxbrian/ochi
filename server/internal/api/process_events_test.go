package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func TestProcessSSEUpsertKeepsTransportSequenceAndOccurrenceOrder(t *testing.T) {
	m := runtime.NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	r := m.Restore(runtime.Snapshot{RunID: "process", SessionID: "session", Status: runtime.StatusRunning, Timeline: []runtime.ProcessEntry{}})
	_, events, stop := r.Subscribe()
	defer stop()
	_ = r.Append("I will search.")
	text := <-events
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "round-1:reasoning", Kind: "reasoning", Text: "Choose query"})
	thought := <-events
	_ = r.ResetOutput()
	reset := <-events
	if reset.Seq != thought.Seq+1 || len(reset.Timeline) != 2 || reset.Timeline[0].Seq != text.Seq {
		t.Fatal("classification must not assign progress to the later reset seq")
	}
	w := httptest.NewRecorder()
	if err := writeSSE(w, reset.Type, reset.Seq, reset); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(w.Body.String(), "\n")
	if lines[0] != "id: 3" || lines[1] != "event: output_reset" || !strings.HasPrefix(lines[2], "data: ") {
		t.Fatalf("SSE envelope missing original sequence/type: %s", w.Body.String())
	}
	var payload runtime.Event
	if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[2], "data: ")), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Timeline[0].Kind != "progress" || payload.Timeline[1].Reasoning.Text != "Choose query" || payload.Seq != 3 {
		t.Fatal("SSE did not preserve the authoritative mixed order")
	}
}
