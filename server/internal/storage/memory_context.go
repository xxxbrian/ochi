package storage

import (
	"context"
	"time"
)

// An unrelated expiry may invalidate context early, but never keeps expired
// recall alive. This is metadata only: no vector query or external embedding.
func (s *Store) MemoryContextExpiry(ctx context.Context, userID, projectID string) (*time.Time, error) {
	var expires *time.Time
	err := s.db.QueryRow(ctx, `SELECT min(expires_at) FROM memories WHERE user_id=$1
 AND `+activeMemorySQL+` AND (project_id IS NULL OR project_id=NULLIF($2,'')::uuid)`, userID, projectID).Scan(&expires)
	return expires, err
}
