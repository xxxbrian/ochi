package storage

import (
	"context"
	"encoding/json"
	"errors"

	"ochi/server/internal/agent"
)

func (s *Store) SaveDiagnostic(ctx context.Context, runID string, event agent.Diagnostic) error {
	data, err := json.Marshal(event)
	if err != nil || len(data) > 8192 {
		return errors.New("invalid diagnostic record")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM runs WHERE id=$1 FOR UPDATE`, runID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO run_diagnostics(run_id,event) SELECT $1,$2 WHERE (SELECT count(*) FROM run_diagnostics WHERE run_id=$1)<128`, runID, data)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Diagnostics(ctx context.Context, userID, runID string) ([]json.RawMessage, error) {
	if _, err := s.GetRun(ctx, userID, runID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT event FROM run_diagnostics WHERE run_id=$1 ORDER BY id LIMIT 128`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var data json.RawMessage
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		out = append(out, data)
	}
	return out, rows.Err()
}

func (s *Store) SaveContextInspection(ctx context.Context, runID string, v agent.ContextInspection) error {
	data, err := json.Marshal(v)
	if err != nil || len(data) > 1200000 || len(v.Round) > 80 {
		return errors.New("context inspection is too large")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM runs WHERE id=$1 FOR UPDATE`, runID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO run_context_inspections(run_id,round,inspection)
 SELECT $1,$2,$3 WHERE (SELECT count(*) FROM run_context_inspections WHERE run_id=$1)<64
 OR EXISTS(SELECT 1 FROM run_context_inspections WHERE run_id=$1 AND round=$2)
 ON CONFLICT(run_id,round) DO UPDATE SET inspection=EXCLUDED.inspection,created_at=now()`, runID, v.Round, data)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ContextInspections(ctx context.Context, userID, runID, round string) ([]agent.ContextInspection, error) {
	if _, err := s.GetRun(ctx, userID, runID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT inspection FROM run_context_inspections WHERE run_id=$1 AND ($2='' OR round=$2) ORDER BY created_at,round LIMIT 64`, runID, round)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []agent.ContextInspection{}
	for rows.Next() {
		var data []byte
		var v agent.ContextInspection
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &v); err != nil {
			return nil, err
		}
		if round == "" {
			v.Request = nil
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
