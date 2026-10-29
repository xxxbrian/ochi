package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/i18n"
)

func TestFailureCodesPreserveTypedMeaning(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{nil, ""},
		{i18n.New("model_unavailable"), "model_unavailable"},
		{fmt.Errorf("wrapped: %w", i18n.New("image_model_unconfigured")), "image_model_unconfigured"},
		{context.Canceled, "run_interrupted"},
		{fmt.Errorf("deadline: %w", context.DeadlineExceeded), "run_timeout"},
		{errors.New("private service or workspace detail"), "run_failed"},
		{&agent.ContextBudgetError{}, "model_context"},
	} {
		if code := FailureCode(test.err); code != test.code {
			t.Fatalf("failure %T: got %s, want %s", test.err, code, test.code)
		}
	}
	for _, class := range []string{"authentication", "permission", "configuration", "billing", "rate_limit", "unavailable", "connection", "context", "output_limit", "content_filter", "timeout", "stream", "invalid_stream", "tool_protocol"} {
		t.Run(class, func(t *testing.T) {
			err := &agent.ModelError{Class: class}
			code := FailureCode(err)
			if code == "run_failed" || i18n.Text("en", code, nil) == i18n.Text("en", "internal_error", nil) {
				t.Fatalf("provider class %s has no stable translated identity", class)
			}
		})
	}
}

func TestTerminalFailureKeepsIdentityThroughPersistenceAndSSE(t *testing.T) {
	manager := NewManager()
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	run := manager.Restore(Snapshot{RunID: "localized-failure", SessionID: "session", Status: StatusRunning})
	_, events, unsubscribe := run.Subscribe()
	defer unsubscribe()
	var saved Snapshot
	private := "internal upstream response must not be sent to the client"
	if err := run.Finalize(StatusFailed, errors.New(private), func(snapshot Snapshot) error {
		saved = snapshot
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	live := run.Snapshot()
	event := <-events
	for _, result := range []struct {
		code, message string
	}{{saved.ErrorCode, saved.Error}, {live.ErrorCode, live.Error}, {event.ErrorCode, event.Error}} {
		if result.code != "run_failed" || result.message != i18n.Text("en", "run_failed", nil) || strings.Contains(result.message, private) {
			t.Fatalf("terminal transport lost the safe stable error: %+v", result)
		}
	}
	if i18n.Text("zh-CN", saved.ErrorCode, nil) == i18n.Text("zh-TW", saved.ErrorCode, nil) {
		t.Fatal("a viewer cannot render the persisted identity in its current language")
	}
}

func TestParameterizedFailuresHaveCompleteRunMessages(t *testing.T) {
	for _, test := range []struct{ source, code string }{
		{"image_provider_http_error", "image_generation_failed"},
		{"search_http_error", "search_failed"},
		{"provider_model_list_rejected", "provider_request_failed"},
		{"update_http_error", "update_failed"},
	} {
		t.Run(test.source, func(t *testing.T) {
			manager := NewManager()
			t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
			run := manager.Restore(Snapshot{RunID: test.source, SessionID: "session", Status: StatusRunning})
			_, events, unsubscribe := run.Subscribe()
			defer unsubscribe()
			var saved Snapshot
			if err := run.Finalize(StatusFailed, i18n.With(test.source, map[string]any{"status": 522}), func(snapshot Snapshot) error {
				saved = snapshot
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			event := <-events
			for _, code := range []string{saved.ErrorCode, run.Snapshot().ErrorCode, event.ErrorCode} {
				if code != test.code {
					t.Fatalf("parameterized transport failure retained an incomplete run identity: %s", code)
				}
				for _, locale := range []string{"en", "zh-CN", "zh-TW"} {
					if message := i18n.Text(locale, code, nil); message == "" || strings.ContainsAny(message, "{}") {
						t.Fatalf("viewer %s has an incomplete message: %s", locale, message)
					}
				}
			}
			if saved.Error != i18n.Text("en", test.code, nil) {
				t.Fatal("persisted fallback does not match the stable run identity")
			}
		})
	}
}

func TestQueuedFailureEventKeepsErrorIdentity(t *testing.T) {
	manager := NewManager()
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	run := manager.Restore(Snapshot{RunID: "queued-failure", SessionID: "session", Status: StatusQueued})
	_, events, unsubscribe := run.Subscribe()
	defer unsubscribe()
	updated := run.Snapshot()
	updated.Seq++
	updated.Status, updated.ErrorCode = StatusFailed, "model_unavailable"
	updated.Error = i18n.Text("en", updated.ErrorCode, nil)
	manager.ApplySnapshot(updated)
	event := <-events
	if event.ErrorCode != updated.ErrorCode || event.Error != updated.Error || event.Status != StatusFailed {
		t.Fatal("queue admission failure event lost its localized failure identity")
	}
}
