package storage

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/runtime"
)

type SessionHead struct {
	Session         Session       `json:"session"`
	LatestRun       *runtime.Head `json:"latest_run"`
	HistoryRevision string        `json:"history_revision"`
	QueueRevision   string        `json:"queue_revision"`
}

// SessionHead reads metadata only. Process bodies are loaded on selection,
// changed run identity, or stream recovery rather than every polling interval.
func (s *Store) SessionHead(ctx context.Context, userID, sessionID string) (SessionHead, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return SessionHead{}, err
	}
	defer tx.Rollback(context.Background())
	var head SessionHead
	if err = scanSession(tx.QueryRow(ctx, `SELECT `+sessionColumns+` FROM sessions WHERE id=$1 AND user_id=$2`, sessionID, userID), &head.Session); err != nil {
		return SessionHead{}, err
	}
	var latest runtime.Head
	err = tx.QueryRow(ctx, `SELECT id::text,seq,status,updated_at FROM runs
 WHERE session_id=$1 AND NOT archived
 ORDER BY CASE WHEN status IN ('running','waiting_user','waiting_resource','cancelling') THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1`,
		sessionID).Scan(&latest.RunID, &latest.Seq, &latest.Status, &latest.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return SessionHead{}, err
	}
	if err == nil {
		head.LatestRun = &latest
	}
	if err = tx.QueryRow(ctx, `SELECT md5(COALESCE(string_agg(id::text||':'||seq::text,',' ORDER BY created_at,id),'')) FROM runs WHERE session_id=$1 AND status='queued'`, sessionID).Scan(&head.QueueRevision); err != nil {
		return SessionHead{}, err
	}
	// Visible history transactions touch the parent session atomically.
	// Other session edits can cause one extra refresh, never process-body reads
	// while an unchanged conversation is idle.
	head.HistoryRevision = head.Session.UpdatedAt.UTC().Format(time.RFC3339Nano)
	if err = tx.Commit(ctx); err != nil {
		return SessionHead{}, err
	}
	return head, nil
}
