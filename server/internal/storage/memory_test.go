package storage

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestMemoryVectorAndSourceBoundaries(t *testing.T) {
	tokens := memoryTokens("What are our Kyoto hotel check-in time and nightly budget?")
	if slices.Contains(tokens, "our") || slices.Contains(tokens, "in") || !slices.Contains(tokens, "kyoto") || !slices.Contains(tokens, "budget") {
		t.Fatal("topic recall retained English function-word noise or lost task terms")
	}
	for _, test := range []struct {
		text, token string
		want        bool
	}{
		{"borrow lifetimes inspect", "time", false},
		{"borrow lifetimes inspect", "our", false},
		{"borrow lifetimes inspect", "in", false},
		{"check-in time: 15:30", "time", true},
		{"lifetimes; time.", "time", true},
		{"time\u0301", "time", false},
		{"golang", "go", false},
		{"\u4eac\u90fd\u9152\u5e97\u9884\u7b97", "\u9152\u5e97", true},
	} {
		if memoryTokenMatches(test.text, test.token) != test.want {
			t.Errorf("memory term %q in %q: want %t", test.token, test.text, test.want)
		}
	}
	for _, v := range [][]float32{nil, {0, 0}, {float32(math.NaN())}, {float32(math.Inf(1))}, make([]float32, 16001)} {
		if ValidateMemoryVector(v) == nil {
			t.Fatal("accepted invalid embedding")
		}
	}
	if err := ValidateMemoryVector([]float32{0.1, -0.2}); err != nil {
		t.Fatal(err)
	}
	if memoryContentHash("  My NAME\n Is Ochi ") != memoryContentHash("my name is ochi") {
		t.Fatal("deletion hash changed with case/whitespace")
	}
	m := Memory{Source: "agent", Kind: "fact", Content: "inferred fact", SourceRunID: "run", SourceSessionID: "session"}
	if !errors.Is(validateMemoryProvenance(&m), ErrMemorySource) {
		t.Fatal("agent inference without a user excerpt became authoritative")
	}
	m.SourceExcerpt = "exact user statement"
	if err := validateMemoryProvenance(&m); err != nil || m.Trust != "user_statement" {
		t.Fatal("user evidence was not classified")
	}
	m.Source = "user"
	if err := validateMemoryProvenance(&m); err != nil || m.SourceExcerpt != "" || m.Trust != "user_curated" {
		t.Fatal("manual edit retained misleading prior evidence")
	}
}

func TestHistoryProjectionDoesNotExposeSignaturesImagesOrSecrets(t *testing.T) {
	var item HistoryEvidence
	payload := json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"Result"},{"type":"image_url","image_url":{"url":"data:image/png;base64,PRIVATE_IMAGE"}}],"reasoning_content":"PRIVATE_REASONING","signature":"PRIVATE_SIGNATURE","tool_calls":[{"id":"call1","function":{"name":"exec","arguments":"{\"env\":{\"API_KEY\":\"sk-secret-key-123456789012\"}}"}}]}`)
	if err := historyEvidencePayload(&item, payload, 2000); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(item)
	for _, private := range []string{"PRIVATE_IMAGE", "PRIVATE_REASONING", "PRIVATE_SIGNATURE", "sk-secret-key-123456789012"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("history exposed %s", private)
		}
	}
	if !item.Redacted || item.Source != "canonical_transcript" || item.Trust != "historical_assistant" {
		t.Fatal("evidence trust/redaction metadata missing")
	}
	text, _ := SanitizeHistoryText("https://name:password@example.org/file?token=private-secret&lang=zh Bearer secret-token-123456", 1000)
	if strings.Contains(text, "private-secret") || strings.Contains(text, "secret-token-123456") || strings.Contains(text, "name:password") {
		t.Fatal("credential survived bounded history sanitation")
	}
}

const memoryQAUser = "memory-owned-fixture"
const memoryQASession = "11111111-aaaa-4111-8111-111111111111"
const memoryQARun = "22222222-aaaa-4222-8222-222222222222"

func seedMemorySource(t *testing.T, s *Store) {
	t.Helper()
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,'QA','not-a-login')`, []any{memoryQAUser}},
		{`INSERT INTO sessions(id,user_id,title) VALUES($1,$2,'Memory source')`, []any{memoryQASession, memoryQAUser}},
		{`INSERT INTO runs(id,session_id,status,timeline) VALUES($1,$2,'completed','[]')`, []any{memoryQARun, memoryQASession}},
		{`INSERT INTO messages(session_id,run_id,role,content) VALUES($1,$2,'user','I prefer Go. Actually I now prefer Rust. My timezone is Asia/Shanghai.')`, []any{memoryQASession, memoryQARun}},
	} {
		if _, err := s.db.Exec(context.Background(), seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMemoryGovernanceDatabaseTransitions(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	manual, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Use concise replies", Kind: "preference", Source: "user"})
	if err != nil {
		t.Fatal(err)
	}
	pref, _ := s.Preferences(ctx, memoryQAUser)
	base := Memory{Content: "Prefers Go", Kind: "preference", Source: "automatic", SourceRunID: memoryQARun, SourceSessionID: memoryQASession, SourceExcerpt: "I prefer Go.", ExpectedRevision: &pref.MemoryRevision}
	old, err := s.SaveMemoryRecord(ctx, memoryQAUser, base)
	if err != nil {
		t.Fatal(err)
	}
	base.ID, base.Content, base.SourceExcerpt = old.ID, "Prefers Rust", "Actually I now prefer Rust."
	replacement, err := s.SaveMemoryRecord(ctx, memoryQAUser, base)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := s.Memory(ctx, memoryQAUser, old.ID)
	if original.SupersededAt == nil || original.SupersededBy != replacement.ID || original.Content != "Prefers Go" {
		t.Fatal("correction destroyed or did not supersede original evidence")
	}
	profile, err := s.StableMemoryProfile(ctx, memoryQAUser)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range profile {
		if m.ID == old.ID {
			t.Fatal("superseded preference entered stable profile")
		}
	}
	frozen, err := s.FreezeMemoryProfile(ctx, memoryQAUser, memoryQASession, MemoryProfileText(profile), pref.MemoryRevision)
	if err != nil || !strings.Contains(frozen, "Prefers Rust") {
		t.Fatalf("profile freeze: %v", err)
	}
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, base); err != nil {
		t.Fatalf("retrying same correction was not idempotent: %v", err)
	}
	// An independently saved equivalent successor must not short-circuit the
	// explicit correction and leave a conflicting predecessor active.
	other := base
	other.ID, other.Content, other.SourceExcerpt = "", "Go is my preferred language", "I prefer Go."
	otherOld, err := s.SaveMemoryRecord(ctx, memoryQAUser, other)
	if err != nil {
		t.Fatal(err)
	}
	other.ID, other.Content, other.SourceExcerpt = otherOld.ID, replacement.Content, base.SourceExcerpt
	if reused, err := s.SaveMemoryRecord(ctx, memoryQAUser, other); err != nil || reused.ID != replacement.ID {
		t.Fatalf("known successor correction was not deduplicated: %v", err)
	}
	otherOriginal, _ := s.Memory(ctx, memoryQAUser, otherOld.ID)
	if otherOriginal.SupersededBy != replacement.ID || otherOriginal.SupersededAt == nil {
		t.Fatal("known successor left the contradictory predecessor active")
	}
	if err = s.DeleteMemory(ctx, memoryQAUser, replacement.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, base); !errors.Is(err, ErrMemoryChanged) {
		t.Fatal("stale extraction crossed user deletion revision")
	}
	pref, _ = s.Preferences(ctx, memoryQAUser)
	base.ID = ""
	base.ExpectedRevision = &pref.MemoryRevision
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, base); !errors.Is(err, ErrMemoryDeleted) {
		t.Fatalf("fresh job resurrected exact forgotten statement: %v", err)
	}
	base.Content, base.SourceExcerpt = "timezone Asia/Shanghai", "My timezone is Asia/Shanghai."
	derived, err := s.SaveMemoryRecord(ctx, memoryQAUser, base)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = InvalidateRunMemoriesTx(ctx, tx, memoryQAUser, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	revised, _ := s.Memory(ctx, memoryQAUser, derived.ID)
	kept, _ := s.Memory(ctx, memoryQAUser, manual.ID)
	if revised.SupersededAt == nil || kept.SupersededAt != nil {
		t.Fatal("turn revision did not isolate derived vs user-curated memory")
	}
	if _, exists, err := s.FrozenMemoryContext(ctx, memoryQAUser, memoryQASession); err != nil || exists {
		t.Fatal("explicit revision left a stale profile")
	}
	if err = s.CheckEmbeddingDimensions(ctx, "embedding-fixture", 2); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckEmbeddingDimensions(ctx, "embedding-fixture", 3); err == nil {
		t.Fatal("model silently changed embedding dimensions")
	}
	expired := time.Now().Add(-time.Hour)
	if _, err = s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Expired status", Kind: "project_summary", Source: "user", ExpiresAt: &expired}); err != nil {
		t.Fatal(err)
	}
	recalled, err := s.RecallMemories(ctx, memoryQAUser, "", "Expired status", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range recalled {
		if m.Content == "Expired status" {
			t.Fatal("expired memory was recalled")
		}
	}
}

func TestMemoryJobDatabaseLeaseRetryAndCompletedOnly(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	if err := s.EnqueueMemoryJob(ctx, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if err := s.EnqueueMemoryJob(ctx, memoryQARun); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimMemoryJob(ctx)
	if err != nil || job == nil || job.Attempts != 1 {
		t.Fatalf("first durable claim: %v", err)
	}
	if err = s.SaveMemoryExtraction(ctx, *job, json.RawMessage(`{"facts":[],"summary":"Cached extraction"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(ctx, `UPDATE memory_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1`, job.RunID); err != nil {
		t.Fatal(err)
	}
	reclaimed, err := s.ClaimMemoryJob(ctx)
	if err != nil || reclaimed == nil || reclaimed.Attempts != 2 || reclaimed.LeaseToken == job.LeaseToken || len(reclaimed.Extraction) == 0 {
		t.Fatal("expired lease lost cached extraction or was not reclaimed")
	}
	if err = s.FinishMemoryJob(ctx, *job, nil); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = s.db.QueryRow(ctx, `SELECT status FROM memory_jobs WHERE run_id=$1`, job.RunID).Scan(&status); err != nil || status != "leased" {
		t.Fatal("stale worker completed a new lease")
	}
	if err = s.FinishMemoryJob(ctx, *reclaimed, errors.New("fixture failure")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(ctx, `UPDATE memory_jobs SET next_attempt_at=now() WHERE run_id=$1`, job.RunID); err != nil {
		t.Fatal(err)
	}
	last, err := s.ClaimMemoryJob(ctx)
	if err != nil || last == nil || last.Attempts != 3 {
		t.Fatal("retry did not retain attempt count")
	}
	if err = s.FinishMemoryJob(ctx, *last, errors.New("fixture failure")); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.MemoryJobs(ctx, memoryQAUser)
	if err != nil || len(jobs) != 1 || jobs[0].Status != "failed" {
		t.Fatal("exhausted durable job was not diagnosable")
	}
	if _, err = s.db.Exec(ctx, `UPDATE runs SET status='running' WHERE id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(ctx, `DELETE FROM memory_jobs WHERE run_id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if err = s.QueueMemoryPreservation(ctx, memoryQAUser, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if candidate, err := s.ClaimMemoryJob(ctx); err != nil || candidate != nil {
		t.Fatal("precompaction queue resumed an unfinished agent run")
	}
	if _, err = s.db.Exec(ctx, `UPDATE runs SET status='interrupted' WHERE id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if candidate, err := s.ClaimMemoryJob(ctx); err != nil || candidate != nil {
		t.Fatal("restart replayed an interrupted agent")
	}
	jobs, _ = s.MemoryJobs(ctx, memoryQAUser)
	if len(jobs) != 1 || jobs[0].Status != "skipped" {
		t.Fatal("interrupted source job stayed queued")
	}
}

func TestHistoryDatabaseScopeOriginalEvidenceAndArchivedTurns(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,user_id,name) VALUES('33333333-aaaa-4333-8333-333333333333',$1,'Private project')`, []any{memoryQAUser}},
		{`INSERT INTO sessions(id,user_id,title,project_id) VALUES('44444444-aaaa-4444-8444-444444444444',$1,'Private plan','33333333-aaaa-4333-8333-333333333333')`, []any{memoryQAUser}},
		{`INSERT INTO messages(session_id,role,content) VALUES('44444444-aaaa-4444-8444-444444444444','user','PRIVATE_PROJECT exact proposal')`, nil},
		{`INSERT INTO canonical_messages(session_id,run_id,payload) VALUES($1,$2,'{"role":"user","content":"Original exact proposal"}'),($1,$2,'{"role":"tool","tool_call_id":"read1","content":"Verified old file output"}')`, []any{memoryQASession, memoryQARun}},
		{`INSERT INTO context_compactions(session_id,through_seq,summary) SELECT $1,max(seq),'Old summary' FROM canonical_messages WHERE session_id=$1`, []any{memoryQASession}},
	} {
		if _, err := s.db.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	hits, err := s.SearchHistory(ctx, memoryQAUser, "", "", "proposal", 8)
	if err != nil {
		t.Fatal(err)
	}
	for _, hit := range hits {
		if strings.Contains(hit.Excerpt, "PRIVATE_PROJECT") {
			t.Fatal("ordinary history search crossed project namespace")
		}
	}
	if _, err = s.ReadHistory(ctx, memoryQAUser, "", "44444444-aaaa-4444-8444-444444444444", 0, 20); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("ordinary history read crossed project namespace")
	}
	page, err := s.ReadHistory(ctx, memoryQAUser, "", memoryQASession, 0, 20)
	if err != nil || len(page.Items) != 2 || page.Items[0].Content != "Original exact proposal" || page.Items[1].Trust != "tool_evidence" {
		t.Fatalf("compaction hid original evidence: %v", err)
	}
	if _, err = s.db.Exec(ctx, `UPDATE canonical_messages SET archived=true WHERE run_id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(ctx, `UPDATE messages SET archived=true WHERE run_id=$1`, memoryQARun); err != nil {
		t.Fatal(err)
	}
	page, err = s.ReadHistory(ctx, memoryQAUser, "", memoryQASession, 0, 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatal("edited turn remained retrievable as current evidence")
	}
}
