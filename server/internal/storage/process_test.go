package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func TestProcessTimelineEncodingAlwaysUsesArray(t *testing.T) {
	zero, err := marshalTimeline(nil)
	if err != nil || string(zero) != "[]" {
		t.Fatal("zero-value timeline must serialize as an empty array")
	}
	empty, err := marshalTimeline([]runtime.ProcessEntry{})
	if err != nil || string(empty) != "[]" {
		t.Fatal("new empty timeline must be a supported array")
	}
	payload, _ := json.Marshal(Message{Role: "assistant", HasProcess: true})
	if !strings.Contains(string(payload), `"has_process":true`) {
		t.Fatal("progress-only history cannot discover its process")
	}
}

func TestRunArtifactStateDoesNotReadBackFromMessageProjection(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	if _, err := s.db.Exec(ctx, `INSERT INTO users(id,username,display_name,password_hash)
 VALUES('artifact-state-qa','artifact-state-qa','QA','not-a-login')`); err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateSession(ctx, "artifact-state-qa")
	if err != nil {
		t.Fatal(err)
	}
	const runID = "55555555-5555-4555-8555-555555555556"
	if _, err := s.db.Exec(ctx, `INSERT INTO runs(id,session_id,status) VALUES($1,$2,'completed')`, runID, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO messages(session_id,run_id,role,content,attachments)
 VALUES($1,$2,'assistant','', '[{"id":"projection-only"}]')`, session.ID, runID); err != nil {
		t.Fatal(err)
	}
	run, err := s.GetRun(ctx, "artifact-state-qa", runID)
	latest, latestErr := s.LatestRun(ctx, "artifact-state-qa", session.ID)
	if err != nil || latestErr != nil || latest == nil {
		t.Fatalf("run read failed: get=%v latest=%v", err, latestErr)
	}
	if len(run.Artifacts) != 0 || len(latest.Artifacts) != 0 {
		t.Fatal("message projection replaced authoritative run artifact state")
	}
}

// This opt-in test never opens the application database or runs a scheduler.
// It requires an explicitly named disposable DB and owns only a temp schema.
func processTestStore(t *testing.T) *Store {
	t.Helper()
	store := emptyProcessTestStore(t)
	if err := store.initialize(context.Background()); err != nil {
		t.Fatalf("isolated current schema initialization: %v", err)
	}
	return store
}

func emptyProcessTestStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("OCHI_PROCESS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set OCHI_PROCESS_TEST_DATABASE_URL to a disposable ochi_process_qa database")
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal("invalid process QA database configuration")
	}
	name := config.ConnConfig.Database
	if name != "ochi_process_qa" && !strings.HasPrefix(name, "ochi_process_qa_") {
		t.Fatal("refusing process persistence test outside an explicitly named disposable DB")
	}
	ctx := context.Background()
	admin, err := pgxpool.NewWithConfig(ctx, config.Copy())
	if err != nil {
		t.Fatal(err)
	}
	// Extension types must not belong to a temporary schema that cleanup drops.
	if _, err = admin.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := fmt.Sprintf("process_qa_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close()
		if err != nil {
			t.Error("could not clean up owned process QA schema")
		}
	})
	return &Store{db: pool}
}

func TestProcessTimelineDatabaseRoundTripAndHistory(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	const user = "timeline-qa"
	const provider = "11111111-1111-4111-8111-111111111111"
	const modelID = "22222222-2222-4222-8222-222222222222"
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,'QA','not-a-login')`, []any{user}},
		{`INSERT INTO providers(id,name,base_url,api_key) VALUES($1,'QA','http://127.0.0.1','not-a-key')`, []any{provider}},
		{`INSERT INTO models(id,provider_id,name,model) VALUES($1,$2,'QA model','fixture')`, []any{modelID, provider}},
	} {
		if _, err := s.db.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	session, err := s.CreateSession(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	const runID = "55555555-5555-4555-8555-555555555555"
	queued, err := s.EnqueueRun(ctx, PendingRun{RunID: runID, SessionID: session.ID, UserID: user, Message: "Read a file", ModelID: modelID, ModelName: "QA model"}, false)
	if err != nil || queued.Timeline == nil || len(queued.Timeline) != 0 {
		t.Fatalf("queued run lacks exact [] contract: %v %+v", err, queued)
	}
	readQueued, err := s.GetRun(ctx, user, runID)
	if err != nil || readQueued.Timeline == nil || queued.CreatedAt.IsZero() || !readQueued.CreatedAt.Equal(queued.CreatedAt) {
		t.Fatal("queue did not persist exact timeline support")
	}
	snapshot, canonical, err := s.CreateConfiguredRun(ctx, user, session.ID, "Read a file", runID, Model{ID: modelID, Name: "QA model", ProviderID: provider}, "", "", nil)
	if err != nil || snapshot.Timeline == nil || len(canonical) != 1 {
		t.Fatalf("run admission changed canonical history or lost support: %v %+v", err, snapshot)
	}
	m := runtime.NewManager()
	t.Cleanup(func() { _ = m.Shutdown(ctx) })
	r := m.Restore(snapshot)
	_ = r.AppendReasoning(agent.ReasoningPart{ID: "round-1:reasoning", Kind: "reasoning", Text: "Check", Done: true})
	_ = r.Append("I will read the file.")
	_ = r.ResetOutput()
	_ = r.UpdateStep(runtime.Step{ID: "read", Name: "files_read", Status: "running", Arguments: json.RawMessage(`{"path":"file"}`)})
	checkpoint := r.Snapshot()
	if err = s.Checkpoint(ctx, checkpoint); err != nil {
		t.Fatal(err)
	}
	read, err := s.GetRun(ctx, user, runID)
	latest, latestErr := s.LatestRun(ctx, user, session.ID)
	admin, adminErr := s.AdminRun(ctx, runID)
	if err != nil || latestErr != nil || adminErr != nil || !sameProcessJSON(read.Timeline, checkpoint.Timeline) || !sameProcessJSON(latest.Timeline, checkpoint.Timeline) || !sameProcessJSON(admin.Timeline, checkpoint.Timeline) {
		t.Fatalf("checkpoint/query projections differ: get=%v latest=%v admin=%v", err, latestErr, adminErr)
	}
	stale := checkpoint
	stale.Seq--
	stale.Timeline = []runtime.ProcessEntry{}
	if err = s.Checkpoint(ctx, stale); err != nil {
		t.Fatal(err)
	}
	read, _ = s.GetRun(ctx, user, runID)
	if !sameProcessJSON(read.Timeline, checkpoint.Timeline) {
		t.Fatal("late checkpoint replaced newer process data")
	}
	_ = r.UpdateStep(runtime.Step{ID: "read", Name: "files_read", Status: "completed", Output: "file contents"})
	_ = r.Append("Final answer.")
	if err = r.Finalize(runtime.StatusCompleted, "", func(final runtime.Snapshot) error { return s.CompleteRun(ctx, final) }); err != nil {
		t.Fatal(err)
	}
	final := r.Snapshot()
	read, _ = s.GetRun(ctx, user, runID)
	if !sameProcessJSON(read.Timeline, final.Timeline) || read.Output != "Final answer." || len(read.Timeline) != 4 || !read.Timeline[3].Final {
		t.Fatal("final save lost the stable answer block or process")
	}
	messages, err := s.Messages(ctx, user, session.ID)
	page, pageErr := s.MessagesPage(ctx, user, session.ID, "", 20)
	if err != nil || pageErr != nil || len(messages) != 2 || len(page) != 2 || !messages[1].HasProcess || !page[1].HasProcess {
		t.Fatalf("lazy process history not discoverable: %v %v %+v", err, pageErr, messages)
	}
	if messages[1].RunCreatedAt == nil || messages[1].RunUpdatedAt == nil || page[1].RunCreatedAt == nil || page[1].RunUpdatedAt == nil ||
		!messages[1].RunCreatedAt.Equal(final.CreatedAt) || !page[1].RunCreatedAt.Equal(final.CreatedAt) ||
		!messages[1].RunUpdatedAt.Equal(final.UpdatedAt.Truncate(time.Microsecond)) || !page[1].RunUpdatedAt.Equal(final.UpdatedAt.Truncate(time.Microsecond)) {
		t.Fatal("history does not preserve run start/end time for collapsed duration")
	}
	_, err = s.db.Exec(ctx, `UPDATE runs SET status='interrupted',seq=seq+1 WHERE id=$1`, runID)
	if err != nil {
		t.Fatal(err)
	}
	// A completed checkpoint can also be read by a fresh process with no live map.
	newManager := runtime.NewManager()
	t.Cleanup(func() { _ = newManager.Shutdown(ctx) })
	restarted, _ := s.GetRun(ctx, user, runID)
	if !sameProcessJSON(newManager.Restore(restarted).Snapshot().Timeline, final.Timeline) {
		t.Fatal("restart changed stored public progress or occurrence order")
	}
	const progressRun = "66666666-6666-4666-8666-666666666666"
	progressSnapshot, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Progress only", progressRun, Model{ID: modelID, Name: "QA model", ProviderID: provider}, "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	progress := m.Restore(progressSnapshot)
	_ = progress.Append("I finished the requested action.")
	_ = progress.ResetOutput()
	if err = progress.Finalize(runtime.StatusCompleted, "", func(final runtime.Snapshot) error { return s.CompleteRun(ctx, final) }); err != nil {
		t.Fatal(err)
	}
	page, err = s.MessagesPage(ctx, user, session.ID, "", 20)
	if err != nil || len(page) != 4 || !page[3].HasProcess || page[3].HasReasoning || page[3].StepCount != 0 || page[3].Content != "I finished the requested action." {
		t.Fatalf("completed progress-only run vanished from message history: %v %+v", err, page)
	}
	const interruptedRun = "77777777-7777-4777-8777-777777777777"
	interruptedSnapshot, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Interrupted", interruptedRun, Model{ID: modelID, Name: "QA model", ProviderID: provider}, "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := m.Restore(interruptedSnapshot)
	_ = interrupted.Append("I will check.")
	_ = interrupted.ResetOutput()
	_ = interrupted.UpdateStep(runtime.Step{ID: "exec", Name: "exec", Status: "running"})
	_ = interrupted.AppendReasoning(agent.ReasoningPart{ID: "round-2:reasoning", Kind: "reasoning", Text: "Unfinished"})
	if err = s.Checkpoint(ctx, interrupted.Snapshot()); err != nil {
		t.Fatal(err)
	}
	if err = s.recoverStartup(ctx); err != nil {
		t.Fatal(err)
	}
	read, err = s.GetRun(ctx, user, interruptedRun)
	admin, adminErr = s.AdminRun(ctx, interruptedRun)
	latest, latestErr = s.LatestRun(ctx, user, session.ID)
	if err != nil || adminErr != nil || latestErr != nil || read.Timeline[0].Text != "I will check." || read.Timeline[1].Step.Status != "failed" || !read.Timeline[2].Reasoning.Done ||
		!sameProcessJSON(read.Timeline, admin.Timeline) || !sameProcessJSON(read.Timeline, latest.Timeline) {
		t.Fatal("restarting an unfinished checkpoint lost progress or kept work active")
	}
	page, err = s.MessagesPage(ctx, user, session.ID, "", 20)
	if err != nil || len(page) != 6 || page[5].Role != "assistant" || page[5].Content != "I will check." || page[5].RunStatus != runtime.StatusInterrupted || page[5].RunError == "" {
		t.Fatalf("startup interruption did not create a visible assistant reply: %v %+v", err, page)
	}
	const pendingRun = "88888888-8888-4888-8888-888888888888"
	pendingSnapshot, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Unconfirmed output", pendingRun, Model{ID: modelID, Name: "QA model", ProviderID: provider}, "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	pending := m.Restore(pendingSnapshot)
	_ = pending.AppendText("partial", "Still checking sources", true)
	if err = pending.Finalize(runtime.StatusFailed, "stream failed", func(final runtime.Snapshot) error { return s.CompleteRun(ctx, final) }); err != nil {
		t.Fatal(err)
	}
	page, err = s.MessagesPage(ctx, user, session.ID, "", 20)
	read, runErr := s.GetRun(ctx, user, pendingRun)
	if err != nil || runErr != nil || len(page) == 0 {
		t.Fatal("could not read failed provisional output history")
	}
	last := page[len(page)-1]
	if last.Content != "Still checking sources" || last.RunError != "stream failed" || !last.HasProcess || len(read.Timeline) != 1 || !read.Timeline[0].Pending || read.Timeline[0].Text != "Still checking sources" {
		t.Fatal("failed public output/error was hidden or provisional output was marked final")
	}
	// The same read model applies to a checkpoint interrupted before CompleteRun.
	// No stored conversation or provider transcript needs to be rewritten.
	if _, err = s.db.Exec(ctx, `UPDATE messages SET content='' WHERE run_id=$1 AND role='assistant'`, pendingRun); err != nil {
		t.Fatal(err)
	}
	messages, err = s.Messages(ctx, user, session.ID)
	page, pageErr = s.MessagesPage(ctx, user, session.ID, "", 20)
	if err != nil || pageErr != nil || messages[len(messages)-1].Content != "Still checking sources" || page[len(page)-1].Content != "Still checking sources" || page[len(page)-1].RunError != "stream failed" {
		t.Fatal("history reads hid public text from the run projection")
	}
	if page[5].Content != "I will check." || page[5].RunStatus != runtime.StatusInterrupted {
		t.Fatal("starting another turn lost the interrupted checkpoint's public reply")
	}
	const answerRun = "99999999-9999-4999-8999-999999999999"
	answerSnapshot, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Direct answer", answerRun, Model{ID: modelID, Name: "QA model", ProviderID: provider}, "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	answer := m.Restore(answerSnapshot)
	_ = answer.AppendText("answer", "A direct answer.", true)
	_ = answer.CommitOutput()
	if err = answer.Finalize(runtime.StatusCompleted, "", func(final runtime.Snapshot) error { return s.CompleteRun(ctx, final) }); err != nil {
		t.Fatal(err)
	}
	page, err = s.MessagesPage(ctx, user, session.ID, "", 20)
	read, runErr = s.GetRun(ctx, user, answerRun)
	if err != nil || runErr != nil || len(page) == 0 {
		t.Fatal("could not read answer-only history")
	}
	last = page[len(page)-1]
	if last.Content != "A direct answer." || last.HasProcess || len(read.Timeline) != 1 || !read.Timeline[0].Final || read.Timeline[0].Pending {
		t.Fatal("answer-only history created an empty process disclosure or lost its final block")
	}
}

func sameProcessJSON(a, b []runtime.ProcessEntry) bool {
	first, _ := json.Marshal(a)
	second, _ := json.Marshal(b)
	var firstValue, secondValue any
	_ = json.Unmarshal(first, &firstValue)
	_ = json.Unmarshal(second, &secondValue)
	return reflect.DeepEqual(firstValue, secondValue)
}
