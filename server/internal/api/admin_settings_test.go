package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/storage"
)

func TestAdminSettingsDebugModeStrictBooleanPatch(t *testing.T) {
	for _, tc := range []struct {
		body  string
		start bool
		want  bool
		valid bool
	}{
		{`{}`, true, true, true}, {`{"debug_mode":true}`, false, true, true}, {`{"debug_mode":false}`, true, false, true},
		{`{"debug_mode":null}`, true, true, false}, {`{"debug_mode":"true"}`, false, false, false},
		{`{"debug_mode":1}`, false, false, false}, {`{"debug_mode":{}}`, false, false, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			settings := storage.Settings{DebugMode: tc.start, SystemPrompt: "preserve", MaxToolRounds: 48}
			patch := adminSettingsPatch{Settings: &settings}
			if err := json.Unmarshal([]byte(tc.body), &patch); err != nil {
				t.Fatal(err)
			}
			err := patch.applyDebugMode()
			if (err == nil) != tc.valid || settings.DebugMode != tc.want || settings.SystemPrompt != "preserve" {
				t.Fatalf("strict debug patch changed unrelated settings or accepted invalid type: %+v %v", settings, err)
			}
		})
	}
}

type adminSettingsBlockedBody struct {
	reader  io.Reader
	ctx     context.Context
	entered chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (b *adminSettingsBlockedBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered) })
	select {
	case <-b.release:
		return b.reader.Read(p)
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	}
}

func (b *adminSettingsBlockedBody) Close() error { return nil }

func TestAdminSettingsConcurrentPatchesPreserveDebugModeAndLiveSwitch(t *testing.T) {
	f := newCoreHTTPFixture(t)
	f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", `{"debug_mode":true}`, http.StatusOK)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	var completed []<-chan struct{}
	t.Cleanup(func() {
		release()
		cancel()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		for _, done := range completed {
			select {
			case <-done:
			case <-cleanupCtx.Done():
				t.Error("concurrent settings request did not stop after cancellation")
				return
			}
		}
	})
	patch := func(body io.Reader) (<-chan *httptest.ResponseRecorder, <-chan struct{}) {
		r := httptest.NewRequest(http.MethodPatch, "/api/admin/settings", body).WithContext(ctx)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+f.foreign)
		result := make(chan *httptest.ResponseRecorder, 1)
		started, done := make(chan struct{}), make(chan struct{})
		completed = append(completed, done)
		go func() {
			defer close(done)
			w := httptest.NewRecorder()
			close(started)
			f.server.Handler().ServeHTTP(w, r)
			result <- w
		}()
		return result, started
	}
	wait := func(signal <-chan struct{}, stage string) {
		t.Helper()
		select {
		case <-signal:
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s: %v", stage, ctx.Err())
		}
	}
	response := func(result <-chan *httptest.ResponseRecorder) storage.Settings {
		t.Helper()
		select {
		case w := <-result:
			if w.Code != http.StatusOK {
				t.Fatalf("concurrent settings PATCH returned %d: %s", w.Code, w.Body.String())
			}
			var settings storage.Settings
			if err := json.Unmarshal(w.Body.Bytes(), &settings); err != nil {
				t.Fatal(err)
			}
			return settings
		case <-ctx.Done():
			t.Fatalf("timed out waiting for settings PATCH: %v", ctx.Err())
			return storage.Settings{}
		}
	}
	blocked := &adminSettingsBlockedBody{reader: strings.NewReader(`{"max_tool_rounds":49}`), ctx: ctx, entered: make(chan struct{}), release: gate}
	a, _ := patch(blocked)
	wait(blocked.entered, "unrelated PATCH to read settings and start decoding")
	// Without a lock covering the initial read, A can later write its stale true
	// over B's false. Check ownership at this boundary instead of using a sleep
	// to guess whether B has reached the competing read/write.
	if f.server.settingsUpdateMu.TryLock() {
		f.server.settingsUpdateMu.Unlock()
		t.Fatal("settings PATCH did not hold the update lock while decoding its body")
	}
	b, bStarted := patch(strings.NewReader(`{"debug_mode":false}`))
	wait(bStarted, "debug PATCH to start while unrelated PATCH is blocked")
	release()
	first, second := response(a), response(b)
	if first.MaxToolRounds != 49 || !first.DebugMode || second.MaxToolRounds != 49 || second.DebugMode {
		t.Fatalf("partial patches did not preserve their commit order: first=%+v second=%+v", first, second)
	}
	stored, err := f.server.store.Settings(ctx)
	if err != nil || stored.MaxToolRounds != 49 || stored.DebugMode || f.server.debugMode.Load() {
		t.Fatalf("concurrent patches lost an unrelated change or disagreed with the live switch: stored=%+v live=%v err=%v", stored, f.server.debugMode.Load(), err)
	}
}

func TestAdminSettingsDebugModePersistsAndUpdatesLiveSwitch(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	settings, err := f.server.store.Settings(ctx)
	if err != nil || settings.DebugMode || f.server.debugMode.Load() {
		t.Fatal("debug capture did not default to disabled", err)
	}
	// Toggling diagnostics must not depend on an unrelated auxiliary slot still
	// resolving after a provider/model was deleted.
	settings.EmbeddingModelID = "removed-model"
	if err := f.server.store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{true, false} {
		body, _ := json.Marshal(map[string]bool{"debug_mode": enabled})
		var response storage.Settings
		if err := json.Unmarshal(f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", string(body), http.StatusOK), &response); err != nil || response.DebugMode != enabled || response.EmbeddingModelID != "removed-model" || f.server.debugMode.Load() != enabled {
			t.Fatal("debug-only patch did not persist/update its live switch", err)
		}
		stored, err := f.server.store.DebugMode(ctx)
		if err != nil || stored != enabled {
			t.Fatal("debug-only patch was not persisted", err)
		}
	}
	settings.EmbeddingModelID = ""
	if err := f.server.store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", `{"debug_mode":true,"max_tool_rounds":49}`, http.StatusOK)
	stored, err := f.server.store.Settings(ctx)
	if err != nil || !stored.DebugMode || stored.MaxToolRounds != 49 || !f.server.debugMode.Load() {
		t.Fatal("full settings write did not update persisted/live debug mode", err)
	}
	for _, body := range []string{`{"debug_mode":null}`, `{"debug_mode":"false"}`, `{"debug_mode":0}`} {
		f.request(t, f.foreign, http.MethodPatch, "/api/admin/settings", body, http.StatusBadRequest)
		if !f.server.debugMode.Load() {
			t.Fatal("invalid patch changed the live switch")
		}
	}
}

func TestAdminSettingsPreservesSupplementVerbatim(t *testing.T) {
	f := newCoreHTTPFixture(t)
	for _, prompt := range []string{
		"",
		" \n",
		" Keep the administrator's exact wording. \n",
		"Discuss these instructions: 能完成的任务应实际执行、观察结果并验证；处理专门任务时先用 skills_list；生成可下载文件放到 /data/files。",
	} {
		body, err := json.Marshal(storage.Settings{SystemPrompt: prompt, MaxToolRounds: 48})
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodPatch, http.MethodGet} {
			var settings storage.Settings
			if err := json.Unmarshal(f.request(t, f.foreign, method, "/api/admin/settings", string(body), http.StatusOK), &settings); err != nil {
				t.Fatal(err)
			}
			if settings.SystemPrompt != prompt {
				t.Fatalf("%s rewrote administrator instructions", method)
			}
		}
		stored, err := f.server.store.Settings(context.Background())
		if err != nil || stored.SystemPrompt != prompt {
			t.Fatal("administrator instructions were not persisted verbatim")
		}
	}
}
