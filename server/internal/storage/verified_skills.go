package storage

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const VerifiedSkillPrefix = "private:"
const MaxVerifiedSkillBody = 16 * 1024

type VerifiedSkill struct {
	ID                 string         `json:"id"`
	Name               string         `json:"name"`
	Description        string         `json:"description"`
	Body               string         `json:"body,omitempty"`
	ProjectID          string         `json:"project_id,omitempty"`
	SourceSessionID    string         `json:"source_session_id,omitempty"`
	SourceRunID        string         `json:"source_run_id,omitempty"`
	SourceObjective    string         `json:"source_objective,omitempty"`
	SourceTaskRevision int64          `json:"source_task_revision,omitempty"`
	SourceEvidence     []TaskEvidence `json:"source_evidence,omitempty"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
}

type VerifiedSkillInput struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Body          string `json:"body"`
	ProjectScoped bool   `json:"project_scoped"`
}

var verifiedSkillName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func ValidateVerifiedSkill(v VerifiedSkillInput) error {
	if !verifiedSkillName.MatchString(v.Name) {
		return errors.New("skill name must be a lowercase slug of 1-64 letters, digits, hyphens or underscores")
	}
	if strings.TrimSpace(v.Description) == "" || len(v.Description) > 1000 {
		return errors.New("skill description must contain 1-1000 bytes")
	}
	if strings.TrimSpace(v.Body) == "" || len(v.Body) > MaxVerifiedSkillBody {
		return errors.New("skill body must contain 1-16384 bytes")
	}
	return nil
}

// Only genuine current-run checks can promote a method. Model-authored task
// progress, old successes and self-asserted prose are not verification evidence.
func VerifiedMethodEvidence(task TaskState, runID string) ([]TaskEvidence, error) {
	if runID == "" || task.Status != "complete" || !TaskChecksComplete(task, task.Verification) {
		return nil, errors.New("complete and verify the current task before promoting a skill")
	}
	kinds := make(map[string]string, len(task.Acceptance))
	for _, check := range task.Acceptance {
		kinds[check.ID] = check.Kind
	}
	evidence := []TaskEvidence{}
	for _, check := range task.Verification {
		if !check.Passed || check.RunID != runID || check.CheckedAt.IsZero() {
			continue
		}
		kind := kinds[check.ID]
		genuine := (check.Source == "recorded_exec" && (kind == "command_success" || kind == "test_success")) ||
			(check.Source == "scoped_files_list" && kind == "file_exists") ||
			(check.Source == "immutable_artifact_store" && kind == "artifact_exists")
		if genuine {
			evidence = append(evidence, check)
		}
	}
	if len(evidence) == 0 {
		return nil, errors.New("skill promotion requires a real passed command, test, file or artifact check from this run")
	}
	return evidence, nil
}

// The task and source conversation are checked inside the same transaction as
// the write, so a task update cannot race a promotion with stale evidence.
func (s *Store) PromoteVerifiedSkill(ctx context.Context, userID, sessionID, runID string, input VerifiedSkillInput) (VerifiedSkill, error) {
	if err := ValidateVerifiedSkill(input); err != nil {
		return VerifiedSkill{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return VerifiedSkill{}, err
	}
	defer tx.Rollback(context.Background())
	var projectID string
	err = tx.QueryRow(ctx, `SELECT COALESCE(s.project_id::text,'') FROM sessions s JOIN runs r ON r.session_id=s.id
		WHERE s.id=$1 AND s.user_id=$2 AND r.id=$3 AND r.status IN ('running','waiting_user','waiting_resource') FOR UPDATE OF s`, sessionID, userID, runID).Scan(&projectID)
	if err != nil {
		return VerifiedSkill{}, err
	}
	if !input.ProjectScoped {
		projectID = ""
	} else if projectID == "" {
		return VerifiedSkill{}, errors.New("a project-scoped skill requires a project conversation")
	}
	var raw []byte
	var revision int64
	err = tx.QueryRow(ctx, `SELECT state,revision FROM session_tasks WHERE session_id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID).Scan(&raw, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return VerifiedSkill{}, errors.New("no verified task is available to promote")
	}
	if err != nil {
		return VerifiedSkill{}, err
	}
	var task TaskState
	if err = json.Unmarshal(raw, &task); err != nil {
		return VerifiedSkill{}, err
	}
	evidence, err := VerifiedMethodEvidence(task, runID)
	if err != nil {
		return VerifiedSkill{}, err
	}
	proof, err := json.Marshal(evidence)
	if err != nil {
		return VerifiedSkill{}, err
	}
	var v VerifiedSkill
	err = tx.QueryRow(ctx, `INSERT INTO verified_skills(user_id,name,description,body,project_id,source_session_id,source_run_id,source_objective,source_task_revision,source_evidence)
		VALUES($1,$2,$3,$4,NULLIF($5,'')::uuid,$6,$7,$8,$9,$10)
		ON CONFLICT(user_id,name) DO UPDATE SET description=EXCLUDED.description,body=EXCLUDED.body,project_id=EXCLUDED.project_id,
		source_session_id=EXCLUDED.source_session_id,source_run_id=EXCLUDED.source_run_id,source_objective=EXCLUDED.source_objective,
		source_task_revision=EXCLUDED.source_task_revision,source_evidence=EXCLUDED.source_evidence,updated_at=now()
		RETURNING name,description,created_at,updated_at`, userID, input.Name, input.Description, input.Body, projectID, sessionID, runID, task.Objective, revision, proof).
		Scan(&v.Name, &v.Description, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return VerifiedSkill{}, err
	}
	v.ID, v.ProjectID = VerifiedSkillPrefix+v.Name, projectID
	v.SourceSessionID, v.SourceRunID, v.SourceObjective = sessionID, runID, task.Objective
	v.SourceTaskRevision, v.SourceEvidence = revision, evidence
	return v, tx.Commit(ctx)
}

// Metadata queries deliberately omit bodies. A prompt index is not an implicit
// instruction-body read, nor an administrator-wide view of private methods.
func (s *Store) VerifiedSkills(ctx context.Context, userID, projectID string, limit int) ([]VerifiedSkill, int, error) {
	if limit <= 0 || limit > 32 {
		limit = 32
	}
	rows, err := s.db.Query(ctx, `SELECT name,description,COALESCE(project_id::text,''),created_at,updated_at,count(*) OVER() FROM verified_skills
		WHERE user_id=$1 AND (project_id IS NULL OR project_id=NULLIF($2,'')::uuid) ORDER BY name LIMIT $3`, userID, projectID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var total int
	values := []VerifiedSkill{}
	for rows.Next() {
		var v VerifiedSkill
		if err := rows.Scan(&v.Name, &v.Description, &v.ProjectID, &v.CreatedAt, &v.UpdatedAt, &total); err != nil {
			return nil, 0, err
		}
		v.ID = VerifiedSkillPrefix + v.Name
		values = append(values, v)
	}
	return values, total, rows.Err()
}

func (s *Store) ReadVerifiedSkill(ctx context.Context, userID, projectID, id string) (VerifiedSkill, error) {
	name := strings.TrimPrefix(id, VerifiedSkillPrefix)
	if id == name || !verifiedSkillName.MatchString(name) {
		return VerifiedSkill{}, errors.New("invalid private skill id")
	}
	var v VerifiedSkill
	var proof []byte
	err := s.db.QueryRow(ctx, `SELECT name,description,body,COALESCE(project_id::text,''),COALESCE(source_session_id::text,''),
		COALESCE(source_run_id::text,''),source_objective,source_task_revision,source_evidence,created_at,updated_at
		FROM verified_skills WHERE user_id=$1 AND name=$2 AND (project_id IS NULL OR project_id=NULLIF($3,'')::uuid)`, userID, name, projectID).
		Scan(&v.Name, &v.Description, &v.Body, &v.ProjectID, &v.SourceSessionID, &v.SourceRunID, &v.SourceObjective, &v.SourceTaskRevision, &proof, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return VerifiedSkill{}, err
	}
	v.ID = VerifiedSkillPrefix + v.Name
	if err := json.Unmarshal(proof, &v.SourceEvidence); err != nil {
		return VerifiedSkill{}, err
	}
	return v, nil
}
