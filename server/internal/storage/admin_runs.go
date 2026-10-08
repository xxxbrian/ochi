package storage

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

type AdminRunFilter struct {
	Query, Status, ModelID, UserID string
	From, To                       time.Time
	Limit, Offset                  int
}

type AdminRun struct {
	RunID         string          `json:"run_id"`
	SessionID     string          `json:"session_id"`
	SessionTitle  string          `json:"session_title"`
	Prompt        string          `json:"prompt"`
	UserID        string          `json:"user_id"`
	Username      string          `json:"username"`
	DisplayName   string          `json:"display_name"`
	Status        string          `json:"status"`
	ModelID       string          `json:"model_id"`
	ModelName     string          `json:"model_name"`
	ProviderName  string          `json:"provider_name"`
	Effort        string          `json:"effort"`
	Error         string          `json:"error,omitempty"`
	Usage         json.RawMessage `json:"usage"`
	StepCount     int             `json:"step_count"`
	ArtifactCount int             `json:"artifact_count"`
	DurationMS    int64           `json:"duration_ms"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

type AdminRunPage struct {
	Items  []AdminRun `json:"items"`
	Total  int64      `json:"total"`
	Limit  int        `json:"limit"`
	Offset int        `json:"offset"`
}

type AdminRunDetail struct {
	AdminRun
	Output    string                 `json:"output"`
	Steps     []runtime.Step         `json:"steps"`
	Reasoning []agent.ReasoningPart  `json:"reasoning"`
	Timeline  []runtime.ProcessEntry `json:"timeline"`
	Artifacts []agent.Attachment     `json:"artifacts"`
	Resource  string                 `json:"resource,omitempty"`
	Archived  bool                   `json:"archived"`
}

// The list projection never transports tool JSON, output, or full prompts.
// Detail payloads are read only when an administrator opens a row.
const adminRunJoins = ` FROM runs r JOIN sessions s ON s.id=r.session_id
 LEFT JOIN users u ON u.id=s.user_id
 LEFT JOIN models m ON m.id::text=r.model_id
 LEFT JOIN providers p ON p.id=m.provider_id
 LEFT JOIN LATERAL (SELECT content FROM messages WHERE run_id=r.id AND role='user' ORDER BY created_at,id LIMIT 1) prompt ON true
 LEFT JOIN run_requests pending ON pending.run_id=r.id `

const adminRunWhere = ` WHERE r.created_at >= $1 AND r.created_at <= $2
 AND ($3='' OR r.status=$3) AND ($4='' OR r.model_id=$4) AND ($5='' OR s.user_id=$5)
 AND ($6='' OR strpos(lower(concat_ws(' ',s.title,prompt.content,pending.message,r.model_name,u.username,u.display_name,r.error)),lower($6))>0) `

const adminRunColumns = `r.id::text,r.session_id::text,s.title,left(COALESCE(prompt.content,pending.message,''),240),
 s.user_id,COALESCE(u.username,''),COALESCE(u.display_name,''),r.status,r.model_id,r.model_name,COALESCE(p.name,''),r.effort,COALESCE(r.error,''),r.usage,
 CASE WHEN jsonb_typeof(r.steps)='array' THEN jsonb_array_length(r.steps) ELSE 0 END,
 CASE WHEN jsonb_typeof(r.artifacts)='array' THEN jsonb_array_length(r.artifacts) ELSE 0 END,
 GREATEST(0,(extract(epoch FROM (CASE WHEN r.status IN ('queued','running','waiting_user','waiting_resource','cancelling') THEN now() ELSE r.updated_at END-r.created_at))*1000)::bigint),
 r.created_at,r.updated_at`

func adminRunArgs(f AdminRunFilter) []any {
	return []any{f.From, f.To, f.Status, f.ModelID, f.UserID, f.Query}
}

func scanAdminRun(row pgx.Row, item *AdminRun) error {
	return row.Scan(&item.RunID, &item.SessionID, &item.SessionTitle, &item.Prompt,
		&item.UserID, &item.Username, &item.DisplayName, &item.Status, &item.ModelID, &item.ModelName, &item.ProviderName,
		&item.Effort, &item.Error, &item.Usage, &item.StepCount, &item.ArtifactCount, &item.DurationMS, &item.CreatedAt, &item.UpdatedAt)
}

func (s *Store) AdminRuns(ctx context.Context, f AdminRunFilter) (AdminRunPage, error) {
	page := AdminRunPage{Items: []AdminRun{}, Limit: f.Limit, Offset: f.Offset}
	args := adminRunArgs(f)
	if err := s.db.QueryRow(ctx, `SELECT count(*)`+adminRunJoins+adminRunWhere, args...).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+adminRunColumns+adminRunJoins+adminRunWhere+` ORDER BY r.created_at DESC,r.id DESC LIMIT $7 OFFSET $8`, append(args, f.Limit, f.Offset)...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item AdminRun
		if err = scanAdminRun(rows, &item); err != nil {
			return page, err
		}
		page.Items = append(page.Items, item)
	}
	return page, rows.Err()
}

func (s *Store) AdminRun(ctx context.Context, runID string) (AdminRunDetail, error) {
	var result AdminRunDetail
	if err := scanAdminRun(s.db.QueryRow(ctx, `SELECT `+adminRunColumns+adminRunJoins+` WHERE r.id=$1`, runID), &result.AdminRun); err != nil {
		return result, err
	}
	var steps, artifacts, reasoning, timeline []byte
	err := s.db.QueryRow(ctx, `SELECT r.output,r.steps,r.artifacts,r.resource,r.archived,COALESCE(prompt.content,pending.message,''),r.reasoning,r.timeline`+adminRunJoins+` WHERE r.id=$1`, runID).
		Scan(&result.Output, &steps, &artifacts, &result.Resource, &result.Archived, &result.Prompt, &reasoning, &timeline)
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(steps, &result.Steps); err != nil {
		return result, err
	}
	if err = json.Unmarshal(artifacts, &result.Artifacts); err != nil {
		return result, err
	}
	if err = json.Unmarshal(reasoning, &result.Reasoning); err != nil {
		return result, err
	}
	if len(timeline) > 0 {
		if err = json.Unmarshal(timeline, &result.Timeline); err != nil {
			return result, err
		}
	}
	final := runtime.ReconcileTerminal(runtime.Snapshot{Status: result.Status, Steps: result.Steps, Reasoning: result.Reasoning, Timeline: result.Timeline, Resource: result.Resource})
	result.Steps, result.Reasoning, result.Timeline, result.Resource = final.Steps, final.Reasoning, final.Timeline, final.Resource
	if result.Steps == nil {
		result.Steps = []runtime.Step{}
	}
	if result.Artifacts == nil {
		result.Artifacts = []agent.Attachment{}
	}
	return result, nil
}

type AdminRunTotals struct {
	Runs              int64    `json:"runs"`
	Completed         int64    `json:"completed"`
	Failed            int64    `json:"failed"`
	Interrupted       int64    `json:"interrupted"`
	Cancelled         int64    `json:"cancelled"`
	Active            int64    `json:"active"`
	PromptTokens      int64    `json:"prompt_tokens"`
	CompletionTokens  int64    `json:"completion_tokens"`
	TotalTokens       int64    `json:"total_tokens"`
	CachedTokens      *int64   `json:"cached_tokens"`
	UsageReportedRuns int64    `json:"usage_reported_runs"`
	AverageDurationMS *float64 `json:"average_duration_ms"`
}

type AdminModelUsage struct {
	ModelID          string `json:"model_id"`
	ModelName        string `json:"model_name"`
	ProviderName     string `json:"provider_name"`
	Runs             int64  `json:"runs"`
	Failed           int64  `json:"failed"`
	TotalTokens      int64  `json:"total_tokens"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CachedTokens     *int64 `json:"cached_tokens"`
}

type AdminRunStats struct {
	AdminRunTotals
	From   time.Time         `json:"from"`
	To     time.Time         `json:"to"`
	Models []AdminModelUsage `json:"models"`
}

const promptTokenSQL = `COALESCE((r.usage->>'prompt_tokens')::bigint,0)`
const completionTokenSQL = `COALESCE((r.usage->>'completion_tokens')::bigint,0)`
const totalTokenSQL = `COALESCE((r.usage->>'total_tokens')::bigint,0)`
const cachedTokenSQL = `(r.usage->>'cached_tokens')::bigint`

func (s *Store) AdminRunStats(ctx context.Context, f AdminRunFilter) (AdminRunStats, error) {
	stats := AdminRunStats{From: f.From, To: f.To, Models: []AdminModelUsage{}}
	args := adminRunArgs(f)
	err := s.db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE r.status='completed'),count(*) FILTER(WHERE r.status='failed'),
 count(*) FILTER(WHERE r.status='interrupted'),count(*) FILTER(WHERE r.status='cancelled'),
 count(*) FILTER(WHERE r.status IN ('queued','running','waiting_user','waiting_resource','cancelling')),
 COALESCE(sum(`+promptTokenSQL+`),0),COALESCE(sum(`+completionTokenSQL+`),0),COALESCE(sum(`+totalTokenSQL+`),0),sum(`+cachedTokenSQL+`),
 count(*) FILTER(WHERE `+totalTokenSQL+`>0),
 avg(GREATEST(0,extract(epoch FROM r.updated_at-r.created_at)*1000)) FILTER(WHERE r.status IN ('completed','failed','cancelled','interrupted'))`+adminRunJoins+adminRunWhere, args...).
		Scan(&stats.Runs, &stats.Completed, &stats.Failed, &stats.Interrupted, &stats.Cancelled, &stats.Active,
			&stats.PromptTokens, &stats.CompletionTokens, &stats.TotalTokens, &stats.CachedTokens, &stats.UsageReportedRuns, &stats.AverageDurationMS)
	if err != nil {
		return stats, err
	}
	rows, err := s.db.Query(ctx, `SELECT r.model_id,r.model_name,COALESCE(p.name,''),count(*),count(*) FILTER(WHERE r.status IN ('failed','interrupted')),
 COALESCE(sum(`+totalTokenSQL+`),0),COALESCE(sum(`+promptTokenSQL+`),0),COALESCE(sum(`+completionTokenSQL+`),0),sum(`+cachedTokenSQL+`)`+adminRunJoins+adminRunWhere+
		` GROUP BY r.model_id,r.model_name,p.name ORDER BY sum(`+totalTokenSQL+`) DESC NULLS LAST,count(*) DESC LIMIT 20`, args...)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	for rows.Next() {
		var item AdminModelUsage
		if err = rows.Scan(&item.ModelID, &item.ModelName, &item.ProviderName, &item.Runs, &item.Failed, &item.TotalTokens,
			&item.PromptTokens, &item.CompletionTokens, &item.CachedTokens); err != nil {
			return stats, err
		}
		stats.Models = append(stats.Models, item)
	}
	return stats, rows.Err()
}
