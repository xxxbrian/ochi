package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"ochi/server/internal/storage"
)

func TestCoreMemoryAdminConfigWakeupPreservesBoundedFailures(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	p, err := f.server.store.SaveProvider(ctx, storage.Provider{Name: "Selected QA provider", Protocol: "openai", BaseURL: "http://fixture.invalid", Enabled: true, APIKey: "fixture-original-key"})
	if err != nil {
		t.Fatal(err)
	}
	model, err := f.server.store.SaveModel(ctx, storage.Model{ProviderID: p.ID, Name: "QA embedding", Model: "fixture", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := f.server.store.Settings(ctx)
	settings.EmbeddingModelID = model.ID
	if err := f.server.store.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "Memory awaiting a valid embedding target", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	job, err := f.server.store.ClaimMemoryIndexJob(ctx)
	if err != nil || job == nil {
		t.Fatal("could not claim controlled index job")
	}
	batch, err := f.server.store.PendingMemoryIndexBatch(ctx, *job)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.FinishMemoryIndexJob(ctx, *job, storage.ErrEmbeddingDimensions); err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/providers/" + p.ID
	f.request(t, f.token, http.MethodPatch, path, `{"name":"Not authorized"}`, http.StatusForbidden)
	f.request(t, f.foreign, http.MethodPatch, path, `{"name":"Display name only"}`, http.StatusOK)
	status, err := f.server.store.MemoryIndexJobStatus(ctx, f.owner)
	target, targetErr := f.server.store.MemoryEmbeddingTarget(ctx)
	if err != nil || targetErr != nil || status.Status != "failed" || status.Attempts != 1 || target != job.Target {
		t.Fatal("unrelated admin edit revived failed work or changed the embedding identity")
	}
	response := f.request(t, f.foreign, http.MethodPatch, path, `{"api_key_action":"replace","api_key":"fixture-replacement-key"}`, http.StatusOK)
	if strings.Contains(string(response), "fixture-replacement-key") {
		t.Fatal("provider mutation response exposed credentials")
	}
	status, err = f.server.store.MemoryIndexJobStatus(ctx, f.owner)
	target, targetErr = f.server.store.MemoryEmbeddingTarget(ctx)
	if err != nil || targetErr != nil || status.Status != "queued" || status.Attempts != 0 || status.LastError != "" || target == job.Target {
		t.Fatal("effective selected config change did not wake the pending durable backlog")
	}
	if err := f.server.store.CompleteMemoryIndexBatch(ctx, *job, batch, [][]float32{{1, 2}}); !errors.Is(err, storage.ErrMemoryChanged) {
		t.Fatal("admin target change admitted a stale batch")
	}
	next, err := f.server.store.ClaimMemoryIndexJob(ctx)
	if err != nil || next == nil || next.Target != target || next.Generation <= job.Generation {
		t.Fatal("config wakeup did not fence the old target/generation")
	}
	batch, err = f.server.store.PendingMemoryIndexBatch(ctx, *next)
	if err != nil || len(batch) != 1 {
		t.Fatal("pending memory was lost by admin wakeup")
	}
	if err := f.server.store.CompleteMemoryIndexBatch(ctx, *next, batch, [][]float32{{1, 2}}); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.foreign, http.MethodPatch, path, `{"name":"Another display edit"}`, http.StatusOK)
	if candidate, err := f.server.store.ClaimMemoryIndexJob(ctx); err != nil || candidate != nil {
		t.Fatal("unrelated edit repeatedly reindexed an empty completed backlog")
	}
}
