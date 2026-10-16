package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

func TestPromptInspectionExactSmallInputAndExplicitRedaction(t *testing.T) {
	body := json.RawMessage(`{"model":"same","messages":[{"role":"user","content":"actual input"}]}`)
	sum := sha256.Sum256(body)
	v := boundedInspection(agent.ContextInspection{Request: body, SHA256: hex.EncodeToString(sum[:])})
	if v.Redacted || v.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("bounded ordinary request lost exactness metadata")
	}
	var actual, expected any
	_ = json.Unmarshal(v.Request, &actual)
	_ = json.Unmarshal(body, &expected)
	a, _ := json.Marshal(actual)
	b, _ := json.Marshal(expected)
	if string(a) != string(b) {
		t.Fatal("small model input was altered")
	}
	for _, large := range []string{"data:image/png;base64,PRIVATE_BINARY", strings.Repeat("large input ", 7000)} {
		body, _ = json.Marshal(map[string]any{"messages": []any{map[string]any{"content": large}}})
		v = boundedInspection(agent.ContextInspection{Request: body, SHA256: "exact-original-sha"})
		if !v.Redacted || v.SHA256 != "exact-original-sha" || strings.Contains(string(v.Request), large) || !strings.Contains(string(v.Request), `"bytes"`) || !strings.Contains(string(v.Request), `"sha256"`) {
			t.Fatal("large/binary input not explicitly redacted")
		}
	}
	if !boundedInspection(agent.ContextInspection{Request: json.RawMessage(`not-json`)}).Redacted {
		t.Fatal("invalid inspection masqueraded as exact")
	}
}

func TestClientTimezoneValidationAndContext(t *testing.T) {
	for _, zone := range []string{"Asia/Shanghai", "America/New_York", "UTC"} {
		if validTimezone(zone) != zone || clientTimezone(withClientTimezone(context.Background(), zone)) != zone {
			t.Fatal("valid local timezone lost")
		}
	}
	for _, zone := range []string{"", "unknown/Zone", "Asia/Shanghai\r\nother", strings.Repeat("x", 81)} {
		if validTimezone(zone) != "UTC" {
			t.Fatal("invalid timezone did not degrade to UTC")
		}
	}
}

func TestTaskCommandEvidenceRequiresObservedSuccess(t *testing.T) {
	c := storage.TaskCriterion{ID: "checks", Kind: "test_success", Target: "go test ./..."}
	step := runtime.Step{ID: "actual-call", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./..."}`)}
	for _, output := range []string{`{"exit_code":1}`, `{"exit_code":0,"timed_out":true}`, `{"exit_code":0,"isError":true}`, `{"exit_code":0,"error":"interrupted"}`, `{"stdout":"all passed"}`, `not-json`} {
		step.Output = output
		if commandEvidence(c, runtime.Snapshot{RunID: "own", Steps: []runtime.Step{step}}).Passed {
			t.Fatal("failed/unstructured result became verification")
		}
	}
	step.Output = `{"exit_code":0,"timed_out":false}`
	proof := commandEvidence(c, runtime.Snapshot{RunID: "own", Steps: []runtime.Step{step}})
	if !proof.Passed || proof.Source != "recorded_exec" || proof.RunID != "own" || !strings.Contains(proof.Detail, "actual-call") {
		t.Fatal("actual structured success was not traced")
	}
	c.Target = "go test ./different"
	if commandEvidence(c, runtime.Snapshot{Steps: []runtime.Step{step}}).Passed {
		t.Fatal("different command satisfied acceptance")
	}
}

func TestTaskCommandEvidenceUsesLatestMatchingAttempt(t *testing.T) {
	c := storage.TaskCriterion{ID: "checks", Kind: "test_success", Target: "go test ./..."}
	success := runtime.Step{ID: "old-success", Name: "exec", Status: "completed", Arguments: json.RawMessage(`{"command":"go test ./..."}`), Output: `{"exit_code":0,"stdout":"ok"}`}
	for _, later := range []runtime.Step{
		{ID: "later-fail", Status: "completed", Output: `{"exit_code":1,"stderr":"FAIL"}`},
		{ID: "later-timeout", Status: "completed", Output: `{"exit_code":0,"timed_out":true}`},
		{ID: "later-error", Status: "failed", Output: `{"exit_code":0,"isError":true}`},
		{ID: "later-running", Status: "running"},
		{ID: "later-invalid", Status: "completed", Output: `not-json`},
	} {
		t.Run(later.ID, func(t *testing.T) {
			later.Name, later.Arguments = success.Name, success.Arguments
			proof := commandEvidence(c, runtime.Snapshot{RunID: "own", Steps: []runtime.Step{success, later}})
			if proof.Passed || !strings.Contains(proof.Detail, later.ID) {
				t.Fatal("later failed/unfinished recheck was hidden by earlier success")
			}
			later.Status, later.Output = "completed", `{"exit_code":1}`
			success.ID = "new-success"
			proof = commandEvidence(c, runtime.Snapshot{RunID: "own", Steps: []runtime.Step{later, success}})
			if !proof.Passed || !strings.Contains(proof.Detail, success.ID) {
				t.Fatal("latest actual success did not replace prior failure")
			}
		})
	}
	unrelated := success
	unrelated.ID, unrelated.Arguments, unrelated.Output = "other-command", json.RawMessage(`{"command":"go test ./different"}`), `{"exit_code":1}`
	if !commandEvidence(c, runtime.Snapshot{Steps: []runtime.Step{success, unrelated}}).Passed {
		t.Fatal("an unrelated failed command invalidated matching evidence")
	}
}

func TestSkillIndexMetadataOnlyAndCombinedBudget(t *testing.T) {
	items := []map[string]string{}
	for i := 0; i < 40; i++ {
		items = append(items, map[string]string{"id": strings.Repeat("x", i+1), "name": "method", "description": strings.Repeat("desc ", 200), "instructions": "DO_NOT_INJECT_BODY"})
	}
	raw, _ := json.Marshal(map[string]any{"skills": items, "total": 40})
	merged := mergeSkillsIndex(`{"skills":[{"id":"private:checked","name":"checked","description":"verified"}],"total":1}`, string(raw), []string{"installed"})
	var index skillMetadataIndex
	if json.Unmarshal([]byte(merged), &index) != nil || len(merged) > 8192 || len(index.Skills) > 32 || !index.Truncated || len(index.Unavailable) != 1 || strings.Contains(merged, "DO_NOT_INJECT_BODY") || len(index.Skills) == 0 || index.Skills[0].ID != "private:checked" {
		t.Fatal("skill index exceeded shared budget or injected a body")
	}
}
