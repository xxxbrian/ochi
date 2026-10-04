package storage

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHistoricalMessageRetainsRunStatusWithoutToolsOrThoughts(t *testing.T) {
	for _, status := range []string{"completed", "failed", "cancelled", "interrupted"} {
		data, err := json.Marshal(Message{Role: "assistant", RunStatus: status})
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		_ = json.Unmarshal(data, &payload)
		if payload["run_status"] != status || payload["step_count"] != float64(0) || payload["has_reasoning"] != false {
			t.Fatalf("historical message lost its own outcome: %s", data)
		}
	}
}

func TestEndedTurnClosesOnlyStoppedOutcomes(t *testing.T) {
	for _, status := range []string{"cancelled", "failed", "interrupted"} {
		message := endedTurnMessage(status)
		if !strings.Contains(message, "不再自动执行") || !strings.Contains(message, "用户最新消息") || !strings.Contains(message, "明确要求继续") {
			t.Fatalf("%s did not close the old task: %s", status, message)
		}
	}
	for _, status := range []string{"", "completed", "running", "waiting_user", "queued"} {
		if endedTurnMessage(status) != "" {
			t.Fatalf("%s incorrectly closed the task", status)
		}
	}
}
