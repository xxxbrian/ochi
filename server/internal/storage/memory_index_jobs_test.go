package storage

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

func memoryIndexBatch(t *testing.T, s *Store) (MemoryIndexJob, []Memory) {
	t.Helper()
	job, err := s.ClaimMemoryIndexJob(context.Background())
	if err != nil || job == nil {
		t.Fatalf("claim index job: %v", err)
	}
	items, err := s.PendingMemoryIndexBatch(context.Background(), *job)
	if err != nil {
		t.Fatal(err)
	}
	return *job, items
}

func memoryIndexVectors(items []Memory) [][]float32 {
	vectors := make([][]float32, len(items))
	for i := range items {
		vectors[i] = []float32{1, 2}
	}
	return vectors
}

func TestMemoryIndexDatabaseBacklogRetryRestart(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	var first Memory
	for i := 0; i < 86; i++ {
		m, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: fmt.Sprintf("Index backlog record %02d", i), Kind: "session_summary", Source: "user"})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = m
		}
	}
	job, batch := memoryIndexBatch(t, s)
	if len(batch) != 40 {
		t.Fatal("index batch is not bounded at 40")
	}
	if err := s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	if err := s.FinishMemoryIndexJob(ctx, job, errors.New("controlled embedding failure")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET next_attempt_at=now() WHERE user_id=$1`, memoryQAUser); err != nil {
		t.Fatal(err)
	}
	// A new Store represents a restarted service: no in-process queue state is
	// carried across it. A second restart recovers an expired HTTP-work lease.
	restarted := &Store{db: s.db}
	job, batch = memoryIndexBatch(t, restarted)
	if job.Attempts != 2 || len(batch) != 40 {
		t.Fatal("retry lost the durable attempt or pending batch")
	}
	if _, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET lease_until=now()-interval '1 second' WHERE user_id=$1`, memoryQAUser); err != nil {
		t.Fatal(err)
	}
	newJob, newBatch := memoryIndexBatch(t, &Store{db: s.db})
	if newJob.LeaseToken == job.LeaseToken || newJob.Attempts != 3 {
		t.Fatal("restart did not fence the old worker")
	}
	if err := s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatalf("expired worker committed stale batch: %v", err)
	}
	if err := s.CompleteMemoryIndexBatch(ctx, newJob, newBatch, memoryIndexVectors(newBatch)); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	if job.Attempts != 1 || len(batch) != 6 {
		t.Fatal("successful retry did not continue the final batch")
	}
	if err := s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); err != nil {
		t.Fatal(err)
	}
	var indexed int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM memories WHERE user_id=$1 AND embedding IS NOT NULL AND embedding_model_id=$2`, memoryQAUser, job.Target.Identity).Scan(&indexed); err != nil || indexed != 86 {
		t.Fatalf("multi-batch backlog did not drain: %d, %v", indexed, err)
	}
	for i := 0; i < 3; i++ {
		if err := restarted.EnqueueAllMemoryIndexes(ctx, false); err != nil {
			t.Fatal(err)
		}
		if next, err := restarted.ClaimMemoryIndexJob(ctx); err != nil || next != nil {
			t.Fatal("empty completed backlog was repeatedly requeued")
		}
	}
	first.Content += " updated"
	if _, err := s.SaveMemoryRecord(ctx, memoryQAUser, first); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		job, _ := memoryIndexBatch(t, restarted)
		if job.Attempts != attempt {
			t.Fatal("failed attempts were reset by restart")
		}
		if err := s.FinishMemoryIndexJob(ctx, job, errors.New("fixture unavailable, not provider contents")); err != nil {
			t.Fatal(err)
		}
		if _, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET next_attempt_at=now() WHERE user_id=$1`, memoryQAUser); err != nil {
			t.Fatal(err)
		}
		if err := restarted.EnqueueAllMemoryIndexes(ctx, false); err != nil {
			t.Fatal(err)
		}
	}
	status, err := s.MemoryIndexJobStatus(ctx, memoryQAUser)
	if err != nil || status.Status != "failed" || status.Attempts != 3 || status.LastError != "embedding_unavailable" {
		t.Fatalf("failed job was not bounded and categorically diagnosable: %+v, %v", status, err)
	}
	if next, err := restarted.ClaimMemoryIndexJob(ctx); err != nil || next != nil {
		t.Fatal("startup scan revived an exhausted same-target job")
	}
}

func TestMemoryIndexDatabaseMutationConfigAndDimensionGuards(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	p, err := s.SaveProvider(ctx, Provider{Name: "QA embeddings", Protocol: "openai", BaseURL: "http://fixture.invalid", APIKey: "fixture-secret-original", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.SaveModel(ctx, Model{ProviderID: p.ID, Name: "QA", Model: "fixture-embedding", Kind: "embedding", Available: true})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := s.Settings(ctx)
	settings.EmbeddingModelID = m.ID
	if err = s.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	record, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Current travel evidence", Source: "user", Kind: "session_summary"})
	if err != nil {
		t.Fatal(err)
	}
	job, batch := memoryIndexBatch(t, s)
	record.Content = "Corrected travel evidence"
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, record); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("manual edit accepted old inference")
	}
	job, batch = memoryIndexBatch(t, s)
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); err != nil {
		t.Fatal(err)
	}
	oldTarget := job.Target
	p.APIKey = "fixture-secret-replaced"
	if _, err = s.SaveProvider(ctx, p); err != nil {
		t.Fatal(err)
	}
	// No admin enqueue has run: the config-save -> queue-wakeup crash window
	// must already exclude old vectors for the same raw model UUID.
	target, err := s.MemoryEmbeddingTarget(ctx)
	if err != nil || target.Identity == oldTarget.Identity || strings.Contains(target.Identity, "fixture-secret") {
		t.Fatal("current effective target did not change safely with credentials")
	}
	recall, err := s.RecallMemoriesWithStatus(ctx, memoryQAUser, "", "unrelated topic", oldTarget.Identity, []float32{1, 2})
	if err != nil || len(recall.Items) != 0 || !slices.Contains(recall.Status.Events, "embedding_unavailable") {
		t.Fatal("config changed without queue wakeup, yet old vector was recalled")
	}
	if err = s.EnqueueAllMemoryIndexes(ctx, false); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	if job.Target != target {
		t.Fatal("startup backlog did not adopt effective target")
	}
	m.Model = "fixture-embedding-next"
	if _, err = s.SaveModel(ctx, m); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("a changed model accepted old in-flight vectors")
	}
	if err = s.EnqueueAllMemoryIndexes(ctx, false); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	off, on := false, true
	if _, err = s.PatchPreferences(ctx, memoryQAUser, PreferencesPatch{MemoryEnabled: &off}); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("disabled memory accepted old vectors")
	}
	m.Model = "fixture-embedding-while-disabled"
	if _, err = s.SaveModel(ctx, m); err != nil {
		t.Fatal(err)
	}
	if err = s.EnqueueAllMemoryIndexes(ctx, false); err != nil {
		t.Fatal(err)
	}
	if candidate, err := s.ClaimMemoryIndexJob(ctx); err != nil || candidate != nil {
		t.Fatal("disabled user was queued after model change")
	}
	if _, err = s.PatchPreferences(ctx, memoryQAUser, PreferencesPatch{MemoryEnabled: &on}); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	if err = s.CheckEmbeddingDimensions(ctx, job.Target.Identity, 3); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrEmbeddingDimensions) {
		t.Fatal("changed dimensions were accepted at atomic batch commit")
	}
	if err = s.FinishMemoryIndexJob(ctx, job, ErrEmbeddingDimensions); err != nil {
		t.Fatal(err)
	}
	status, err := s.MemoryIndexJobStatus(ctx, memoryQAUser)
	if err != nil || status.Status != "failed" || status.LastError != "embedding_dimensions_changed" {
		t.Fatal("dimension failure was not categorically diagnosable")
	}
	record.Content += " latest"
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, record); err != nil {
		t.Fatal(err)
	}
	job, batch = memoryIndexBatch(t, s)
	if err = s.DeleteMemory(ctx, memoryQAUser, record.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("deleted memory was restored by old vector commit")
	}
}

func TestMemoryIndexDatabaseManualEditCommitLockOrder(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	record, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Before concurrent edit", Source: "user"})
	if err != nil {
		t.Fatal(err)
	}
	job, batch := memoryIndexBatch(t, s)
	edit, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer edit.Rollback(context.Background())
	// Hold exactly the prefs -> memory part of a manual edit while the old
	// HTTP batch tries to commit, then execute the edit's final job enqueue.
	if _, err = edit.Exec(ctx, `UPDATE user_preferences SET memory_revision=memory_revision+1 WHERE user_id=$1`, memoryQAUser); err != nil {
		t.Fatal(err)
	}
	if _, err = edit.Exec(ctx, `UPDATE memories SET content='After concurrent edit',embedding=NULL WHERE id=$1`, record.ID); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)) }()
	for {
		var blocked bool
		err = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO user_preferences(user_id)%')`).Scan(&blocked)
		if err != nil {
			t.Fatal("batch did not wait at the preferences boundary")
		}
		if blocked {
			break
		}
		select {
		case result := <-finished:
			t.Fatalf("index commit unexpectedly escaped blocked edit: %v", result)
		case <-time.After(10 * time.Millisecond):
		}
	}
	short, stop := context.WithTimeout(ctx, 500*time.Millisecond)
	err = enqueueMemoryIndexTx(short, edit, memoryQAUser, true)
	stop()
	if err != nil {
		t.Fatalf("manual edit deadlocked against old batch: %v", err)
	}
	if err = edit.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-finished; !errors.Is(err, ErrMemoryChanged) {
		t.Fatalf("old batch crossed serialized manual revision: %v", err)
	}
	stored, err := s.Memory(ctx, memoryQAUser, record.ID)
	if err != nil || stored.Content != "After concurrent edit" || stored.HasEmbedding {
		t.Fatal("manual correction or vector invalidation was lost")
	}
}

func TestMemoryDatabaseProfileExpiryAndVectorDegradation(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	expires := time.Now().Add(180 * time.Millisecond)
	if _, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Temporary authoritative profile", Source: "user", ExpiresAt: &expires}); err != nil {
		t.Fatal(err)
	}
	pref, _ := s.Preferences(ctx, memoryQAUser)
	items, _ := s.StableMemoryProfile(ctx, memoryQAUser)
	if frozen, err := s.FreezeMemoryProfile(ctx, memoryQAUser, memoryQASession, MemoryProfileText(items), pref.MemoryRevision); err != nil || !strings.Contains(frozen, "Temporary authoritative profile") {
		t.Fatal("profile did not initially freeze with active fact")
	}
	time.Sleep(time.Until(expires) + 20*time.Millisecond)
	if _, exists, err := s.FrozenMemoryContext(ctx, memoryQAUser, memoryQASession); err != nil || exists {
		t.Fatal("same-session frozen profile permanently retained expired fact")
	}
	items, _ = s.StableMemoryProfile(ctx, memoryQAUser)
	if refreshed, err := s.FreezeMemoryProfile(ctx, memoryQAUser, memoryQASession, MemoryProfileText(items), pref.MemoryRevision); err != nil || strings.Contains(refreshed, "Temporary authoritative profile") {
		t.Fatal("expired same-session profile was not rebuilt")
	}
	emptyJob, emptyBatch := memoryIndexBatch(t, s)
	if len(emptyBatch) != 0 {
		t.Fatal("expired memory still entered pending index batch")
	}
	if err := s.CompleteMemoryIndexBatch(ctx, emptyJob, emptyBatch, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.EnqueueAllMemoryIndexes(ctx, false); err != nil {
		t.Fatal(err)
	}
	if candidate, err := s.ClaimMemoryIndexJob(ctx); err != nil || candidate != nil {
		t.Fatal("expired empty batch repeatedly issued work after startup")
	}
	if _, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Lexical evidence survives vector outage", Kind: "session_summary", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	job, batch := memoryIndexBatch(t, s)
	if err := s.CompleteMemoryIndexBatch(ctx, job, batch, memoryIndexVectors(batch)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(ctx, `ALTER TABLE memories ALTER COLUMN embedding TYPE text USING embedding::text`); err != nil {
		t.Fatal(err)
	}
	result, err := s.RecallMemoriesWithStatus(ctx, memoryQAUser, "", "Lexical evidence", job.Target.Identity, []float32{1, 2})
	if err != nil || len(result.Items) != 1 || result.Status.Mode != "lexical" || !result.Status.Degraded || !slices.Contains(result.Status.Events, "vector_query_failed") || !slices.Contains(result.Status.Events, "lexical_fallback") {
		t.Fatalf("vector failure was silently swallowed or lost lexical evidence: %+v, %v", result, err)
	}
}
