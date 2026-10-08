package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

type Schedule struct {
	ID               string     `json:"id"`
	UserID           string     `json:"-"`
	SessionID        string     `json:"session_id"`
	Name             string     `json:"name"`
	Prompt           string     `json:"prompt"`
	IntervalMinutes  int        `json:"interval_minutes"`
	Recurrence       string     `json:"recurrence"`
	Timezone         string     `json:"timezone"`
	TimeOfDay        string     `json:"time_of_day"`
	Weekdays         []int      `json:"weekdays"`
	OnceAt           *time.Time `json:"once_at,omitempty"`
	ProjectID        string     `json:"project_id,omitempty"`
	ModelID          string     `json:"model_id,omitempty"`
	Effort           string     `json:"effort,omitempty"`
	ContextMode      string     `json:"context_mode"`
	Enabled          bool       `json:"enabled"`
	NextRunAt        time.Time  `json:"next_run_at"`
	LastRunAt        *time.Time `json:"last_run_at,omitempty"`
	LastRunID        string     `json:"last_run_id,omitempty"`
	LastError        string     `json:"last_error,omitempty"`
	LastStatus       string     `json:"last_status,omitempty"`
	ExecutionCount   int        `json:"execution_count"`
	CreatedAt        time.Time  `json:"created_at"`
	ExecutionID      string     `json:"-"`
	ExecutionSkipped bool       `json:"-"`
}

const scheduleColumns = `id::text,user_id,session_id::text,name,prompt,interval_minutes,enabled,next_run_at,last_run_at,COALESCE(last_run_id::text,''),last_error,created_at,recurrence,timezone,time_of_day,weekdays,once_at,COALESCE(project_id::text,''),COALESCE(model_id::text,''),effort,context_mode,COALESCE((SELECT COALESCE(r.status,e.status) FROM schedule_executions e LEFT JOIN runs r ON r.id=e.run_id WHERE e.schedule_id=schedules.id ORDER BY e.started_at DESC LIMIT 1),''),(SELECT count(*) FROM schedule_executions WHERE schedule_id=schedules.id)`

func scanSchedule(row pgx.Row) (Schedule, error) {
	var v Schedule
	var days []byte
	err := row.Scan(&v.ID, &v.UserID, &v.SessionID, &v.Name, &v.Prompt, &v.IntervalMinutes, &v.Enabled, &v.NextRunAt, &v.LastRunAt, &v.LastRunID, &v.LastError, &v.CreatedAt, &v.Recurrence, &v.Timezone, &v.TimeOfDay, &days, &v.OnceAt, &v.ProjectID, &v.ModelID, &v.Effort, &v.ContextMode, &v.LastStatus, &v.ExecutionCount)
	if err == nil {
		err = json.Unmarshal(days, &v.Weekdays)
	}
	return v, err
}
func NormalizeSchedule(v *Schedule) error {
	v.Name, v.Prompt = strings.TrimSpace(v.Name), strings.TrimSpace(v.Prompt)
	if v.Recurrence == "" {
		v.Recurrence = "interval"
	}
	if v.Timezone == "" {
		v.Timezone = "Asia/Shanghai"
	}
	if v.TimeOfDay == "" {
		v.TimeOfDay = "09:00"
	}
	if v.ContextMode == "" {
		v.ContextMode = "independent"
	}
	if v.IntervalMinutes == 0 {
		v.IntervalMinutes = 60
	}
	if v.Name == "" || v.Prompt == "" || len(v.Prompt) > 20000 || len([]rune(v.Name)) > 120 {
		return errors.New("请填写任务名称和指令")
	}
	if _, err := time.LoadLocation(v.Timezone); err != nil {
		return errors.New("无效的时区")
	}
	if v.ContextMode != "independent" && v.ContextMode != "session" {
		return errors.New("无效的任务上下文")
	}
	switch v.Recurrence {
	case "interval":
		if v.IntervalMinutes < 1 || v.IntervalMinutes > 525600 {
			return errors.New("间隔应为 1 到 525600 分钟")
		}
	case "once":
		if v.OnceAt == nil {
			return errors.New("请选择执行时间")
		}
	case "daily", "weekly":
		if _, err := time.Parse("15:04", v.TimeOfDay); err != nil {
			return errors.New("时间应为 HH:MM")
		}
		if v.Recurrence == "weekly" {
			if len(v.Weekdays) == 0 {
				return errors.New("请选择星期")
			}
			for _, day := range v.Weekdays {
				if day < 1 || day > 7 {
					return errors.New("星期应为 1 到 7")
				}
			}
		}
	default:
		return errors.New("无效的重复方式")
	}
	if v.Weekdays == nil {
		v.Weekdays = []int{1, 2, 3, 4, 5, 6, 7}
	}
	return nil
}

// Calendar recurrences use local wall time, not a fixed 24-hour UTC duration.
func NextScheduleTime(v Schedule, after time.Time) (time.Time, error) {
	if err := NormalizeSchedule(&v); err != nil {
		return time.Time{}, err
	}
	if v.Recurrence == "interval" {
		return after.Add(time.Duration(v.IntervalMinutes) * time.Minute).UTC(), nil
	}
	if v.Recurrence == "once" {
		return v.OnceAt.UTC(), nil
	}
	location, _ := time.LoadLocation(v.Timezone)
	local := after.In(location)
	parts := strings.Split(v.TimeOfDay, ":")
	hour, _ := strconv.Atoi(parts[0])
	minute, _ := strconv.Atoi(parts[1])
	for offset := 0; offset <= 8; offset++ {
		day := local.AddDate(0, 0, offset)
		candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location)
		if !candidate.After(after) {
			continue
		}
		if v.Recurrence == "weekly" {
			weekday := int(candidate.Weekday())
			if weekday == 0 {
				weekday = 7
			}
			match := false
			for _, d := range v.Weekdays {
				if d == weekday {
					match = true
				}
			}
			if !match {
				continue
			}
		}
		return candidate.UTC(), nil
	}
	return time.Time{}, errors.New("无法计算下一次执行时间")
}
func (s *Store) Schedules(ctx context.Context, userID string) ([]Schedule, error) {
	rows, err := s.db.Query(ctx, `SELECT `+scheduleColumns+` FROM schedules WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Schedule{}
	for rows.Next() {
		v, e := scanSchedule(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Schedule(ctx context.Context, userID, id string) (Schedule, error) {
	return scanSchedule(s.db.QueryRow(ctx, `SELECT `+scheduleColumns+` FROM schedules WHERE id=$1 AND user_id=$2`, id, userID))
}
func (s *Store) SaveSchedule(ctx context.Context, userID string, v Schedule) (Schedule, error) {
	if err := NormalizeSchedule(&v); err != nil {
		return v, err
	}
	if _, err := s.GetSession(ctx, userID, v.SessionID); err != nil {
		return v, err
	}
	if v.ProjectID != "" {
		if _, err := s.Project(ctx, userID, v.ProjectID); err != nil {
			return v, err
		}
	}
	if v.NextRunAt.IsZero() {
		next, err := NextScheduleTime(v, time.Now())
		if err != nil {
			return v, err
		}
		if v.Recurrence == "once" && v.Enabled && !next.After(time.Now()) {
			return v, errors.New("请选择将来的执行时间")
		}
		v.NextRunAt = next
	}
	days, _ := json.Marshal(v.Weekdays)
	v.UserID = userID
	var id string
	var err error
	args := []any{userID, v.SessionID, v.Name, v.Prompt, v.IntervalMinutes, v.Enabled, v.NextRunAt, v.Recurrence, v.Timezone, v.TimeOfDay, days, v.OnceAt, v.ProjectID, v.ModelID, v.Effort, v.ContextMode}
	if v.ID == "" {
		err = s.db.QueryRow(ctx, `INSERT INTO schedules(user_id,session_id,name,prompt,interval_minutes,enabled,next_run_at,recurrence,timezone,time_of_day,weekdays,once_at,project_id,model_id,effort,context_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULLIF($13,'')::uuid,NULLIF($14,'')::uuid,$15,$16) RETURNING id::text`, args...).Scan(&id)
	} else {
		args = append(args, v.ID)
		err = s.db.QueryRow(ctx, `UPDATE schedules SET session_id=$2,name=$3,prompt=$4,interval_minutes=$5,enabled=$6,next_run_at=$7,recurrence=$8,timezone=$9,time_of_day=$10,weekdays=$11,once_at=$12,project_id=NULLIF($13,'')::uuid,model_id=NULLIF($14,'')::uuid,effort=$15,context_mode=$16 WHERE user_id=$1 AND id=$17 RETURNING id::text`, args...).Scan(&id)
	}
	if err != nil {
		return v, err
	}
	return s.Schedule(ctx, userID, id)
}
func (s *Store) DeleteSchedule(ctx context.Context, userID, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM schedules WHERE id=$1 AND user_id=$2`, id, userID)
	if err == nil && tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}
func (s *Store) MarkScheduleSession(ctx context.Context, userID, id, title string) error {
	_, err := s.db.Exec(ctx, `UPDATE sessions SET source='schedule',title=$3 WHERE id=$1 AND user_id=$2`, id, userID, title)
	return err
}
func (s *Store) UserEnabled(ctx context.Context, userID string) (bool, error) {
	var enabled bool
	err := s.db.QueryRow(ctx, `SELECT enabled FROM users WHERE id=$1`, userID).Scan(&enabled)
	return enabled, err
}
func (s *Store) ClaimDueSchedules(ctx context.Context) ([]Schedule, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	rows, err := tx.Query(ctx, `SELECT `+scheduleColumns+` FROM schedules WHERE enabled AND next_run_at<=now() ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return nil, err
	}
	out := []Schedule{}
	for rows.Next() {
		v, e := scanSchedule(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for index := range out {
		v := out[index]
		next, e := NextScheduleTime(v, time.Now())
		if e != nil {
			return nil, e
		}
		if _, err = tx.Exec(ctx, `UPDATE schedules SET next_run_at=$2,enabled=CASE WHEN recurrence='once' THEN false ELSE enabled END WHERE id=$1`, v.ID, next); err != nil {
			return nil, err
		}
		var active bool
		if err = tx.QueryRow(ctx, scheduleActiveExecution, v.ID).Scan(&active); err != nil {
			return nil, err
		}
		status, message := "queued", ""
		if active {
			status, message = "skipped", "前一次执行仍在进行"
		}
		if err = tx.QueryRow(ctx, `INSERT INTO schedule_executions(schedule_id,status,error,finished_at) VALUES($1,$2,$3,CASE WHEN $2='skipped' THEN now() ELSE NULL END) RETURNING id::text`, v.ID, status, message).Scan(&out[index].ExecutionID); err != nil {
			return nil, err
		}
		out[index].ExecutionSkipped = active
	}
	return out, tx.Commit(ctx)
}

const scheduleActiveExecution = `SELECT EXISTS(SELECT 1 FROM schedule_executions e LEFT JOIN runs r ON r.id=e.run_id WHERE e.schedule_id=$1 AND COALESCE(r.status,e.status) IN ('queued','running','waiting_resource','waiting_user','cancelling'))`

// Recover reservations that never acquired a run. Never replay a task whose
// external side effects are unknown; its missed execution remains in history.
func (s *Store) RecoverScheduleExecutions(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `UPDATE schedule_executions SET status='interrupted',error='服务停止于任务启动前',finished_at=now() WHERE run_id IS NULL AND status IN ('queued','running','waiting_resource','waiting_user','cancelling')`)
	return err
}

type ScheduleExecution struct {
	ID         string             `json:"id"`
	ScheduleID string             `json:"schedule_id"`
	RunID      string             `json:"run_id,omitempty"`
	SessionID  string             `json:"session_id,omitempty"`
	Status     string             `json:"status"`
	Error      string             `json:"error,omitempty"`
	Output     string             `json:"output"`
	Artifacts  []agent.Attachment `json:"artifacts"`
	StartedAt  time.Time          `json:"started_at"`
	FinishedAt *time.Time         `json:"finished_at,omitempty"`
	Snapshot   *runtime.Snapshot  `json:"snapshot,omitempty"`
}

func (s *Store) BeginScheduleExecution(ctx context.Context, userID, id string) (string, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback(context.Background())
	var owned string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM schedules WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&owned); err != nil {
		return "", false, err
	}
	var active bool
	err = tx.QueryRow(ctx, scheduleActiveExecution, id).Scan(&active)
	if err != nil {
		return "", false, err
	}
	var executionID string
	status, message := "queued", ""
	if active {
		status, message = "skipped", "前一次执行仍在进行"
	}
	err = tx.QueryRow(ctx, `INSERT INTO schedule_executions(schedule_id,status,error,finished_at) VALUES($1,$2,$3,CASE WHEN $2='skipped' THEN now() ELSE NULL END) RETURNING id::text`, id, status, message).Scan(&executionID)
	if err != nil {
		return "", false, err
	}
	return executionID, !active, tx.Commit(ctx)
}
func (s *Store) LinkScheduleExecution(ctx context.Context, executionID, runID, sessionID, message string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	status := "queued"
	if runID == "" {
		status = "failed"
	}
	var scheduleID string
	err = tx.QueryRow(ctx, `UPDATE schedule_executions SET run_id=NULLIF($2,'')::uuid,session_id=NULLIF($3,'')::uuid,status=$4,error=$5,finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END WHERE id=$1 RETURNING schedule_id::text`, executionID, runID, sessionID, status, message).Scan(&scheduleID)
	if err != nil {
		return err
	}
	if runID != "" {
		if _, err = tx.Exec(ctx, `UPDATE runs SET schedule_id=$2 WHERE id=$1`, runID, scheduleID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE schedules SET last_run_at=now(),last_run_id=NULLIF($2,'')::uuid,last_error=$3 WHERE id=$1`, scheduleID, runID, message); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const executionColumns = `e.id::text,e.schedule_id::text,COALESCE(e.run_id::text,''),COALESCE(e.session_id::text,''),COALESCE(r.status,e.status),COALESCE(NULLIF(r.error,''),e.error),COALESCE(r.output,''),COALESCE(r.artifacts,'[]'),e.started_at,CASE WHEN r.status IN ('completed','failed','interrupted','cancelled') THEN r.updated_at ELSE e.finished_at END`

func scanExecution(row pgx.Row) (ScheduleExecution, error) {
	var v ScheduleExecution
	var artifacts []byte
	err := row.Scan(&v.ID, &v.ScheduleID, &v.RunID, &v.SessionID, &v.Status, &v.Error, &v.Output, &artifacts, &v.StartedAt, &v.FinishedAt)
	if err == nil {
		err = json.Unmarshal(artifacts, &v.Artifacts)
	}
	return v, err
}
func (s *Store) ScheduleExecutions(ctx context.Context, userID, id string) ([]ScheduleExecution, error) {
	if _, err := s.Schedule(ctx, userID, id); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+executionColumns+` FROM schedule_executions e JOIN schedules s ON s.id=e.schedule_id LEFT JOIN runs r ON r.id=e.run_id WHERE e.schedule_id=$1 AND s.user_id=$2 ORDER BY e.started_at DESC,e.id DESC LIMIT 100`, id, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScheduleExecution{}
	for rows.Next() {
		v, e := scanExecution(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) ScheduleExecution(ctx context.Context, userID, scheduleID, id string) (ScheduleExecution, error) {
	v, err := scanExecution(s.db.QueryRow(ctx, `SELECT `+executionColumns+` FROM schedule_executions e JOIN schedules s ON s.id=e.schedule_id LEFT JOIN runs r ON r.id=e.run_id WHERE e.id=$1 AND s.user_id=$2 AND e.schedule_id=$3`, id, userID, scheduleID))
	if err == nil && v.RunID != "" {
		snapshot, e := s.GetRun(ctx, userID, v.RunID)
		if e == nil {
			v.Snapshot = &snapshot
		}
	}
	return v, err
}

func ScheduleTimingKey(v Schedule) string {
	days, _ := json.Marshal(v.Weekdays)
	return fmt.Sprintf("%s|%s|%s|%d|%s|%v", v.Recurrence, v.Timezone, v.TimeOfDay, v.IntervalMinutes, days, v.OnceAt)
}
