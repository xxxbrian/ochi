package storage

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"time"

	"ochi/server/internal/runtime"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

var ErrActiveRun = errors.New("当前对话正在运行")

type Store struct{ db *pgxpool.Pool }

type Session struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	TitleSource     string    `json:"title_source"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	ModelID         string    `json:"model_id,omitempty"`
	Effort          string    `json:"effort"`
	SystemPrompt    string    `json:"-"`
	ProjectID       string    `json:"project_id,omitempty"`
	WorkspacePath   string    `json:"workspace_path"`
	RunStatus       string    `json:"run_status,omitempty"`
	ActiveRunID     string    `json:"active_run_id,omitempty"`
	QueuedCount     int       `json:"queued_count"`
	ComputerEnabled bool      `json:"computer_enabled"`
}

type Message struct {
	ID           string          `json:"id"`
	RunID        *string         `json:"run_id,omitempty"`
	RunStatus    string          `json:"run_status,omitempty"`
	RunError     string          `json:"run_error,omitempty"`
	RunCreatedAt *time.Time      `json:"run_created_at,omitempty"`
	RunUpdatedAt *time.Time      `json:"run_updated_at,omitempty"`
	Role         string          `json:"role"`
	Content      string          `json:"content"`
	StepCount    int             `json:"step_count"`
	HasReasoning bool            `json:"has_reasoning"`
	HasProcess   bool            `json:"has_process"`
	CreatedAt    time.Time       `json:"created_at"`
	ModelID      string          `json:"model_id,omitempty"`
	ModelName    string          `json:"model_name,omitempty"`
	Effort       string          `json:"effort,omitempty"`
	Attachments  json.RawMessage `json:"attachments"`
}

func Open(ctx context.Context, url string) (*Store, error) {
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, err
	}
	store := &Store{db: db}
	if err := store.initialize(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.recoverStartup(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) recoverStartup(ctx context.Context) error {
	// A browser reconnect is supported, but process restart is not automatic
	// agent resumption. Persist that distinction rather than leaving runs stuck.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	rows, err := tx.Query(ctx, `UPDATE runs r SET status='interrupted',error='server stopped before the run completed',updated_at=now(),seq=seq+1
 WHERE status IN ('running','cancelling','waiting_user','waiting_resource') AND NOT EXISTS(SELECT 1 FROM run_requests q WHERE q.run_id=r.id)
 RETURNING `+runColumns)
	if err != nil {
		return err
	}
	var interrupted []runtime.Snapshot
	for rows.Next() {
		snapshot, scanErr := scanRun(rows)
		if scanErr != nil {
			rows.Close()
			return scanErr
		}
		interrupted = append(interrupted, snapshot)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// A checkpoint has no assistant history row yet. Finalize its public
	// projection atomically with interruption so later turns cannot hide it.
	for _, snapshot := range interrupted {
		if err = completeRunTx(ctx, tx, snapshot); err != nil {
			return err
		}
	}
	// A request is deleted in the same transaction that appends its canonical
	// user turn. A claimed-but-not-admitted input is therefore safe to requeue.
	if _, err = tx.Exec(ctx, `UPDATE runs SET status='queued',error=NULL,resource='',updated_at=now(),seq=seq+1 WHERE status IN ('running','cancelling','waiting_user','waiting_resource','interrupted') AND EXISTS(SELECT 1 FROM run_requests q WHERE q.run_id=runs.id)`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Close() { s.db.Close() }

func (s *Store) initialize(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var initialized bool
	if err = tx.QueryRow(ctx, `SELECT to_regclass(format('%I.sessions',current_schema())) IS NOT NULL`).Scan(&initialized); err != nil {
		return err
	}
	// Existing deployments are updated explicitly, never by replaying old designs.
	if !initialized {
		if _, err = tx.Exec(ctx, schemaSQL); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

const sessionColumns = `id::text,title,created_at,updated_at,COALESCE(model_id::text,''),effort,system_prompt,COALESCE(project_id::text,''),workspace_path,
 COALESCE((SELECT status FROM runs WHERE session_id=sessions.id AND NOT archived ORDER BY CASE WHEN status IN ('running','waiting_user','waiting_resource','cancelling') THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1),''),
 COALESCE((SELECT id::text FROM runs WHERE session_id=sessions.id AND status IN ('running','waiting_user','waiting_resource','cancelling') LIMIT 1),''),
 (SELECT count(*) FROM runs WHERE session_id=sessions.id AND status='queued'),computer_enabled,title_source`

func scanSession(row pgx.Row, session *Session) error {
	return row.Scan(&session.ID, &session.Title, &session.CreatedAt, &session.UpdatedAt, &session.ModelID, &session.Effort, &session.SystemPrompt, &session.ProjectID, &session.WorkspacePath, &session.RunStatus, &session.ActiveRunID, &session.QueuedCount, &session.ComputerEnabled, &session.TitleSource)
}

func (s *Store) CreateSession(ctx context.Context, userID string, projectIDs ...string) (Session, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(context.Background())
	var projectID, path string
	if len(projectIDs) > 0 {
		projectID = projectIDs[0]
	}
	if projectID != "" {
		if err = tx.QueryRow(ctx, `SELECT workspace_path FROM projects WHERE id=$1 AND user_id=$2`, projectID, userID).Scan(&path); err != nil {
			return Session{}, err
		}
	}
	var id string
	if err = tx.QueryRow(ctx, `INSERT INTO sessions(user_id,title,project_id,workspace_path,computer_enabled) VALUES($1,'新对话',NULLIF($2,'')::uuid,$3,CASE WHEN $2<>'' THEN true ELSE COALESCE((SELECT computer_default FROM user_preferences WHERE user_id=$1),false) END) RETURNING id::text`, userID, projectID, path).Scan(&id); err != nil {
		return Session{}, err
	}
	if path == "" {
		if _, err = tx.Exec(ctx, `UPDATE sessions SET workspace_path='/data/work/'||to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD-HH24MI')||'-'||id::text WHERE id=$1`, id); err != nil {
			return Session{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return s.GetSession(ctx, userID, id)
}

func (s *Store) ListSessions(ctx context.Context, userID string) ([]Session, error) {
	return s.SearchSessions(ctx, userID, "", "", 200)
}

func (s *Store) GetSession(ctx context.Context, userID, sessionID string) (Session, error) {
	var session Session
	err := scanSession(s.db.QueryRow(ctx, `SELECT `+sessionColumns+` FROM sessions WHERE id=$1 AND user_id=$2`, sessionID, userID), &session)
	return session, err
}

func (s *Store) LatestRun(ctx context.Context, userID, sessionID string) (*runtime.Snapshot, error) {
	snapshot, err := scanRun(s.db.QueryRow(ctx, `SELECT `+runColumns+`
		FROM runs r JOIN sessions s ON s.id=r.session_id
		WHERE r.session_id=$1 AND s.user_id=$2 AND NOT r.archived ORDER BY CASE WHEN r.status IN ('running','waiting_user','waiting_resource','cancelling') THEN 0 WHEN r.status='queued' THEN 1 ELSE 2 END,r.created_at DESC, r.id DESC LIMIT 1`, sessionID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// CompleteRun commits the visible final reply separately from the complete
// canonical tool transcript, whose messages are checkpointed during execution.
func (s *Store) CompleteRun(ctx context.Context, snapshot runtime.Snapshot) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = completeRunTx(ctx, tx, snapshot); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func completeRunTx(ctx context.Context, tx pgx.Tx, snapshot runtime.Snapshot) error {
	steps, err := json.Marshal(snapshot.Steps)
	if err != nil {
		return err
	}
	usage, _ := json.Marshal(snapshot.Usage)
	waiting, _ := json.Marshal(snapshot.WaitingInput)
	artifacts, _ := json.Marshal(snapshot.Artifacts)
	reasoning, _ := json.Marshal(snapshot.Reasoning)
	timeline, err := marshalTimeline(snapshot.Timeline)
	if err != nil {
		return err
	}
	if snapshot.Reasoning == nil {
		reasoning = []byte("[]")
	}
	var sessionID string
	err = tx.QueryRow(ctx, `UPDATE runs SET status=$2,error=NULLIF($3,''),output=$4,steps=$5,seq=$6,updated_at=$7,usage=$8,waiting_input=$9,artifacts=$10,resource=$11,computer_granted=$12,reasoning=$13,timeline=$14 WHERE id=$1 AND seq<=$6 RETURNING session_id::text`, snapshot.RunID, snapshot.Status, snapshot.Error, snapshot.Output, steps, snapshot.Seq, snapshot.UpdatedAt, usage, waiting, artifacts, snapshot.Resource, snapshot.ComputerGranted, reasoning, timeline).Scan(&sessionID)
	if err != nil {
		return err
	}
	if snapshot.Output != "" || len(snapshot.Artifacts) > 0 || len(snapshot.Timeline) > 0 || len(snapshot.Steps) > 0 || len(snapshot.Reasoning) > 0 || snapshot.Status == runtime.StatusFailed || snapshot.Status == runtime.StatusInterrupted || snapshot.Status == runtime.StatusCancelled {
		content := runtime.PublicReply(snapshot)
		_, err = tx.Exec(ctx, `INSERT INTO messages (session_id,run_id,role,content,model_id,model_name,effort,attachments) VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7)
   ON CONFLICT (run_id) WHERE role='assistant' DO UPDATE SET content=EXCLUDED.content,attachments=EXCLUDED.attachments`, sessionID, snapshot.RunID, content, snapshot.ModelID, snapshot.ModelName, snapshot.Effort, artifacts)
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET updated_at=now() WHERE id=$1`, sessionID); err != nil {
		return err
	}
	if err = queueLateInstructionsTx(ctx, tx, snapshot.RunID); err != nil {
		return err
	}
	if snapshot.Status == runtime.StatusCompleted {
		if err = enqueueMemoryJobTx(ctx, tx, snapshot.RunID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetRun(ctx context.Context, userID, runID string) (runtime.Snapshot, error) {
	snapshot, err := scanRun(s.db.QueryRow(ctx, `SELECT `+runColumns+`
		FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 AND s.user_id=$2`, runID, userID))
	if err != nil {
		return runtime.Snapshot{}, err
	}
	return snapshot, nil
}

func (s *Store) Messages(ctx context.Context, userID, sessionID string) ([]Message, error) {
	if _, err := s.GetSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT m.id::text, m.run_id::text, m.role, m.content, m.created_at,
		CASE WHEN m.role='assistant' THEN COALESCE(jsonb_array_length(r.steps),0) ELSE 0 END, m.model_id, m.model_name, m.effort, m.attachments,
		CASE WHEN m.role='assistant' THEN COALESCE(jsonb_array_length(r.reasoning)>0,false) ELSE false END,
		CASE WHEN m.role='assistant' THEN COALESCE(r.status,'') ELSE '' END,
		`+messageProcessSQL+`,r.created_at,r.updated_at,`+messagePublicSQL+`
		FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.session_id=$1 AND NOT m.archived
		ORDER BY m.created_at, CASE WHEN m.role='user' THEN 0 ELSE 1 END, m.id`, sessionID)
	if err != nil {
		return nil, err
	}
	return collectMessages(rows)
}

func collectMessages(rows pgx.Rows) ([]Message, error) {
	defer rows.Close()
	items := make([]Message, 0)
	for rows.Next() {
		var item Message
		var output string
		var publicJSON []byte
		if err := rows.Scan(&item.ID, &item.RunID, &item.Role, &item.Content, &item.CreatedAt, &item.StepCount, &item.ModelID, &item.ModelName, &item.Effort, &item.Attachments, &item.HasReasoning, &item.RunStatus, &item.HasProcess, &item.RunCreatedAt, &item.RunUpdatedAt, &item.RunError, &output, &publicJSON); err != nil {
			return nil, err
		}
		if item.Role == "assistant" && runtime.IsTerminal(item.RunStatus) {
			var timeline []runtime.ProcessEntry
			if err := json.Unmarshal(publicJSON, &timeline); err != nil {
				return nil, err
			}
			item.Content = runtime.PublicReply(runtime.Snapshot{Status: item.RunStatus, Output: output, Timeline: timeline})
		}
		if item.Role != "assistant" {
			item.RunError = ""
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
