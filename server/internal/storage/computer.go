package storage

import "context"

func (s *Store) SetSessionComputer(ctx context.Context, userID, sessionID string, enabled, remember bool) (Session, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(context.Background())
	var projectID string
	if err = tx.QueryRow(ctx, `UPDATE sessions SET computer_enabled=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING COALESCE(project_id::text,'')`, sessionID, userID, enabled).Scan(&projectID); err != nil {
		return Session{}, err
	}
	if remember && projectID == "" {
		if _, err = tx.Exec(ctx, `INSERT INTO user_preferences(user_id,computer_default) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET computer_default=EXCLUDED.computer_default`, userID, enabled); err != nil {
			return Session{}, err
		}
	}
	if !enabled {
		if _, err = tx.Exec(ctx, `UPDATE runs SET computer_granted=false WHERE session_id=$1 AND status IN ('running','waiting_user','waiting_resource','cancelling')`, sessionID); err != nil {
			return Session{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return s.GetSession(ctx, userID, sessionID)
}
