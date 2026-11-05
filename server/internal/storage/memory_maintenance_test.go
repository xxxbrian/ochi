package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestMemoryExtractionMaintenanceDefersWithoutExhaustingAttempts(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	if err := s.EnqueueMemoryJob(ctx, memoryQARun); err != nil {
		t.Fatal(err)
	}
	for cycle := 0; cycle < 5; cycle++ {
		job, err := s.ClaimMemoryJob(ctx)
		if err != nil || job == nil || job.Attempts != 1 {
			t.Fatalf("maintenance consumed extraction attempts: %+v, %v", job, err)
		}
		if cycle == 0 {
			if err := s.SaveMemoryExtraction(ctx, *job, json.RawMessage(`{"facts":[]}`)); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.FinishMemoryJob(ctx, *job, fmt.Errorf("account admission: %w", ErrAccountBusy)); err != nil {
			t.Fatal(err)
		}
		var queued bool
		if err := s.db.QueryRow(ctx, `SELECT status='queued' AND attempts=0 AND lease_token IS NULL AND lease_until IS NULL
 AND last_error='' AND extraction='{"facts":[]}'::jsonb AND next_attempt_at>now() FROM memory_jobs WHERE run_id=$1`, job.RunID).Scan(&queued); err != nil || !queued {
			t.Fatalf("maintenance did not release and preserve extraction: %v", err)
		}
		if next, err := s.ClaimMemoryJob(ctx); err != nil || next != nil {
			t.Fatalf("maintenance retried without a delay: %+v, %v", next, err)
		}
		if _, err := s.db.Exec(ctx, `UPDATE memory_jobs SET next_attempt_at=now() WHERE run_id=$1`, job.RunID); err != nil {
			t.Fatal(err)
		}
	}
	stale, err := s.ClaimMemoryJob(ctx)
	if err != nil || stale == nil {
		t.Fatalf("claim after maintenance: %v", err)
	}
	if _, err := s.db.Exec(ctx, `UPDATE memory_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1`, stale.RunID); err != nil {
		t.Fatal(err)
	}
	current, err := s.ClaimMemoryJob(ctx)
	if err != nil || current == nil || current.Attempts != 2 || current.LeaseToken == stale.LeaseToken {
		t.Fatalf("recover lease: %+v, %v", current, err)
	}
	if err := s.FinishMemoryJob(ctx, *stale, ErrAccountBusy); err != nil {
		t.Fatal(err)
	}
	var fenced bool
	if err := s.db.QueryRow(ctx, `SELECT status='leased' AND attempts=2 AND lease_token=$2::uuid FROM memory_jobs WHERE run_id=$1`, current.RunID, current.LeaseToken).Scan(&fenced); err != nil || !fenced {
		t.Fatalf("stale maintenance release changed current extraction lease: %v", err)
	}
	if err := s.FinishMemoryJob(ctx, *current, errors.New("controlled provider failure")); err != nil {
		t.Fatal(err)
	}
	status, err := s.MemoryJobs(ctx, memoryQAUser)
	if err != nil || len(status) != 1 || status[0].Attempts != 2 || status[0].Status != "queued" || status[0].LastError == "" {
		t.Fatalf("real extraction failure did not retain its budget: %+v, %v", status, err)
	}
}

func TestMemoryIndexMaintenanceDefersWithoutExhaustingAttempts(t *testing.T) {
	s := processTestStore(t)
	seedMemorySource(t, s)
	ctx := context.Background()
	if _, err := s.SaveMemoryRecord(ctx, memoryQAUser, Memory{Content: "Controlled indexing evidence", Source: "user", Kind: "session_summary"}); err != nil {
		t.Fatal(err)
	}
	for cycle := 0; cycle < 5; cycle++ {
		job, batch := memoryIndexBatch(t, s)
		if job.Attempts != 1 || len(batch) != 1 {
			t.Fatalf("maintenance consumed indexing attempts or evidence: %+v", job)
		}
		if err := s.FinishMemoryIndexJob(ctx, job, fmt.Errorf("account admission: %w", ErrAccountBusy)); err != nil {
			t.Fatal(err)
		}
		var queued bool
		if err := s.db.QueryRow(ctx, `SELECT status='queued' AND attempts=0 AND lease_token IS NULL AND lease_until IS NULL
 AND last_error='' AND next_attempt_at>now() FROM memory_index_jobs WHERE user_id=$1`, job.UserID).Scan(&queued); err != nil || !queued {
			t.Fatalf("maintenance did not release indexing claim: %v", err)
		}
		if next, err := s.ClaimMemoryIndexJob(ctx); err != nil || next != nil {
			t.Fatalf("maintenance retried without a delay: %+v, %v", next, err)
		}
		if _, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET next_attempt_at=now() WHERE user_id=$1`, job.UserID); err != nil {
			t.Fatal(err)
		}
	}
	current, _ := memoryIndexBatch(t, s)
	stale := current
	stale.Generation--
	if err := s.FinishMemoryIndexJob(ctx, stale, ErrAccountBusy); err != nil {
		t.Fatal(err)
	}
	stale = current
	stale.LeaseToken = "11111111-bbbb-4111-8111-111111111111"
	if err := s.FinishMemoryIndexJob(ctx, stale, ErrAccountBusy); err != nil {
		t.Fatal(err)
	}
	var fenced bool
	if err := s.db.QueryRow(ctx, `SELECT status='leased' AND attempts=1 AND lease_token=$2::uuid AND generation=$3 FROM memory_index_jobs WHERE user_id=$1`, current.UserID, current.LeaseToken, current.Generation).Scan(&fenced); err != nil || !fenced {
		t.Fatalf("stale maintenance release changed current index lease: %v", err)
	}
	if err := s.FinishMemoryIndexJob(ctx, current, errors.New("controlled embedding failure")); err != nil {
		t.Fatal(err)
	}
	status, err := s.MemoryIndexJobStatus(ctx, memoryQAUser)
	if err != nil || status == nil || status.Attempts != 1 || status.Status != "queued" || status.LastError != "embedding_unavailable" {
		t.Fatalf("real indexing failure did not consume one attempt: %+v, %v", status, err)
	}
}
