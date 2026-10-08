package storage

import (
	"context"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
)

type Project struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Instructions  string    `json:"instructions"`
	WorkspacePath string    `json:"workspace_path"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	SessionCount  int       `json:"session_count"`
}

const projectColumns = `id::text,name,instructions,workspace_path,created_at,updated_at,(SELECT count(*) FROM sessions WHERE project_id=projects.id AND source='chat')`

func scanProject(row pgx.Row, v *Project) error {
	return row.Scan(&v.ID, &v.Name, &v.Instructions, &v.WorkspacePath, &v.CreatedAt, &v.UpdatedAt, &v.SessionCount)
}

func projectSlug(name string) string {
	var s strings.Builder
	for _, r := range strings.ToLower(name) {
		if r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			s.WriteRune(r)
		} else if s.Len() > 0 && !strings.HasSuffix(s.String(), "-") {
			s.WriteByte('-')
		}
		if s.Len() >= 48 {
			break
		}
	}
	slug := strings.Trim(s.String(), "-")
	if slug == "" {
		slug = "project"
	}
	return slug
}

func (s *Store) SaveProject(ctx context.Context, userID string, v Project) (Project, error) {
	if v.ID == "" {
		err := s.db.QueryRow(ctx, `INSERT INTO projects(id,user_id,name,instructions,workspace_path) SELECT id,$1,$2,$3,'/data/projects/'||$4||'-'||id::text FROM (SELECT gen_random_uuid() AS id) identity RETURNING id::text`, userID, v.Name, v.Instructions, projectSlug(v.Name)).Scan(&v.ID)
		if err != nil {
			return v, err
		}
	} else {
		if _, err := s.db.Exec(ctx, `UPDATE projects SET name=$3,instructions=$4,updated_at=now() WHERE id=$1 AND user_id=$2`, v.ID, userID, v.Name, v.Instructions); err != nil {
			return v, err
		}
	}
	return s.Project(ctx, userID, v.ID)
}

func (s *Store) Project(ctx context.Context, userID, id string) (Project, error) {
	var v Project
	err := scanProject(s.db.QueryRow(ctx, `SELECT `+projectColumns+` FROM projects WHERE user_id=$1 AND id=$2`, userID, id), &v)
	return v, err
}

func (s *Store) Projects(ctx context.Context, userID string) ([]Project, error) {
	rows, err := s.db.Query(ctx, `SELECT `+projectColumns+` FROM projects WHERE user_id=$1 ORDER BY updated_at DESC,id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var v Project
		if err = scanProject(rows, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) DeleteProject(ctx context.Context, userID, id string) error {
	// Detaching the conversations never deletes their shared workspace files.
	result, err := s.db.Exec(ctx, `DELETE FROM projects WHERE user_id=$1 AND id=$2`, userID, id)
	if err == nil && result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}
