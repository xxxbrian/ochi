package storage

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"ochi/server/internal/agent"
)

const (
	ProviderTraceRetentionDays     = 7
	ProviderTraceMaxRequestsPerRun = 256
	ProviderTraceMaxRequests       = 2048
	ProviderTraceMaxDetailBytes    = 8 << 20
)

var ErrProviderTraceTooLarge = errors.New("provider request debug detail exceeds the 8 MiB limit")

const pruneProviderTracesSQL = `DELETE FROM run_request_debug WHERE started_at < now()-make_interval(days => $1)`

// ProviderTraceSummary deliberately has no headers, bodies, or stream chunks.
// It is persisted separately so paging never reads the large detail column.
type ProviderTraceSummary struct {
	ID                string       `json:"id"`
	RunID             string       `json:"run_id,omitempty"`
	SessionID         string       `json:"session_id,omitempty"`
	Round             string       `json:"round,omitempty"`
	Attempt           int          `json:"attempt"`
	Purpose           string       `json:"purpose"`
	ProviderID        string       `json:"provider_id,omitempty"`
	ModelID           string       `json:"model_id,omitempty"`
	Model             string       `json:"model"`
	Protocol          string       `json:"protocol"`
	Method            string       `json:"method"`
	URL               string       `json:"url"`
	Stream            bool         `json:"stream"`
	RequestBytes      int64        `json:"request_bytes"`
	StatusCode        int          `json:"status_code,omitempty"`
	RequestID         string       `json:"request_id,omitempty"`
	ResponseBytes     int64        `json:"response_bytes"`
	CapturedBytes     int          `json:"captured_bytes"`
	StartedAt         time.Time    `json:"started_at"`
	FirstByteAt       *time.Time   `json:"first_byte_at,omitempty"`
	FirstTokenAt      *time.Time   `json:"first_token_at,omitempty"`
	LastDataAt        *time.Time   `json:"last_data_at,omitempty"`
	FinishedAt        time.Time    `json:"finished_at"`
	DurationMS        int64        `json:"duration_ms"`
	TTFBMS            *int64       `json:"ttfb_ms,omitempty"`
	TTFTMS            *int64       `json:"ttft_ms,omitempty"`
	FinishReason      string       `json:"finish_reason,omitempty"`
	ResponseStatus    string       `json:"response_status,omitempty"`
	SawDone           bool         `json:"saw_done"`
	SawCompleted      bool         `json:"saw_completed"`
	SawEOF            bool         `json:"saw_eof"`
	Usage             *agent.Usage `json:"usage,omitempty"`
	ErrorClass        string       `json:"error_class,omitempty"`
	Error             string       `json:"error,omitempty"`
	ReadError         string       `json:"read_error,omitempty"`
	UpstreamErrorCode string       `json:"upstream_error_code,omitempty"`
	UpstreamErrorType string       `json:"upstream_error_type,omitempty"`
	UpstreamError     string       `json:"upstream_error,omitempty"`
	RequestTruncated  bool         `json:"request_truncated"`
	ResponseTruncated bool         `json:"response_truncated"`
	Truncated         bool         `json:"truncated"`
	Redacted          bool         `json:"redacted"`
}

type ProviderTracePage struct {
	Items             []ProviderTraceSummary `json:"items"`
	Total             int                    `json:"total"`
	Limit             int                    `json:"limit"`
	Offset            int                    `json:"offset"`
	RetentionDays     int                    `json:"retention_days"`
	MaxRequestsPerRun int                    `json:"max_requests_per_run"`
}

func summarizeProviderTrace(v agent.ProviderTrace) ProviderTraceSummary {
	return ProviderTraceSummary{
		ID: v.ID, RunID: v.RunID, SessionID: v.SessionID, Round: v.Round, Attempt: v.Attempt, Purpose: v.Purpose,
		ProviderID: v.ProviderID, ModelID: v.ModelID, Model: v.Model, Protocol: v.Protocol, Method: v.Method, URL: v.URL,
		Stream: v.Stream, RequestBytes: v.RequestBytes, StatusCode: v.StatusCode, RequestID: v.RequestID,
		ResponseBytes: v.ResponseBytes, CapturedBytes: v.CapturedBytes, StartedAt: v.StartedAt, FirstByteAt: v.FirstByteAt,
		FirstTokenAt: v.FirstTokenAt, LastDataAt: v.LastDataAt, FinishedAt: v.FinishedAt, DurationMS: v.DurationMS,
		TTFBMS: v.TTFBMS, TTFTMS: v.TTFTMS, FinishReason: v.FinishReason, ResponseStatus: v.ResponseStatus,
		SawDone: v.SawDone, SawCompleted: v.SawCompleted, SawEOF: v.SawEOF, Usage: v.Usage,
		ErrorClass: v.ErrorClass, Error: v.Error, ReadError: v.ReadError, UpstreamErrorCode: v.UpstreamErrorCode,
		UpstreamErrorType: v.UpstreamErrorType, UpstreamError: v.UpstreamError, RequestTruncated: v.RequestTruncated,
		ResponseTruncated: v.ResponseTruncated, Truncated: v.Truncated, Redacted: v.Redacted,
	}
}

func (s *Store) SaveProviderTrace(ctx context.Context, runID string, trace agent.ProviderTrace) error {
	trace.RunID = runID
	detail, err := json.Marshal(trace)
	if err != nil {
		return err
	}
	if len(detail) > ProviderTraceMaxDetailBytes {
		return ErrProviderTraceTooLarge
	}
	summary, err := json.Marshal(summarizeProviderTrace(trace))
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Serialize bounded-log writes, including probes without a run, so concurrent
	// completions cannot each admit rows beyond the global/per-run limits.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891304)`); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO run_request_debug(id,run_id,started_at,summary,detail)
		VALUES($1,NULLIF($2,'')::uuid,$3,$4,$5)
		ON CONFLICT(id) DO UPDATE SET run_id=EXCLUDED.run_id,started_at=EXCLUDED.started_at,summary=EXCLUDED.summary,detail=EXCLUDED.detail`,
		trace.ID, runID, trace.StartedAt, summary, detail)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23514" && pgErr.ConstraintName == "run_request_debug_detail_size_check" {
			return ErrProviderTraceTooLarge
		}
		return err
	}
	if _, err = tx.Exec(ctx, pruneProviderTracesSQL, ProviderTraceRetentionDays); err != nil {
		return err
	}
	if runID != "" {
		if _, err = tx.Exec(ctx, `DELETE FROM run_request_debug WHERE id IN
			(SELECT id FROM run_request_debug WHERE run_id=$1 ORDER BY started_at DESC,id DESC OFFSET $2)`, runID, ProviderTraceMaxRequestsPerRun); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM run_request_debug WHERE id IN
		(SELECT id FROM run_request_debug ORDER BY started_at DESC,id DESC OFFSET $1)`, ProviderTraceMaxRequests); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PruneProviderTraces expires debug payloads even while capture is disabled.
// It never deletes run history, diagnostics, or unexpired debug requests.
func (s *Store) PruneProviderTraces(ctx context.Context) error {
	_, err := s.db.Exec(ctx, pruneProviderTracesSQL, ProviderTraceRetentionDays)
	return err
}

// Empty runID selects all debug requests, including admin connection probes.
func (s *Store) ListProviderTraces(ctx context.Context, runID string, limit, offset int) (ProviderTracePage, error) {
	page := ProviderTracePage{Items: []ProviderTraceSummary{}, Limit: limit, Offset: offset,
		RetentionDays: ProviderTraceRetentionDays, MaxRequestsPerRun: ProviderTraceMaxRequestsPerRun}
	if limit < 1 || limit > 100 || offset < 0 {
		return page, errors.New("invalid provider request debug pagination")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(context.Background())
	if err = providerTraceRunExists(ctx, tx, runID); err != nil {
		return page, err
	}
	const where = ` WHERE ($1='' OR run_id=NULLIF($1,'')::uuid) AND started_at >= now()-make_interval(days => $2)`
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM run_request_debug`+where, runID, ProviderTraceRetentionDays).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := tx.Query(ctx, `SELECT summary FROM run_request_debug`+where+` ORDER BY started_at DESC,id DESC LIMIT $3 OFFSET $4`,
		runID, ProviderTraceRetentionDays, limit, offset)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		var item ProviderTraceSummary
		if err = rows.Scan(&data); err != nil {
			return page, err
		}
		if err = json.Unmarshal(data, &item); err != nil {
			return page, err
		}
		page.Items = append(page.Items, item)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	return page, tx.Commit(ctx)
}

func (s *Store) ProviderTrace(ctx context.Context, runID, requestID string) (agent.ProviderTrace, error) {
	var data []byte
	var trace agent.ProviderTrace
	err := s.db.QueryRow(ctx, `SELECT detail FROM run_request_debug WHERE id=$1 AND ($2='' OR run_id=NULLIF($2,'')::uuid)
		AND started_at >= now()-make_interval(days => $3)`, requestID, runID, ProviderTraceRetentionDays).Scan(&data)
	if err != nil {
		return trace, err
	}
	err = json.Unmarshal(data, &trace)
	return trace, err
}

func (s *Store) DeleteProviderTraces(ctx context.Context, runID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891304)`); err != nil {
		return err
	}
	if err = providerTraceRunExists(ctx, tx, runID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM run_request_debug WHERE $1='' OR run_id=NULLIF($1,'')::uuid`, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func providerTraceRunExists(ctx context.Context, tx pgx.Tx, runID string) error {
	if runID == "" {
		return nil
	}
	var id string
	return tx.QueryRow(ctx, `SELECT id::text FROM runs WHERE id=$1`, runID).Scan(&id)
}
