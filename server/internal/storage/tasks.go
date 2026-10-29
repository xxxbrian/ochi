package storage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/agent"
	"ochi/server/internal/i18n"
	"ochi/server/internal/runtime"
)

type TaskCriterion struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Target string `json:"target"`
}

type TaskEvidence struct {
	ID        string    `json:"id"`
	Passed    bool      `json:"passed"`
	Source    string    `json:"source"`
	Detail    string    `json:"detail"`
	RunID     string    `json:"run_id"`
	CheckedAt time.Time `json:"checked_at"`
}

type TaskConstraint struct {
	Text          string `json:"text"`
	SourceExcerpt string `json:"source_excerpt"`
	SourceRunID   string `json:"source_run_id,omitempty"`
}

type TaskState struct {
	SourceRunID  string           `json:"source_run_id"`
	Objective    string           `json:"objective"`
	Constraints  []TaskConstraint `json:"constraints"`
	Done         []string         `json:"done"`
	Remaining    []string         `json:"remaining"`
	Acceptance   []TaskCriterion  `json:"acceptance"`
	Verification []TaskEvidence   `json:"verification"`
	Status       string           `json:"status"`
	Revision     int64            `json:"revision"`
}

func ValidateTask(v TaskState) error {
	if strings.TrimSpace(v.Objective) == "" || len(v.Objective) > 3000 {
		return i18n.New("task_objective_invalid")
	}
	for _, list := range [][]string{v.Done, v.Remaining} {
		if len(list) > 24 {
			return i18n.New("task_list_too_long")
		}
		for _, item := range list {
			if strings.TrimSpace(item) == "" || len(item) > 1000 {
				return i18n.New("task_item_invalid")
			}
		}
	}
	if len(v.Constraints) > 24 {
		return i18n.New("task_list_too_long")
	}
	for _, constraint := range v.Constraints {
		if strings.TrimSpace(constraint.Text) == "" || len(constraint.Text) > 1000 || strings.TrimSpace(constraint.SourceExcerpt) == "" || len(constraint.SourceExcerpt) > 3000 {
			return i18n.New("task_item_invalid")
		}
	}
	if len(v.Acceptance) > 16 {
		return i18n.New("task_checks_limit")
	}
	ids := map[string]bool{}
	for _, c := range v.Acceptance {
		if c.ID == "" || len(c.ID) > 80 || ids[c.ID] || c.Target == "" || len(c.Target) > 3000 {
			return i18n.New("task_check_invalid")
		}
		ids[c.ID] = true
		switch c.Kind {
		case "artifact_exists", "file_exists", "command_success", "test_success":
		default:
			return i18n.New("task_check_unsupported")
		}
	}
	data, _ := json.Marshal(v)
	if len(data) > 18000 {
		return i18n.New("task_record_too_large")
	}
	return nil
}

func (s *Store) Task(ctx context.Context, userID, sessionID string) (*TaskState, error) {
	if _, err := s.GetSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	var data []byte
	var rev int64
	err := s.db.QueryRow(ctx, `SELECT state,revision FROM session_tasks WHERE session_id=$1 AND user_id=$2`, sessionID, userID).Scan(&data, &rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var v TaskState
	err = json.Unmarshal(data, &v)
	v.Revision = rev
	return &v, err
}

// Model updates cannot supply verification or mark their own task complete.
func (s *Store) SaveTask(ctx context.Context, userID, sessionID, runID string, v TaskState, expected int64, replace bool) (TaskState, error) {
	if err := ValidateTask(v); err != nil {
		return TaskState{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TaskState{}, err
	}
	defer tx.Rollback(context.Background())
	var id string
	if err = tx.QueryRow(ctx, `SELECT s.id::text FROM sessions s JOIN runs r ON r.session_id=s.id WHERE s.id=$1 AND s.user_id=$2 AND r.id=$3 AND r.status IN ('running','waiting_user','waiting_resource') FOR UPDATE OF s`, sessionID, userID, runID).Scan(&id); err != nil {
		return TaskState{}, err
	}
	var old []byte
	var revision int64
	err = tx.QueryRow(ctx, `SELECT state,revision FROM session_tasks WHERE session_id=$1 FOR UPDATE`, sessionID).Scan(&old, &revision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TaskState{}, err
	}
	if expected != revision {
		return TaskState{}, i18n.New("task_revision_changed")
	}
	var previous TaskState
	if len(old) > 0 {
		if err = json.Unmarshal(old, &previous); err != nil {
			return TaskState{}, err
		}
	}
	if len(old) > 0 && !replace {
		if v.Objective != previous.Objective {
			return TaskState{}, i18n.New("task_objective_changed")
		}
	}
	v.SourceRunID = runID
	if !replace && previous.SourceRunID != "" {
		v.SourceRunID = previous.SourceRunID
	}
	for index := range v.Constraints {
		constraint := &v.Constraints[index]
		retained := false
		if !replace {
			for _, old := range previous.Constraints {
				if *constraint == old {
					retained = true
					break
				}
			}
		}
		if retained {
			continue
		}
		// New or changed constraints need a current accepted user source. Full-state
		// replacement can remove/supersede constraints without a second stale ledger.
		if constraint.SourceRunID != "" && constraint.SourceRunID != runID {
			return TaskState{}, i18n.New("task_item_invalid")
		}
		evidence := Memory{Kind: "fact", Source: "agent", SourceSessionID: sessionID, SourceRunID: runID, SourceExcerpt: constraint.SourceExcerpt}
		if err = validateMemorySourceTx(ctx, tx, userID, evidence); err != nil {
			if errors.Is(err, ErrMemorySource) {
				return TaskState{}, i18n.New("task_item_invalid")
			}
			return TaskState{}, err
		}
		constraint.SourceRunID = runID
	}
	v.Status, v.Verification, v.Revision = "active", nil, revision+1
	data, _ := json.Marshal(v)
	_, err = tx.Exec(ctx, `INSERT INTO session_tasks(session_id,user_id,state,revision) VALUES($1,$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,updated_at=now()`, sessionID, userID, data, v.Revision)
	if err != nil {
		return TaskState{}, err
	}
	return v, tx.Commit(ctx)
}

func TaskChecksComplete(v TaskState, evidence []TaskEvidence) bool {
	if len(v.Remaining) != 0 || len(v.Acceptance) == 0 || len(evidence) != len(v.Acceptance) {
		return false
	}
	for i, c := range v.Acceptance {
		if evidence[i].ID != c.ID || !evidence[i].Passed || evidence[i].Source == "" {
			return false
		}
	}
	return true
}

func (s *Store) VerifyTask(ctx context.Context, userID, sessionID string, expected int64, evidence []TaskEvidence) (*TaskState, error) {
	v, err := s.Task(ctx, userID, sessionID)
	if err != nil || v == nil {
		return v, err
	}
	if v.Revision != expected || len(evidence) != len(v.Acceptance) {
		return nil, i18n.New("task_verification_changed")
	}
	v.Status = "active"
	if TaskChecksComplete(*v, evidence) {
		v.Status = "complete"
	}
	v.Verification = evidence
	v.Revision++
	data, _ := json.Marshal(v)
	tag, err := s.db.Exec(ctx, `UPDATE session_tasks SET state=$4,revision=revision+1,updated_at=now() WHERE session_id=$1 AND user_id=$2 AND revision=$3`, sessionID, userID, expected, data)
	if err == nil && tag.RowsAffected() == 0 {
		err = i18n.New("task_verification_changed")
	}
	return v, err
}

type RunInstruction struct {
	ID           string    `json:"id"`
	Content      string    `json:"content"`
	ClientKey    string    `json:"client_key"`
	CreatedAt    time.Time `json:"created_at"`
	CanonicalSeq *int64    `json:"canonical_seq,omitempty"`
	QueuedRunID  *string   `json:"queued_run_id,omitempty"`
	Status       string    `json:"status"`
	RunStatus    string    `json:"run_status,omitempty"`
}

var ErrRunNotSteerable = i18n.New("run_not_steerable")
var ErrInstructionInvalid = i18n.New("instruction_invalid")
var ErrInstructionConflict = i18n.New("instruction_conflict")
var ErrInstructionLimit = i18n.New("instruction_limit")

func ValidateInstruction(key, content string) error {
	if strings.TrimSpace(content) == "" || len(content) > 32000 || len(key) < 8 || len(key) > 120 {
		return ErrInstructionInvalid
	}
	return nil
}

func scanInstruction(row pgx.Row) (v RunInstruction, err error) {
	err = row.Scan(&v.ID, &v.Content, &v.ClientKey, &v.CreatedAt, &v.CanonicalSeq, &v.QueuedRunID)
	return
}

func instructionStatus(v RunInstruction, status string) RunInstruction {
	v.Status, v.RunStatus = "pending", status
	switch {
	case v.CanonicalSeq != nil:
		v.Status = "applied"
	case v.QueuedRunID != nil:
		v.Status = "queued"
	case !runtime.IsActive(status):
		v.Status = "not_applied"
	}
	return v
}

const instructionColumns = `id::text,content,client_key,created_at,canonical_seq,queued_run_id::text`

func (s *Store) AcceptInstruction(ctx context.Context, userID, runID, key, content string) (RunInstruction, error) {
	if err := ValidateInstruction(key, content); err != nil {
		return RunInstruction{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RunInstruction{}, err
	}
	defer tx.Rollback(context.Background())
	var status string
	if err = tx.QueryRow(ctx, `SELECT r.status FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 AND s.user_id=$2 AND NOT r.archived FOR UPDATE OF r`, runID, userID).Scan(&status); err != nil {
		return RunInstruction{}, err
	}
	prior, err := scanInstruction(tx.QueryRow(ctx, `SELECT `+instructionColumns+` FROM run_instructions WHERE run_id=$1 AND client_key=$2`, runID, key))
	if err == nil {
		if prior.Content != content {
			return RunInstruction{}, ErrInstructionConflict
		}
		return instructionStatus(prior, status), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return RunInstruction{}, err
	}
	if status != "running" && status != "waiting_user" && status != "waiting_resource" {
		return RunInstruction{}, ErrRunNotSteerable
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM run_instructions WHERE run_id=$1`, runID).Scan(&count); err != nil {
		return RunInstruction{}, err
	}
	if count >= 32 {
		return RunInstruction{}, ErrInstructionLimit
	}
	v, err := scanInstruction(tx.QueryRow(ctx, `INSERT INTO run_instructions(run_id,user_id,client_key,content,created_at) VALUES($1,$2,$3,$4,clock_timestamp()) RETURNING `+instructionColumns, runID, userID, key, content))
	if err != nil {
		return RunInstruction{}, err
	}
	return instructionStatus(v, status), tx.Commit(ctx)
}

func (s *Store) Instructions(ctx context.Context, userID, runID string) ([]RunInstruction, error) {
	run, err := s.GetRun(ctx, userID, runID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+instructionColumns+` FROM run_instructions WHERE run_id=$1 AND user_id=$2 ORDER BY created_at,id`, runID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RunInstruction{}
	for rows.Next() {
		v, err := scanInstruction(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, instructionStatus(v, run.Status))
	}
	return out, rows.Err()
}

// Called only outside complete model/tool groups. PostgreSQL serializes this
// with finalization and accepting input, so a crash cannot apply input twice.
func (s *Store) ConsumeInstructions(ctx context.Context, userID, sessionID, runID string) ([]agent.CanonicalMessage, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	var modelID string
	if err = tx.QueryRow(ctx, `SELECT r.model_id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 AND s.id=$2 AND s.user_id=$3 AND r.status IN ('running','waiting_user','waiting_resource') FOR UPDATE OF r`, runID, sessionID, userID).Scan(&modelID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT `+instructionColumns+` FROM run_instructions WHERE run_id=$1 AND canonical_seq IS NULL AND queued_run_id IS NULL ORDER BY created_at,id FOR UPDATE`, runID)
	if err != nil {
		return nil, err
	}
	items := []RunInstruction{}
	for rows.Next() {
		v, e := scanInstruction(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		items = append(items, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := []agent.CanonicalMessage{}
	for _, v := range items {
		payload, _ := json.Marshal(map[string]string{"role": "user", "content": v.Content})
		m := agent.CanonicalMessage{RunID: runID, ModelID: modelID, Payload: payload}
		if err = tx.QueryRow(ctx, `INSERT INTO canonical_messages(session_id,run_id,model_id,payload) VALUES($1,$2,$3,$4) RETURNING seq`, sessionID, runID, modelID, payload).Scan(&m.Seq); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE run_instructions SET canonical_seq=$2 WHERE id=$1`, v.ID, m.Seq); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, tx.Commit(ctx)
}

// Only normal completion queues input that missed its last boundary. Explicit
// cancellation, failure and crashes retain it unapplied, never restart work.
func queueLateInstructionsTx(ctx context.Context, tx pgx.Tx, runID string) error {
	_, err := tx.Exec(ctx, `WITH pending AS (
 SELECT i.id,gen_random_uuid() AS next_id,i.content,i.user_id,i.created_at,r.session_id,r.model_id,r.model_name,r.effort,r.timezone
 FROM run_instructions i JOIN runs r ON r.id=i.run_id
 WHERE i.run_id=$1 AND r.status='completed' AND i.canonical_seq IS NULL AND i.queued_run_id IS NULL
), new_runs AS (
 INSERT INTO runs(id,session_id,status,model_id,model_name,effort,timezone,items)
 SELECT next_id,session_id,'queued',model_id,model_name,effort,timezone,'[]'::jsonb FROM pending RETURNING id
), new_requests AS (
 INSERT INTO run_requests(run_id,user_id,session_id,message,model_id,effort,attachment_ids,revision,timezone,created_at)
 SELECT p.next_id,p.user_id,p.session_id,p.content,p.model_id,p.effort,'[]'::jsonb,'{}'::jsonb,p.timezone,p.created_at
 FROM pending p JOIN new_runs n ON n.id=p.next_id RETURNING run_id
)
UPDATE run_instructions i SET queued_run_id=p.next_id FROM pending p JOIN new_requests q ON q.run_id=p.next_id WHERE i.id=p.id`, runID)
	return err
}
