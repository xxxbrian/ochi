package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"ochi/server/internal/runtime"
	"strings"
	"testing"
)

func TestProcessSSEDeltaHasIdentityAndNoAccumulatedContent(t *testing.T) {
	m := runtime.NewManager()
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) })
	r := m.Restore(runtime.Snapshot{RunID: "process", SessionID: "session", Status: runtime.StatusRunning})
	_, events, stop := r.Subscribe()
	defer stop()
	_ = r.AppendText("r1", "provider-id", "First ", "pending")
	started := <-events
	_ = <-events
	_ = r.AppendText("r1", "provider-id", "second", "pending")
	delta := <-events
	w := httptest.NewRecorder()
	if err := writeSSE(w, delta.Type, delta.Seq, delta); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(w.Body.String(), "\n")
	if lines[0] != fmt.Sprintf("id: %d", delta.Seq) || lines[1] != "event: item_delta" {
		t.Fatal("bad SSE envelope")
	}
	var payload runtime.Event
	if e := json.Unmarshal([]byte(strings.TrimPrefix(lines[2], "data: ")), &payload); e != nil {
		t.Fatal(e)
	}
	if payload.ItemID != started.Item.ID || payload.Delta != "second" || strings.Contains(w.Body.String(), "First") {
		t.Fatal("SSE resent accumulated text or lost item identity")
	}
	_ = r.EndRound("r1", true)
	phase := <-events
	if phase.Type != "item_updated" || phase.Patches[0].ItemID != started.Item.ID || phase.Patches[0].Phase != "final" {
		t.Fatal("classification changed identity")
	}
}
