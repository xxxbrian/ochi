package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"ochi/server/internal/storage"
)

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
