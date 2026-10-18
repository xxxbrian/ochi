package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
)

func providerTraceFixture() agent.ProviderTrace {
	now := time.Now().UTC()
	first, token, last := now.Add(time.Millisecond), now.Add(2*time.Millisecond), now.Add(3*time.Millisecond)
	ttfb, ttft := int64(1), int64(2)
	return agent.ProviderTrace{
		ID: "11111111111141118111111111111112", RunID: "overridden-by-storage", SessionID: "session", Round: "round-2", Attempt: 2,
		Purpose: "compaction", ProviderID: "provider", ModelID: "model-id", Model: "fixture", Protocol: "openai-responses",
		Method: "POST", URL: "https://provider.invalid/responses", Stream: true,
		RequestHeaders: http.Header{"Authorization": {"[REDACTED]"}}, RequestBody: "private request body", RequestBytes: 100,
		StatusCode: 200, ResponseHeaders: http.Header{"Content-Type": {"text/event-stream"}}, RequestID: "upstream-id",
		ResponseBody: "private response body", StreamChunks: []agent.ProviderStreamChunk{{Sequence: 1, AtMS: 3, Data: "private stream chunk"}},
		ResponseBytes: 200, CapturedBytes: 200, StartedAt: now, FirstByteAt: &first, FirstTokenAt: &token, LastDataAt: &last,
		FinishedAt: now.Add(4 * time.Millisecond), DurationMS: 4, TTFBMS: &ttfb, TTFTMS: &ttft,
		FinishReason: "length", ResponseStatus: "incomplete", SawDone: true, SawCompleted: true, SawEOF: true,
		Usage:      &agent.Usage{PromptTokens: 10, CompletionTokens: 20, TotalTokens: 30},
		ErrorClass: "output_limit", Error: "fixture error", ReadError: "fixture read error", UpstreamErrorCode: "limit",
		UpstreamErrorType: "fixture", UpstreamError: "fixture upstream error", RequestTruncated: true, ResponseTruncated: true,
		Truncated: true, Redacted: true,
	}
}

func TestProviderTraceSummaryKeepsMarkersWithoutPayloads(t *testing.T) {
	trace := providerTraceFixture()
	full, err := json.Marshal(trace)
	if err != nil {
		t.Fatal(err)
	}
	light, err := json.Marshal(summarizeProviderTrace(trace))
	if err != nil {
		t.Fatal(err)
	}
	var want, got map[string]any
	if err := json.Unmarshal(full, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(light, &got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"request_headers", "request_body", "response_headers", "response_body", "stream_chunks"} {
		delete(want, key)
		if _, ok := got[key]; ok {
			t.Fatalf("summary contains payload field %s", key)
		}
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("summary lost head/timing/end/error markers: want %s, got %s", mustTraceJSON(t, want), light)
	}
}

func TestProviderTraceRejectsOversizeDetailBeforeDatabase(t *testing.T) {
	trace := providerTraceFixture()
	trace.RequestBody = strings.Repeat("x", ProviderTraceMaxDetailBytes)
	if err := (&Store{}).SaveProviderTrace(context.Background(), "", trace); !errors.Is(err, ErrProviderTraceTooLarge) {
		t.Fatalf("oversized detail did not return its explicit limit error: %v", err)
	}
}

func mustTraceJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func providerTraceTestRuns(t *testing.T, s *Store) (string, string) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.db.Exec(ctx, `INSERT INTO users(id,username,display_name,password_hash) VALUES('request-qa','request-qa','QA','not-a-login')`); err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateSession(ctx, "request-qa")
	if err != nil {
		t.Fatal(err)
	}
	a, b := "22222222-2222-4222-8222-222222222221", "22222222-2222-4222-8222-222222222222"
	if _, err := s.db.Exec(ctx, `INSERT INTO runs(id,session_id,status) VALUES($1,$3,'completed'),($2,$3,'completed')`, a, b, session.ID); err != nil {
		t.Fatal(err)
	}
	return a, b
}

func TestProviderTracePersistencePagingScopeAndDeletion(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	runA, runB := providerTraceTestRuns(t, s)
	trace := providerTraceFixture()
	if err := s.SaveProviderTrace(ctx, runA, trace); err != nil {
		t.Fatal(err)
	}
	trace.RunID = runA
	stored, err := s.ProviderTrace(ctx, runA, trace.ID)
	if err != nil || !reflect.DeepEqual(stored, trace) {
		t.Fatalf("full trace did not round trip with authoritative run scope: %v", err)
	}
	trace.Error = "updated error"
	if err := s.SaveProviderTrace(ctx, runA, trace); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListProviderTraces(ctx, runA, 30, 0)
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].Error != "updated error" {
		t.Fatalf("trace upsert duplicated or lost its summary: %+v %v", page, err)
	}
	if page.RetentionDays != 7 || page.MaxRequestsPerRun != 256 || page.Limit != 30 || page.Offset != 0 {
		t.Fatal("debug page omitted its retention/pagination contract")
	}
	probe := trace
	probe.ID, probe.StartedAt = "11111111111141118111111111111113", trace.StartedAt.Add(time.Millisecond)
	if err := s.SaveProviderTrace(ctx, "", probe); err != nil {
		t.Fatal(err)
	}
	other := trace
	other.ID, other.StartedAt = "11111111111141118111111111111114", trace.StartedAt.Add(2*time.Millisecond)
	if err := s.SaveProviderTrace(ctx, runB, other); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListProviderTraces(ctx, "", 1, 1)
	if err != nil || page.Total != 3 || len(page.Items) != 1 || page.Items[0].ID != probe.ID || page.Items[0].RunID != "" {
		t.Fatalf("global list missed nullable-run probe or stable pagination: %+v %v", page, err)
	}
	page, err = s.ListProviderTraces(ctx, "", 1, 100)
	if err != nil || page.Total != 3 || page.Items == nil || len(page.Items) != 0 {
		t.Fatal("empty page lost total or array shape", err)
	}
	if _, err := s.ProviderTrace(ctx, runB, trace.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("scoped detail accepted a different run", err)
	}
	if _, err := s.ListProviderTraces(ctx, "22222222-2222-4222-8222-222222222223", 30, 0); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("missing run list was not distinguished from empty logs", err)
	}
	if err := s.SaveDiagnostic(ctx, runA, agent.Diagnostic{Kind: "preserve", Message: "not a debug request"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProviderTraces(ctx, runA); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListProviderTraces(ctx, "", 30, 0)
	if err != nil || page.Total != 2 {
		t.Fatal("run clear deleted another run or probe", err)
	}
	var diagnostics int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM run_diagnostics WHERE run_id=$1`, runA).Scan(&diagnostics); err != nil || diagnostics != 1 {
		t.Fatal("debug clear deleted ordinary diagnostics", err)
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM runs WHERE id=$1`, runB); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProviderTrace(ctx, "", other.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("run deletion did not cascade debug detail", err)
	}
	if err := s.DeleteProviderTraces(ctx, ""); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListProviderTraces(ctx, "", 30, 0)
	if err != nil || page.Total != 0 || page.Items == nil {
		t.Fatal("global clear did not remove all debug logs", err)
	}
	var runs int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM runs WHERE id=$1`, runA).Scan(&runs); err != nil || runs != 1 {
		t.Fatal("debug clear deleted the underlying run", err)
	}
}

func TestProviderTraceRetentionAndOldestEviction(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	runID, _ := providerTraceTestRuns(t, s)
	trace := providerTraceFixture()
	trace.StartedAt = time.Now().UTC()
	if _, err := s.db.Exec(ctx, `INSERT INTO run_request_debug(id,run_id,started_at,summary,detail)
		VALUES($1,$2,now()-interval '8 days','{}','{}')`, trace.ID, runID); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListProviderTraces(ctx, runID, 30, 0)
	if err != nil || page.Total != 0 {
		t.Fatal("read exposed an expired trace before the next cleanup", err)
	}
	if _, err := s.ProviderTrace(ctx, "", trace.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("detail exposed an expired trace", err)
	}
	trace.ID = "11111111111141118111111111111115"
	if err := s.SaveProviderTrace(ctx, runID, trace); err != nil {
		t.Fatal(err)
	}
	var expired int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM run_request_debug WHERE started_at<now()-interval '7 days'`).Scan(&expired); err != nil || expired != 0 {
		t.Fatal("save did not physically prune expired detail", err)
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO run_request_debug(id,run_id,started_at,summary,detail)
		SELECT md5('run-cap-'||n)::uuid,$1,now()-n*interval '1 second','{}','{}' FROM generate_series(1,260) n`, runID); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveProviderTrace(ctx, runID, trace); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListProviderTraces(ctx, runID, 1, 0)
	if err != nil || page.Total != ProviderTraceMaxRequestsPerRun || len(page.Items) != 1 || page.Items[0].ID != trace.ID {
		t.Fatal("per-run cap dropped the newest trace or kept too many rows", err)
	}
	var old, kept bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM run_request_debug WHERE id=md5('run-cap-256')::uuid),
		EXISTS(SELECT 1 FROM run_request_debug WHERE id=md5('run-cap-255')::uuid)`).Scan(&old, &kept); err != nil || old || !kept {
		t.Fatal("per-run eviction did not remove the oldest requests", err)
	}
	if err := s.DeleteProviderTraces(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO run_request_debug(id,started_at,summary,detail)
		SELECT md5('global-cap-'||n)::uuid,now()-n*interval '1 second','{}','{}' FROM generate_series(1,2053) n`); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveProviderTrace(ctx, "", trace); err != nil {
		t.Fatal(err)
	}
	page, err = s.ListProviderTraces(ctx, "", 1, 0)
	if err != nil || page.Total != ProviderTraceMaxRequests || len(page.Items) != 1 || page.Items[0].ID != trace.ID {
		t.Fatal("global cap dropped the newest probe or kept too many rows", err)
	}
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM run_request_debug WHERE id=md5('global-cap-2048')::uuid),
		EXISTS(SELECT 1 FROM run_request_debug WHERE id=md5('global-cap-2047')::uuid)`).Scan(&old, &kept); err != nil || old || !kept {
		t.Fatal("global eviction did not remove the oldest requests", err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := trace
			v.ID, v.StartedAt = fmt.Sprintf("%032x", i+100), time.Now().UTC()
			errors <- s.SaveProviderTrace(ctx, "", v)
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err = s.ListProviderTraces(ctx, "", 1, 0)
	if err != nil || page.Total != ProviderTraceMaxRequests {
		t.Fatal("concurrent writes exceeded the global cap", err)
	}
}

func TestProviderTracePruneExpiresOnlyDebugRequestsWhileDisabled(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	runID, _ := providerTraceTestRuns(t, s)
	if enabled, err := s.DebugMode(ctx); err != nil || enabled {
		t.Fatal("prune fixture did not start with capture disabled", err)
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO run_request_debug(id,run_id,started_at,summary,detail)
		VALUES(md5('old-run')::uuid,$1,now()-interval '8 days','{}','{}'),
		(md5('fresh-run')::uuid,$1,now(),'{}','{}'),
		(md5('old-probe')::uuid,NULL,now()-interval '8 days','{}','{}'),
		(md5('fresh-probe')::uuid,NULL,now(),'{}','{}')`, runID); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveDiagnostic(ctx, runID, agent.Diagnostic{Kind: "preserve", Message: "ordinary diagnostic"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := s.PruneProviderTraces(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var expired, fresh, runs, diagnostics int
	if err := s.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM run_request_debug WHERE started_at<now()-interval '7 days'),
		(SELECT count(*) FROM run_request_debug),
		(SELECT count(*) FROM runs),
		(SELECT count(*) FROM run_diagnostics WHERE run_id=$1)`, runID).Scan(&expired, &fresh, &runs, &diagnostics); err != nil {
		t.Fatal(err)
	}
	if expired != 0 || fresh != 2 || runs != 2 || diagnostics != 1 {
		t.Fatalf("prune changed non-expired debug or run history: expired=%d fresh=%d runs=%d diagnostics=%d", expired, fresh, runs, diagnostics)
	}
}
