package storage

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const LocalMemoryEmbeddingModelID = "local:bge-small-zh-v1.5"

var ErrEmbeddingDimensions = errors.New("embedding_dimensions_changed")

type MemoryEmbeddingTarget struct {
	ModelID  string
	Revision int64
	Identity string
}

func (target MemoryEmbeddingTarget) DimensionIdentity() string {
	return target.Identity
}

// Only the digest leaves this query; transport credentials are never projected.
// Self-validation also covers a crash between admin config save and queue wakeup.
const memoryEmbeddingTargetSQL = `SELECT COALESCE(NULLIF(a.embedding_model_id,''),'local:bge-small-zh-v1.5') AS model_id,a.embedding_revision,
 COALESCE(NULLIF(a.embedding_model_id,''),'local:bge-small-zh-v1.5')||'@'||encode(digest(jsonb_build_array(a.embedding_revision,a.embedding_model_id,m.model,m.kind,m.available,p.id,p.protocol,p.base_url,p.api_key,p.headers,p.enabled,p.allow_no_key,p.timeout_seconds)::text,'sha256'),'hex') AS target_identity
 FROM app_settings a LEFT JOIN models m ON m.id::text=a.embedding_model_id LEFT JOIN providers p ON p.id=m.provider_id WHERE a.id=true`
const memoryPendingIndexSQL = `superseded_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (embedding IS NULL OR embedding_model_id<>$2 OR embedding_revision<>$3)`

func (s *Store) MemoryEmbeddingTarget(ctx context.Context) (MemoryEmbeddingTarget, error) {
	var target MemoryEmbeddingTarget
	err := s.db.QueryRow(ctx, memoryEmbeddingTargetSQL).Scan(&target.ModelID, &target.Revision, &target.Identity)
	return target, err
}

// A content/settings mutation fences the old lease. A backlog scan may fill a
// missing job, but never reset an exhausted same-target job on every startup.
func enqueueMemoryIndexTx(ctx context.Context, tx pgx.Tx, userID string, changed bool) error {
	var target MemoryEmbeddingTarget
	if err := tx.QueryRow(ctx, memoryEmbeddingTargetSQL).Scan(&target.ModelID, &target.Revision, &target.Identity); err != nil {
		return err
	}
	var enabled bool
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT memory_enabled FROM user_preferences WHERE user_id=$1),true),COALESCE((SELECT memory_revision FROM user_preferences WHERE user_id=$1),0)`, userID).Scan(&enabled, &revision); err != nil {
		return err
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memories WHERE user_id=$1 AND `+memoryPendingIndexSQL+`)`, userID, target.Identity, target.Revision).Scan(&pending); err != nil {
		return err
	}
	if !enabled || !pending {
		status := "completed"
		if !enabled {
			status = "skipped"
		}
		_, err := tx.Exec(ctx, `UPDATE memory_index_jobs SET status=$2,memory_revision=$3,generation=generation+1,lease_token=NULL,lease_until=NULL,last_error='',updated_at=now()
 WHERE user_id=$1 AND ($4 OR status IN ('queued','leased'))`, userID, status, revision, changed)
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO memory_index_jobs(user_id,model_id,target_identity,embedding_revision,memory_revision) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id) DO UPDATE SET model_id=EXCLUDED.model_id,target_identity=EXCLUDED.target_identity,embedding_revision=EXCLUDED.embedding_revision,memory_revision=EXCLUDED.memory_revision,
 generation=memory_index_jobs.generation+1,status='queued',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,last_error='',updated_at=now()
 WHERE $6 OR memory_index_jobs.target_identity<>EXCLUDED.target_identity OR memory_index_jobs.embedding_revision<>EXCLUDED.embedding_revision
 OR memory_index_jobs.memory_revision<>EXCLUDED.memory_revision OR memory_index_jobs.status IN ('completed','skipped')`, userID, target.ModelID, target.Identity, target.Revision, revision, changed)
	return err
}

func (s *Store) EnqueueMemoryIndex(ctx context.Context, userID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = enqueueMemoryIndexTx(ctx, tx, userID, false); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Admin calls invalidate=true after an embedding slot/model/provider changes.
// The current effective-config fingerprint excludes stale vectors even before
// this enqueue. Startup scans do not revive failed work with the same target.
func (s *Store) EnqueueAllMemoryIndexes(ctx context.Context, invalidate bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if invalidate {
		if _, err = tx.Exec(ctx, `UPDATE app_settings SET embedding_revision=embedding_revision+1 WHERE id=true`); err != nil {
			return err
		}
	}
	var target MemoryEmbeddingTarget
	if err = tx.QueryRow(ctx, memoryEmbeddingTargetSQL).Scan(&target.ModelID, &target.Revision, &target.Identity); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE memory_index_jobs j SET status='skipped',generation=generation+1,lease_until=NULL,lease_token=NULL,last_error='memory_disabled',updated_at=now()
 WHERE j.status IN ('queued','leased') AND EXISTS(SELECT 1 FROM user_preferences p WHERE p.user_id=j.user_id AND NOT p.memory_enabled)`); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO memory_index_jobs(user_id,model_id,target_identity,embedding_revision,memory_revision)
 SELECT DISTINCT m.user_id,$1::text,$2::text,$3::bigint,COALESCE(p.memory_revision,0) FROM memories m LEFT JOIN user_preferences p ON p.user_id=m.user_id
 WHERE COALESCE(p.memory_enabled,true) AND m.superseded_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())
 AND (m.embedding IS NULL OR m.embedding_model_id<>$2 OR m.embedding_revision<>$3)
 ON CONFLICT(user_id) DO UPDATE SET model_id=EXCLUDED.model_id,target_identity=EXCLUDED.target_identity,embedding_revision=EXCLUDED.embedding_revision,memory_revision=EXCLUDED.memory_revision,
 generation=memory_index_jobs.generation+1,status='queued',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,last_error='',updated_at=now()
 WHERE memory_index_jobs.target_identity<>EXCLUDED.target_identity OR memory_index_jobs.embedding_revision<>EXCLUDED.embedding_revision
 OR memory_index_jobs.memory_revision<>EXCLUDED.memory_revision OR memory_index_jobs.status IN ('completed','skipped')`, target.ModelID, target.Identity, target.Revision)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type MemoryIndexJob struct {
	UserID     string
	Target     MemoryEmbeddingTarget
	Revision   int64
	Generation int64
	Attempts   int
	LeaseToken string
}

func (s *Store) ClaimMemoryIndexJob(ctx context.Context) (*MemoryIndexJob, error) {
	if _, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET status='failed',lease_until=NULL,lease_token=NULL,last_error='embedding_attempts_exhausted',updated_at=now()
 WHERE status='leased' AND lease_until<now() AND attempts>=3`); err != nil {
		return nil, err
	}
	var job MemoryIndexJob
	err := s.db.QueryRow(ctx, `WITH target AS (`+memoryEmbeddingTargetSQL+`),candidate AS (
 SELECT j.user_id FROM memory_index_jobs j LEFT JOIN user_preferences p ON p.user_id=j.user_id CROSS JOIN target t
 WHERE COALESCE(p.memory_enabled,true) AND j.memory_revision=COALESCE(p.memory_revision,0)
 AND j.target_identity=t.target_identity AND j.embedding_revision=t.embedding_revision AND j.attempts<3
 AND ((j.status='queued' AND j.next_attempt_at<=now()) OR (j.status='leased' AND j.lease_until<now()))
 ORDER BY j.next_attempt_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
 UPDATE memory_index_jobs j SET status='leased',attempts=j.attempts+1,lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),updated_at=now()
 FROM candidate c WHERE j.user_id=c.user_id RETURNING j.user_id,j.model_id,j.embedding_revision,j.target_identity,j.memory_revision,j.generation,j.attempts,j.lease_token::text`).Scan(&job.UserID, &job.Target.ModelID, &job.Target.Revision, &job.Target.Identity, &job.Revision, &job.Generation, &job.Attempts, &job.LeaseToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &job, err
}

func (s *Store) PendingMemoryIndexBatch(ctx context.Context, job MemoryIndexJob) ([]Memory, error) {
	rows, err := s.db.Query(ctx, `SELECT `+memoryColumns+` FROM memories WHERE user_id=$1 AND `+memoryPendingIndexSQL+` ORDER BY updated_at,id LIMIT 40`, job.UserID, job.Target.Identity, job.Target.Revision)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Memory{}
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

func (s *Store) CompleteMemoryIndexBatch(ctx context.Context, job MemoryIndexJob, items []Memory, vectors [][]float32) error {
	if len(items) != len(vectors) || len(items) > 40 {
		return errors.New("invalid embedding batch result")
	}
	for _, vector := range vectors {
		if len(vector) != len(vectors[0]) {
			return ErrEmbeddingDimensions
		}
		if err := ValidateMemoryVector(vector); err != nil {
			return err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Every memory mutation locks preferences before memory/job rows. Keep the
	// same order here so a manual edit cannot deadlock an in-flight batch commit.
	if _, err = tx.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING`, job.UserID); err != nil {
		return err
	}
	var enabled bool
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT memory_enabled,memory_revision FROM user_preferences WHERE user_id=$1 FOR UPDATE`, job.UserID).Scan(&enabled, &revision); err != nil {
		return err
	}
	if !enabled || revision != job.Revision {
		return ErrMemoryChanged
	}
	// Lock effective config only during this short commit, never during model
	// HTTP. Provider-before-model matches catalog refresh and cascade deletion.
	if _, err = tx.Exec(ctx, `SELECT id FROM app_settings WHERE id=true FOR SHARE`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT p.id FROM providers p WHERE p.id=(SELECT m.provider_id FROM models m WHERE m.id::text=$1) FOR SHARE OF p`, job.Target.ModelID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM models WHERE id::text=$1 FOR SHARE`, job.Target.ModelID); err != nil {
		return err
	}
	var valid bool
	err = tx.QueryRow(ctx, `WITH target AS (`+memoryEmbeddingTargetSQL+`) SELECT true FROM memory_index_jobs j LEFT JOIN user_preferences p ON p.user_id=j.user_id CROSS JOIN target t
 WHERE j.user_id=$1 AND j.lease_token=$2::uuid AND j.generation=$3 AND j.status='leased' AND j.lease_until>now()
 AND COALESCE(p.memory_enabled,true) AND COALESCE(p.memory_revision,0)=$4 AND j.memory_revision=$4
 AND t.target_identity=$5 AND t.embedding_revision=$6
 FOR UPDATE OF j`, job.UserID, job.LeaseToken, job.Generation, job.Revision, job.Target.Identity, job.Target.Revision).Scan(&valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMemoryChanged
	}
	if err != nil {
		return err
	}
	if len(vectors) > 0 {
		tag, err := tx.Exec(ctx, `INSERT INTO memory_embedding_dimensions(model_id,dimensions) VALUES($1,$2)
 ON CONFLICT(model_id) DO UPDATE SET dimensions=EXCLUDED.dimensions WHERE memory_embedding_dimensions.dimensions=EXCLUDED.dimensions`, job.Target.DimensionIdentity(), len(vectors[0]))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrEmbeddingDimensions
		}
	}
	for index, item := range items {
		if _, err = tx.Exec(ctx, `UPDATE memories SET embedding=$4::vector,embedding_model_id=$5,embedding_revision=$6 WHERE id=$1 AND user_id=$2 AND content=$3 AND `+activeMemorySQL, item.ID, job.UserID, item.Content, vectorLiteral(vectors[index]), job.Target.Identity, job.Target.Revision); err != nil {
			return err
		}
	}
	var pending bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memories WHERE user_id=$1 AND `+memoryPendingIndexSQL+`)`, job.UserID, job.Target.Identity, job.Target.Revision).Scan(&pending); err != nil {
		return err
	}
	status := "completed"
	if pending {
		status = "queued"
	}
	if _, err = tx.Exec(ctx, `UPDATE memory_index_jobs SET status=$2,attempts=0,next_attempt_at=now(),lease_until=NULL,lease_token=NULL,last_error='',updated_at=now() WHERE user_id=$1`, job.UserID, status); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FinishMemoryIndexJob(ctx context.Context, job MemoryIndexJob, indexErr error) error {
	status, category := "queued", "embedding_unavailable"
	if errors.Is(indexErr, ErrMemoryChanged) {
		status, category = "skipped", "source_or_settings_changed"
	} else if errors.Is(indexErr, ErrEmbeddingDimensions) {
		status, category = "failed", "embedding_dimensions_changed"
	} else if job.Attempts >= 3 {
		status = "failed"
	}
	_, err := s.db.Exec(ctx, `UPDATE memory_index_jobs SET status=$4,next_attempt_at=now()+$5*interval '1 second',lease_until=NULL,lease_token=NULL,last_error=$6,updated_at=now()
 WHERE user_id=$1 AND lease_token=$2::uuid AND generation=$3 AND status='leased'`, job.UserID, job.LeaseToken, job.Generation, status, float64(job.Attempts*job.Attempts*15), category)
	return err
}

type MemoryIndexJobStatus struct {
	ModelID     string    `json:"model_id"`
	Status      string    `json:"status"`
	Attempts    int       `json:"attempts"`
	LastError   string    `json:"last_error,omitempty"`
	NextAttempt time.Time `json:"next_attempt_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (s *Store) MemoryIndexJobStatus(ctx context.Context, userID string) (*MemoryIndexJobStatus, error) {
	var job MemoryIndexJobStatus
	err := s.db.QueryRow(ctx, `SELECT model_id,status,attempts,last_error,next_attempt_at,updated_at FROM memory_index_jobs WHERE user_id=$1`, userID).Scan(&job.ModelID, &job.Status, &job.Attempts, &job.LastError, &job.NextAttempt, &job.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &job, err
}
