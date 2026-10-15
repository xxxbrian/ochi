package storage

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type MemoryJob struct {
	RunID, UserID, SessionID string
	Revision                 int64
	Attempts                 int
	LeaseToken               string
	Extraction               json.RawMessage
}

// CompleteRun calls this in its existing transaction. No provider options or
// credentials enter the queue; the worker resolves the admin config at dispatch.
func enqueueMemoryJobTx(ctx context.Context, tx pgx.Tx, runID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO memory_jobs(run_id,user_id,session_id,memory_revision)
 SELECT r.id,s.user_id,s.id,COALESCE(p.memory_revision,0)
 FROM runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN user_preferences p ON p.user_id=s.user_id
 WHERE r.id=$1 AND r.status='completed' AND NOT r.archived AND COALESCE(p.memory_enabled,true)
 AND EXISTS(SELECT 1 FROM messages WHERE run_id=r.id AND role='user' AND NOT archived)
 ON CONFLICT(run_id) DO NOTHING`, runID)
	return err
}

func (s *Store) EnqueueMemoryJob(ctx context.Context, runID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = enqueueMemoryJobTx(ctx, tx, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// QueueMemoryPreservation only queues derived work from an accepted turn; it
// does not run a model or replay tools. Canonical evidence survives compaction,
// and the worker waits until the run is durably completed before extracting it.
func (s *Store) QueueMemoryPreservation(ctx context.Context, userID, runID string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO memory_jobs(run_id,user_id,session_id,memory_revision)
 SELECT r.id,s.user_id,s.id,COALESCE(p.memory_revision,0)
 FROM runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN user_preferences p ON p.user_id=s.user_id
 WHERE r.id=$1 AND s.user_id=$2 AND NOT r.archived AND r.status IN ('running','completed') AND COALESCE(p.memory_enabled,true)
 AND EXISTS(SELECT 1 FROM messages WHERE run_id=r.id AND role='user' AND NOT archived)
 ON CONFLICT(run_id) DO NOTHING`, runID, userID)
	return err
}

func (s *Store) ClaimMemoryJob(ctx context.Context) (*MemoryJob, error) {
	// Crashed/cancelled/revised agent runs are never resumed by this queue.
	if _, err := s.db.Exec(ctx, `UPDATE memory_jobs j SET status='skipped',lease_until=NULL,lease_token=NULL,extraction=NULL,last_error='source or memory settings changed',updated_at=now()
 FROM runs r LEFT JOIN user_preferences p ON p.user_id=(SELECT user_id FROM sessions WHERE id=r.session_id)
 WHERE j.run_id=r.id AND j.status IN ('queued','leased')
 AND (r.archived OR r.status IN ('failed','cancelled','interrupted') OR NOT COALESCE(p.memory_enabled,true) OR j.memory_revision<>COALESCE(p.memory_revision,0))`); err != nil {
		return nil, err
	}
	var job MemoryJob
	err := s.db.QueryRow(ctx, `WITH candidate AS (
 SELECT j.run_id FROM memory_jobs j JOIN runs r ON r.id=j.run_id
 WHERE r.status='completed' AND NOT r.archived AND j.attempts<3
 AND ((j.status='queued' AND j.next_attempt_at<=now()) OR (j.status='leased' AND j.lease_until<now()))
 ORDER BY j.created_at,j.run_id FOR UPDATE OF j SKIP LOCKED LIMIT 1)
 UPDATE memory_jobs j SET status='leased',attempts=j.attempts+1,lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),updated_at=now()
 FROM candidate c WHERE j.run_id=c.run_id
 RETURNING j.run_id::text,j.user_id,j.session_id::text,j.memory_revision,j.attempts,j.lease_token::text,j.extraction`).Scan(&job.RunID, &job.UserID, &job.SessionID, &job.Revision, &job.Attempts, &job.LeaseToken, &job.Extraction)
	if errors.Is(err, pgx.ErrNoRows) {
		// A third crashed lease is a visible failed job, not an infinite zombie.
		_, err = s.db.Exec(ctx, `UPDATE memory_jobs SET status='failed',lease_until=NULL,lease_token=NULL,extraction=NULL,last_error='extraction attempts exhausted after lease expiry',updated_at=now()
 WHERE status='leased' AND lease_until<now() AND attempts>=3`)
		return nil, err
	}
	return &job, err
}

func (s *Store) SaveMemoryExtraction(ctx context.Context, job MemoryJob, payload json.RawMessage) error {
	if !json.Valid(payload) || len(payload) > 32*1024 {
		return errors.New("invalid bounded memory extraction")
	}
	tag, err := s.db.Exec(ctx, `UPDATE memory_jobs SET extraction=$3,updated_at=now() WHERE run_id=$1 AND lease_token=NULLIF($2,'')::uuid AND status='leased'`, job.RunID, job.LeaseToken, payload)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrMemoryChanged
	}
	return nil
}

func (s *Store) FinishMemoryJob(ctx context.Context, job MemoryJob, extractionErr error) error {
	status, message := "completed", ""
	delay := time.Duration(0)
	if extractionErr != nil {
		// Error text is deliberately categorical; provider responses may contain
		// personal data or credentials and do not belong in a durable status row.
		status, message = "queued", "memory extraction or indexing failed"
		delay = time.Duration(job.Attempts*job.Attempts) * 15 * time.Second
		if errors.Is(extractionErr, ErrMemoryChanged) || errors.Is(extractionErr, ErrMemorySource) {
			status, message = "skipped", "source or memory settings changed"
		} else if job.Attempts >= 3 {
			status = "failed"
		}
	}
	_, err := s.db.Exec(ctx, `UPDATE memory_jobs SET status=$3,next_attempt_at=now()+$4*interval '1 second',lease_until=NULL,lease_token=NULL,last_error=$5,
 extraction=CASE WHEN $3='queued' THEN extraction ELSE NULL END,updated_at=now()
 WHERE run_id=$1 AND lease_token=NULLIF($2,'')::uuid AND status='leased'`, job.RunID, job.LeaseToken, status, delay.Seconds(), message)
	return err
}

type MemoryJobStatus struct {
	RunID       string    `json:"run_id"`
	Status      string    `json:"status"`
	Attempts    int       `json:"attempts"`
	LastError   string    `json:"last_error,omitempty"`
	NextAttempt time.Time `json:"next_attempt_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (s *Store) MemoryJobs(ctx context.Context, userID string) ([]MemoryJobStatus, error) {
	rows, err := s.db.Query(ctx, `SELECT run_id::text,status,attempts,last_error,next_attempt_at,updated_at FROM memory_jobs WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 30`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []MemoryJobStatus{}
	for rows.Next() {
		var item MemoryJobStatus
		if err := rows.Scan(&item.RunID, &item.Status, &item.Attempts, &item.LastError, &item.NextAttempt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
