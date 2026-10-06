package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
)

type Artifact struct {
	ID         string                 `json:"id"`
	UserID     string                 `json:"-"`
	SessionID  string                 `json:"session_id,omitempty"`
	RunID      string                 `json:"run_id,omitempty"`
	Name       string                 `json:"name"`
	Path       string                 `json:"path"`
	MIMEType   string                 `json:"mime_type"`
	Size       int64                  `json:"size"`
	URL        string                 `json:"url"`
	CreatedAt  time.Time              `json:"created_at"`
	SourcePath string                 `json:"source_path,omitempty"`
	Version    int                    `json:"version"`
	StorageKey string                 `json:"-"`
	Generation *agent.ImageGeneration `json:"generation,omitempty"`
}

func (f Artifact) Attachment() agent.Attachment {
	return agent.Attachment{ID: f.ID, Name: f.Name, Path: f.Path, MIMEType: f.MIMEType, Size: f.Size, URL: f.URL, SourcePath: f.SourcePath, Version: f.Version, Generation: f.Generation}
}

const artifactColumns = `id::text, user_id, COALESCE(session_id::text,''), COALESCE(run_id::text,''), name, path, mime_type, size, created_at,source_path,version,storage_key,generation`

func scanArtifact(row pgx.Row) (Artifact, error) {
	var item Artifact
	var generation []byte
	err := row.Scan(&item.ID, &item.UserID, &item.SessionID, &item.RunID, &item.Name, &item.Path, &item.MIMEType, &item.Size, &item.CreatedAt, &item.SourcePath, &item.Version, &item.StorageKey, &generation)
	if err == nil && len(generation) > 0 {
		err = json.Unmarshal(generation, &item.Generation)
	}
	item.URL = artifactURL(item.ID)
	return item, err
}

func artifactURL(id string) string { return "/api/files/" + id + "/content" }

func (s *Store) SaveArtifact(ctx context.Context, item Artifact) (Artifact, error) {
	if item.SourcePath == "" {
		item.SourcePath = item.Path
	}
	generation, err := json.Marshal(item.Generation)
	if err != nil {
		return item, err
	}
	item, err = scanArtifact(s.db.QueryRow(ctx, `INSERT INTO artifacts(user_id,session_id,run_id,name,path,mime_type,size,source_path,version,storage_key,generation)
		VALUES($1,NULLIF($2,'')::uuid,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,COALESCE((SELECT max(version)+1 FROM artifacts WHERE user_id=$1 AND source_path=$8),1),$9,NULLIF($10,'null'::jsonb))
		ON CONFLICT(user_id,path) DO UPDATE SET name=EXCLUDED.name,mime_type=EXCLUDED.mime_type,
		size=EXCLUDED.size,session_id=COALESCE(EXCLUDED.session_id,artifacts.session_id),
		run_id=COALESCE(EXCLUDED.run_id,artifacts.run_id),storage_key=CASE WHEN EXCLUDED.storage_key='' THEN artifacts.storage_key ELSE EXCLUDED.storage_key END,generation=COALESCE(EXCLUDED.generation,artifacts.generation),updated_at=now()
		RETURNING `+artifactColumns, item.UserID, item.SessionID, item.RunID, item.Name, item.Path, item.MIMEType, item.Size, item.SourcePath, item.StorageKey, generation))
	item.URL = artifactURL(item.ID)
	return item, err
}

func (s *Store) GetArtifact(ctx context.Context, userID, id string) (Artifact, error) {
	item, err := scanArtifact(s.db.QueryRow(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE id=$1 AND user_id=$2`, id, userID))
	item.URL = artifactURL(item.ID)
	return item, err
}

func (s *Store) GetArtifacts(ctx context.Context, userID string, ids []string) ([]Artifact, error) {
	if len(ids) > 12 {
		return nil, fmt.Errorf("too many attachments")
	}
	items := make([]Artifact, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		item, err := s.GetArtifact(ctx, userID, id)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Store) ListArtifacts(ctx context.Context, userID string) ([]Artifact, error) {
	rows, err := s.db.Query(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Artifact{}
	for rows.Next() {
		item, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		item.URL = artifactURL(item.ID)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListRunArtifacts(ctx context.Context, userID, runID string) ([]agent.Attachment, error) {
	rows, err := s.db.Query(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE user_id=$1 AND run_id=$2 ORDER BY created_at,id`, userID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []agent.Attachment{}
	for rows.Next() {
		item, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		item.URL = artifactURL(item.ID)
		items = append(items, item.Attachment())
	}
	return items, rows.Err()
}

func (s *Store) SessionArtifacts(ctx context.Context, userID, sessionID string) ([]Artifact, error) {
	rows, err := s.db.Query(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE user_id=$1 AND session_id=$2 ORDER BY created_at`, userID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Artifact{}
	for rows.Next() {
		item, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		item.URL = artifactURL(item.ID)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SessionInputArtifacts(ctx context.Context, userID, sessionID string) ([]Artifact, error) {
	rows, err := s.db.Query(ctx, `SELECT `+artifactColumns+` FROM artifacts WHERE user_id=$1 AND EXISTS(SELECT 1 FROM messages m WHERE m.session_id=$2 AND m.role='user' AND NOT m.archived AND m.attachments @> jsonb_build_array(jsonb_build_object('id',artifacts.id::text))) ORDER BY created_at`, userID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Artifact{}
	for rows.Next() {
		item, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		item.URL = artifactURL(item.ID)
		items = append(items, item)
	}
	return items, rows.Err()
}
