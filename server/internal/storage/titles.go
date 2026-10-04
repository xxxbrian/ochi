package storage

import (
	"context"
	"encoding/json"
	"time"

	"ochi/server/internal/agent"
)

type TitleClaim struct {
	MessageID   string
	Prompt      string
	Attachments []agent.Attachment
	ClaimedAt   time.Time
}

// A DB claim avoids duplicate completions without introducing a worker queue.
func (s *Store) ClaimTitle(ctx context.Context, userID, sessionID string) (TitleClaim, error) {
	var claim TitleClaim
	var attachments []byte
	err := s.db.QueryRow(ctx, `UPDATE sessions s SET title_attempts=title_attempts+1,title_claimed_at=now()
 WHERE s.id=$1 AND user_id=$2 AND source='chat' AND title_source='pending' AND title_attempts<2
 AND (title_claimed_at IS NULL OR title_claimed_at<now()-interval '2 minutes')
 AND EXISTS(SELECT 1 FROM messages WHERE session_id=s.id AND role='user' AND NOT archived)
 RETURNING title_claimed_at,
 (SELECT id::text FROM messages WHERE session_id=s.id AND role='user' AND NOT archived ORDER BY created_at,id LIMIT 1),
 (SELECT content FROM messages WHERE session_id=s.id AND role='user' AND NOT archived ORDER BY created_at,id LIMIT 1),
 (SELECT attachments FROM messages WHERE session_id=s.id AND role='user' AND NOT archived ORDER BY created_at,id LIMIT 1)`, sessionID, userID).
		Scan(&claim.ClaimedAt, &claim.MessageID, &claim.Prompt, &attachments)
	if err == nil {
		err = json.Unmarshal(attachments, &claim.Attachments)
	}
	return claim, err
}

func (s *Store) PublishTitle(ctx context.Context, userID, sessionID string, claim TitleClaim, title string) error {
	_, err := s.db.Exec(ctx, `UPDATE sessions s SET title=$5,title_source='automatic',title_claimed_at=NULL
 WHERE id=$1 AND user_id=$2 AND title_source='pending' AND title_claimed_at=$3
 AND $4=(SELECT id::text FROM messages WHERE session_id=s.id AND role='user' AND NOT archived ORDER BY created_at,id LIMIT 1)`, sessionID, userID, claim.ClaimedAt, claim.MessageID, title)
	return err
}

func (s *Store) ReleaseTitle(ctx context.Context, userID, sessionID string, claim TitleClaim) error {
	_, err := s.db.Exec(ctx, `UPDATE sessions SET title_claimed_at=NULL,
 title_source=CASE WHEN title_attempts>=2 THEN 'fallback' ELSE title_source END
 WHERE id=$1 AND user_id=$2 AND title_source='pending' AND title_claimed_at=$3`, sessionID, userID, claim.ClaimedAt)
	return err
}
