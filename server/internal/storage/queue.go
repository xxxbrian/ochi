package storage

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/runtime"
)

type PendingRun struct {
	RunID         string    `json:"run_id"`
	SessionID     string    `json:"session_id"`
	UserID        string    `json:"-"`
	Status        string    `json:"status"`
	Message       string    `json:"message"`
	ModelID       string    `json:"model_id"`
	ModelName     string    `json:"model_name"`
	Effort        string    `json:"effort"`
	Timezone      string    `json:"timezone"`
	AttachmentIDs []string  `json:"attachment_ids"`
	Revision      Revision  `json:"-"`
	CreatedAt     time.Time `json:"created_at"`
}

func (s *Store) EnqueueRun(ctx context.Context, v PendingRun, priority bool) (runtime.Snapshot, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return runtime.Snapshot{}, err
	}
	defer tx.Rollback(context.Background())
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, v.SessionID, v.UserID).Scan(&id); err != nil {
		return runtime.Snapshot{}, err
	}
	ids, _ := json.Marshal(v.AttachmentIDs)
	rev, _ := json.Marshal(v.Revision)
	if v.AttachmentIDs == nil {
		ids = []byte(`[]`)
	}
	var snapshot runtime.Snapshot
	err = tx.QueryRow(ctx, `INSERT INTO runs(id,session_id,status,model_id,model_name,effort,timeline) VALUES($1,$2,'queued',$3,$4,$5,'[]'::jsonb) RETURNING id::text,session_id::text,status,seq,updated_at,created_at`, v.RunID, v.SessionID, v.ModelID, v.ModelName, v.Effort).Scan(&snapshot.RunID, &snapshot.SessionID, &snapshot.Status, &snapshot.Seq, &snapshot.UpdatedAt, &snapshot.CreatedAt)
	if err != nil {
		return snapshot, err
	}
	if v.Timezone == "" {
		v.Timezone = "UTC"
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET timezone=$2 WHERE id=$1`, v.RunID, v.Timezone); err != nil {
		return snapshot, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO run_requests(run_id,user_id,session_id,message,model_id,effort,attachment_ids,revision,created_at,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN COALESCE((SELECT min(created_at)-interval '1 millisecond' FROM run_requests WHERE session_id=$3),now()) ELSE now() END,$10)`, v.RunID, v.UserID, v.SessionID, v.Message, v.ModelID, v.Effort, ids, rev, priority, v.Timezone); err != nil {
		return snapshot, err
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET title=CASE WHEN title='新对话' AND title_source='pending' THEN left($2,60) ELSE title END,updated_at=now() WHERE id=$1`, v.SessionID, v.Message); err != nil {
		return snapshot, err
	}
	snapshot.ModelID, snapshot.ModelName, snapshot.Effort = v.ModelID, v.ModelName, v.Effort
	snapshot.Steps = []runtime.Step{}
	snapshot.Timeline = []runtime.ProcessEntry{}
	return snapshot, tx.Commit(ctx)
}

const pendingColumns = `q.run_id::text,q.session_id::text,q.user_id,r.status,q.message,q.model_id,r.model_name,q.effort,q.attachment_ids,q.revision,q.created_at,q.timezone`

func scanPending(row pgx.Row, v *PendingRun) error {
	var ids, rev []byte
	err := row.Scan(&v.RunID, &v.SessionID, &v.UserID, &v.Status, &v.Message, &v.ModelID, &v.ModelName, &v.Effort, &ids, &rev, &v.CreatedAt, &v.Timezone)
	if err == nil {
		_ = json.Unmarshal(ids, &v.AttachmentIDs)
		_ = json.Unmarshal(rev, &v.Revision)
	}
	return err
}

func (s *Store) PendingRuns(ctx context.Context, userID, sessionID string) ([]PendingRun, error) {
	if _, err := s.GetSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+pendingColumns+` FROM run_requests q JOIN runs r ON r.id=q.run_id WHERE q.user_id=$1 AND q.session_id=$2 AND r.status='queued' ORDER BY q.created_at,q.run_id`, userID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingRun{}
	for rows.Next() {
		var v PendingRun
		if err = scanPending(rows, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) ReadyQueuedSessions(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT q.session_id::text FROM run_requests q JOIN runs r ON r.id=q.run_id WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM runs active WHERE active.session_id=q.session_id AND active.status IN ('running','cancelling','waiting_user','waiting_resource'))`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) ClaimQueuedRun(ctx context.Context, sessionID string) (PendingRun, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PendingRun{}, err
	}
	defer tx.Rollback(context.Background())
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 FOR UPDATE`, sessionID).Scan(&id); err != nil {
		return PendingRun{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=$1 AND status IN ('running','cancelling','waiting_user','waiting_resource'))`, sessionID).Scan(&active); err != nil {
		return PendingRun{}, err
	}
	if active {
		return PendingRun{}, ErrActiveRun
	}
	var v PendingRun
	if err = scanPending(tx.QueryRow(ctx, `SELECT `+pendingColumns+` FROM run_requests q JOIN runs r ON r.id=q.run_id WHERE q.session_id=$1 AND r.status='queued' ORDER BY q.created_at,q.run_id LIMIT 1 FOR UPDATE OF q,r`, sessionID), &v); err != nil {
		return v, err
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET status='running',seq=seq+1,updated_at=now() WHERE id=$1`, v.RunID); err != nil {
		return v, err
	}
	return v, tx.Commit(ctx)
}

func (s *Store) CancelPendingRun(ctx context.Context, userID, sessionID, runID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	result, err := tx.Exec(ctx, `UPDATE runs r SET status='cancelled',seq=seq+1,updated_at=now() FROM run_requests q WHERE r.id=q.run_id AND r.status='queued' AND q.user_id=$1 AND q.session_id=$2 AND r.id=$3`, userID, sessionID, runID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if _, err = tx.Exec(ctx, `DELETE FROM run_requests WHERE run_id=$1`, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) EditPendingRun(ctx context.Context, userID, sessionID, runID, message, modelID, modelName, effort string) (PendingRun, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PendingRun{}, err
	}
	defer tx.Rollback(context.Background())
	var status string
	if err = tx.QueryRow(ctx, `SELECT r.status FROM runs r JOIN run_requests q ON r.id=q.run_id WHERE q.user_id=$1 AND q.session_id=$2 AND r.id=$3 FOR UPDATE OF q,r`, userID, sessionID, runID).Scan(&status); err != nil {
		return PendingRun{}, err
	}
	if status != "queued" {
		return PendingRun{}, errors.New("消息已开始执行")
	}
	if _, err = tx.Exec(ctx, `UPDATE run_requests SET message=$2,model_id=$3,effort=$4 WHERE run_id=$1`, runID, message, modelID, effort); err != nil {
		return PendingRun{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET model_id=$2,model_name=$3,effort=$4,seq=seq+1,updated_at=now() WHERE id=$1`, runID, modelID, modelName, effort); err != nil {
		return PendingRun{}, err
	}
	var v PendingRun
	if err = scanPending(tx.QueryRow(ctx, `SELECT `+pendingColumns+` FROM run_requests q JOIN runs r ON r.id=q.run_id WHERE q.run_id=$1`, runID), &v); err != nil {
		return v, err
	}
	return v, tx.Commit(ctx)
}

func (s *Store) DiscardRunRequest(ctx context.Context, runID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM run_requests WHERE run_id=$1`, runID)
	return err
}
