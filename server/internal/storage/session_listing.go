package storage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

var ErrSessionCursor = errors.New("invalid session cursor")
var sessionUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type SessionListItem struct {
	Session
	Excerpt     string `json:"excerpt,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
}

type SessionPage struct {
	Items      []SessionListItem `json:"items"`
	NextCursor string            `json:"next_cursor,omitempty"`
}

type sessionCursor struct {
	Time time.Time `json:"t"`
	ID   string    `json:"id"`
}

// The cursor carries the original sort key, not a row whose timestamp can
// change while a conversation is running.
func (s *Store) SessionsPage(ctx context.Context, userID, query, cursor, projectID string, limit int) (SessionPage, error) {
	page := SessionPage{Items: []SessionListItem{}}
	var after sessionCursor
	if cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(data, &after) != nil || after.Time.IsZero() || !sessionUUID.MatchString(after.ID) {
			return page, ErrSessionCursor
		}
	}
	if projectID != "" && !sessionUUID.MatchString(projectID) {
		return page, ErrSessionCursor
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query = strings.TrimSpace(query)
	pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query) + "%"
	rows, err := s.db.Query(ctx, `SELECT `+sessionColumns+`,
 COALESCE((SELECT substring(m.content FROM greatest(1,position(lower($2) IN lower(m.content))-36) FOR 180)
   FROM messages m WHERE m.session_id=sessions.id AND NOT m.archived AND $2<>'' AND m.content ILIKE $3
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1),''),
 COALESCE((SELECT name FROM projects WHERE id=sessions.project_id),'')
 FROM sessions WHERE user_id=$1 AND source='chat'
 AND ($2='' OR title ILIKE $3 OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id=sessions.id AND NOT m.archived AND m.content ILIKE $3))
 AND ($4='' OR (updated_at,id)<($5::timestamptz,NULLIF($4,'')::uuid))
 AND ($6='' OR project_id=NULLIF($6,'')::uuid)
 ORDER BY updated_at DESC,id DESC LIMIT $7`, userID, query, pattern, after.ID, after.Time, projectID, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item SessionListItem
		v := &item.Session
		if err := rows.Scan(&v.ID, &v.Title, &v.CreatedAt, &v.UpdatedAt, &v.ModelID, &v.Effort, &v.SystemPrompt, &v.ProjectID, &v.WorkspacePath, &v.RunStatus, &v.ActiveRunID, &v.QueuedCount, &v.ComputerEnabled, &v.TitleSource, &item.Excerpt, &item.ProjectName); err != nil {
			return page, err
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		data, _ := json.Marshal(sessionCursor{Time: last.UpdatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return page, nil
}
