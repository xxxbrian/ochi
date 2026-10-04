package storage

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
)

func (s *Store) UpdateSession(ctx context.Context, userID, sessionID, title, modelID, effort string) (Session, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(context.Background())
	var id, previousModel, previousEffort string
	if err = tx.QueryRow(ctx, `SELECT id::text,COALESCE(model_id::text,''),effort FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID).Scan(&id, &previousModel, &previousEffort); err != nil {
		return Session{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=$1 AND status IN ('running','cancelling','waiting_user','waiting_resource'))`, sessionID).Scan(&active); err != nil {
		return Session{}, err
	}
	if active && (modelID != previousModel || effort != previousEffort) {
		return Session{}, ErrActiveRun
	}
	_, err = tx.Exec(ctx, `UPDATE sessions SET title=CASE WHEN $2='' THEN title ELSE $2 END,
 title_source=CASE WHEN $2='' THEN title_source ELSE 'manual' END,
 title_claimed_at=CASE WHEN $2='' THEN title_claimed_at ELSE NULL END,
 model_id=NULLIF($3,'')::uuid,effort=$4,updated_at=now() WHERE id=$1`, sessionID, title, modelID, effort)
	if err != nil {
		return Session{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return s.GetSession(ctx, userID, sessionID)
}
func (s *Store) DeleteSession(ctx context.Context, userID, sessionID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID).Scan(&id); err != nil {
		return err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=$1 AND status IN ('running','cancelling','waiting_user','waiting_resource'))`, sessionID).Scan(&active); err != nil {
		return err
	}
	if active {
		return ErrActiveRun
	}
	if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, sessionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) SearchSessions(ctx context.Context, userID, q, before string, limit int, projectIDs ...string) ([]Session, error) {
	projectID := ""
	if len(projectIDs) > 0 {
		projectID = projectIDs[0]
	}
	rows, err := s.db.Query(ctx, `SELECT `+sessionColumns+` FROM sessions
 WHERE user_id=$1 AND source='chat' AND ($2='' OR title ILIKE '%'||$2||'%' OR EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id AND NOT archived AND content ILIKE '%'||$2||'%'))
 AND ($3='' OR (updated_at,id) < (SELECT updated_at,id FROM sessions WHERE id=NULLIF($3,'')::uuid AND user_id=$1))
 AND ($5='' OR project_id=NULLIF($5,'')::uuid) ORDER BY updated_at DESC,id DESC LIMIT $4`, userID, q, before, limit, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var v Session
		if err := scanSession(rows, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) MessagesPage(ctx context.Context, userID, sessionID, before string, limit int) ([]Message, error) {
	if _, err := s.GetSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT m.id::text,m.run_id::text,m.role,m.content,m.created_at,
 CASE WHEN m.role='assistant' THEN COALESCE(jsonb_array_length(r.steps),0) ELSE 0 END,m.model_id,m.model_name,m.effort,m.attachments,
 CASE WHEN m.role='assistant' THEN COALESCE(jsonb_array_length(r.reasoning)>0,false) ELSE false END,
 CASE WHEN m.role='assistant' THEN COALESCE(r.status,'') ELSE '' END,
 `+messageProcessSQL+`,r.created_at,r.updated_at
 FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.session_id=$1 AND NOT m.archived
 AND ($2='' OR (m.created_at,m.id)<(SELECT created_at,id FROM messages WHERE id=NULLIF($2,'')::uuid AND session_id=$1))
 ORDER BY m.created_at DESC,m.id DESC LIMIT $3`, sessionID, before, limit)
	if err != nil {
		return nil, err
	}
	items, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
	return items, nil
}

// Each new user turn is appended after the unchanged canonical prefix. The UI
// message table is a projection, not a substitute for the provider transcript.
func (s *Store) CreateConfiguredRun(ctx context.Context, userID, sessionID, prompt, runID string, model Model, effort, system string, attachments []agent.Attachment, revision ...Revision) (runtime.Snapshot, []agent.CanonicalMessage, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return runtime.Snapshot{}, nil, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, sessionID); err != nil {
		return runtime.Snapshot{}, nil, err
	}
	var currentSystem string
	if err = tx.QueryRow(ctx, `SELECT system_prompt FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID).Scan(&currentSystem); err != nil {
		return runtime.Snapshot{}, nil, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=$1 AND id<>$2 AND status IN ('running','cancelling','waiting_user','waiting_resource'))`, sessionID, runID).Scan(&active); err != nil {
		return runtime.Snapshot{}, nil, err
	}
	if active {
		return runtime.Snapshot{}, nil, ErrActiveRun
	}
	if len(revision) > 0 && (revision[0].EditMessageID != "" || revision[0].RetryRunID != "") {
		v := revision[0]
		var previousRunID, messageID string
		if err = tx.QueryRow(ctx, `SELECT id::text,COALESCE(run_id::text,'') FROM messages WHERE session_id=$1 AND role='user' AND NOT archived ORDER BY created_at DESC,id DESC LIMIT 1`, sessionID).Scan(&messageID, &previousRunID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		if previousRunID == "" || (v.EditMessageID != "" && v.EditMessageID != messageID) || (v.RetryRunID != "" && v.RetryRunID != previousRunID) {
			return runtime.Snapshot{}, nil, errors.New("只能修改或重新运行最近的一条消息")
		}
		if _, err = tx.Exec(ctx, `UPDATE runs SET archived=true WHERE id=$1`, previousRunID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE messages SET archived=true WHERE run_id=$1`, previousRunID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE canonical_messages SET archived=true WHERE run_id=$1`, previousRunID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		if err = InvalidateRunMemoriesTx(ctx, tx, userID, previousRunID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM context_compactions WHERE session_id=$1`, sessionID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
		// An edited first turn invalidates an in-flight title, never a manual name.
		if _, err = tx.Exec(ctx, `UPDATE sessions SET title_source='pending',title_attempts=0,title_claimed_at=NULL
 WHERE id=$1 AND title_source<>'manual' AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=$1 AND role='user' AND NOT archived)`, sessionID); err != nil {
			return runtime.Snapshot{}, nil, err
		}
	}
	var snapshot runtime.Snapshot
	snapshot.ModelID, snapshot.ModelName, snapshot.Effort = model.ID, model.Name, effort
	snapshot.Steps = []runtime.Step{}
	snapshot.Artifacts = []agent.Attachment{}
	snapshot.Timeline = []runtime.ProcessEntry{}
	err = tx.QueryRow(ctx, `INSERT INTO runs (id,session_id,status,model_id,model_name,effort,timeline) VALUES ($1,$2,'running',$3,$4,$5,'[]'::jsonb) ON CONFLICT(id) DO UPDATE SET status='running',updated_at=now(),model_id=EXCLUDED.model_id,model_name=EXCLUDED.model_name,effort=EXCLUDED.effort,timeline=EXCLUDED.timeline RETURNING id::text,session_id::text,status,output,seq,updated_at,created_at`, runID, sessionID, model.ID, model.Name, effort).Scan(&snapshot.RunID, &snapshot.SessionID, &snapshot.Status, &snapshot.Output, &snapshot.Seq, &snapshot.UpdatedAt, &snapshot.CreatedAt)
	if err != nil {
		return snapshot, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT seq,COALESCE(run_id::text,''),model_id,provider_id,payload FROM canonical_messages WHERE session_id=$1 AND NOT archived AND seq > COALESCE((SELECT through_seq FROM context_compactions WHERE session_id=$1),0) ORDER BY seq`, sessionID)
	if err != nil {
		return snapshot, nil, err
	}
	history := []agent.CanonicalMessage{}
	for rows.Next() {
		var m agent.CanonicalMessage
		if err = rows.Scan(&m.Seq, &m.RunID, &m.ModelID, &m.ProviderID, &m.Payload); err != nil {
			rows.Close()
			return snapshot, nil, err
		}
		history = append(history, m)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return snapshot, nil, err
	}
	// Fill only interrupted, unfinished tool-result slots. This preserves call IDs
	// and ordering while never claiming an unknown side effect succeeded.
	pending := []string{}
	done := map[string]bool{}
	callRuns := map[string]string{}
	for _, m := range history {
		var v struct {
			Role       string `json:"role"`
			ToolCallID string `json:"tool_call_id"`
			ToolCalls  []struct {
				ID string `json:"id"`
			} `json:"tool_calls"`
		}
		_ = json.Unmarshal(m.Payload, &v)
		if v.Role == "assistant" {
			for _, call := range v.ToolCalls {
				pending = append(pending, call.ID)
				callRuns[call.ID] = m.RunID
			}
		}
		if v.Role == "tool" {
			done[v.ToolCallID] = true
		}
	}
	for _, id := range pending {
		if done[id] {
			continue
		}
		data, _ := json.Marshal(map[string]any{"role": "tool", "tool_call_id": id, "content": "上一次任务在此工具调用完成前中断；结果未确认。继续前请检查工作区的实际状态，不要假设此操作成功。"})
		var m agent.CanonicalMessage
		m.Payload = data
		m.RunID = callRuns[id]
		if err = tx.QueryRow(ctx, `INSERT INTO canonical_messages (session_id,run_id,payload) VALUES ($1,NULLIF($2,'')::uuid,$3) RETURNING seq`, sessionID, m.RunID, data).Scan(&m.Seq); err != nil {
			return snapshot, nil, err
		}
		history = append(history, m)
	}
	// A stopped turn without an assistant response otherwise leaves consecutive
	// user requests that some providers merge and resume. Close only the latest
	// prior admitted turn, after repairing any unfinished tool-result slots.
	var previousRunID, previousStatus string
	err = tx.QueryRow(ctx, `SELECT r.id::text,r.status FROM runs r
 WHERE r.session_id=$1 AND r.id<>$2 AND NOT r.archived
 AND EXISTS(SELECT 1 FROM canonical_messages c WHERE c.run_id=r.id AND NOT c.archived)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, sessionID, runID).Scan(&previousRunID, &previousStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return snapshot, nil, err
	}
	if marker := endedTurnMessage(previousStatus); marker != "" {
		data, _ := json.Marshal(map[string]any{"role": "assistant", "content": marker, "ochi_run_status": previousStatus})
		var m agent.CanonicalMessage
		m.RunID, m.Payload = previousRunID, data
		err = tx.QueryRow(ctx, `INSERT INTO canonical_messages(session_id,run_id,payload)
 SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM canonical_messages WHERE run_id=$2 AND NOT archived AND payload ? 'ochi_run_status')
 RETURNING seq`, sessionID, previousRunID, data).Scan(&m.Seq)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return snapshot, nil, err
		}
		if err == nil {
			history = append(history, m)
		}
	}
	attachData, _ := json.Marshal(attachments)
	if attachments == nil {
		attachData = []byte(`[]`)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO messages (session_id,run_id,role,content,attachments) VALUES ($1,$2,'user',$3,$4)`, sessionID, runID, prompt, attachData); err != nil {
		return snapshot, nil, err
	}
	content := prompt
	if len(attachments) > 0 {
		content += "\n\n用户附件（使用工作区工具读取，按需要编写程序处理）："
		for _, a := range attachments {
			content += "\n" + a.Name + " — " + a.Path + " (" + a.MIMEType + ", file_id=" + a.ID + ")"
		}
	}
	var wireContent any = content
	parts := []map[string]any{{"type": "text", "text": content}}
	for _, attachment := range attachments {
		if attachment.DataURL != "" {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": attachment.DataURL}})
		}
	}
	if len(parts) > 1 {
		wireContent = parts
	}
	payload, _ := json.Marshal(map[string]any{"role": "user", "content": wireContent})
	m := agent.CanonicalMessage{Payload: payload, ModelID: model.ID, ProviderID: model.ProviderID}
	if err = tx.QueryRow(ctx, `INSERT INTO canonical_messages (session_id,run_id,model_id,provider_id,payload) VALUES ($1,$2,$3,$4,$5) RETURNING seq`, sessionID, runID, model.ID, model.ProviderID, payload).Scan(&m.Seq); err != nil {
		return snapshot, nil, err
	}
	history = append(history, m)
	currentSystem = system
	if _, err = tx.Exec(ctx, `UPDATE sessions SET title=CASE WHEN title='新对话' AND title_source='pending' THEN left($2,60) ELSE title END,model_id=NULLIF($3,'')::uuid,effort=$4,system_prompt=$5,updated_at=now() WHERE id=$1`, sessionID, prompt, model.ID, effort, currentSystem); err != nil {
		return snapshot, nil, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM run_requests WHERE run_id=$1`, runID); err != nil {
		return snapshot, nil, err
	}
	return snapshot, history, tx.Commit(ctx)
}

func endedTurnMessage(status string) string {
	label := ""
	switch status {
	case runtime.StatusCancelled:
		label = "已被用户停止"
	case runtime.StatusFailed:
		label = "执行失败"
	case runtime.StatusInterrupted:
		label = "已中断"
	default:
		return ""
	}
	return "运行状态：上一轮任务" + label + "，该轮已经结束，不再自动执行。已有工具结果和文件仅作历史背景，不代表全部完成。接下来响应用户最新消息；只有用户明确要求继续时才恢复旧任务。"
}

func (s *Store) AppendCanonical(ctx context.Context, sessionID, runID string, m *agent.CanonicalMessage) error {
	return s.db.QueryRow(ctx, `INSERT INTO canonical_messages (session_id,run_id,model_id,provider_id,payload) VALUES ($1,$2,$3,$4,$5) RETURNING seq`, sessionID, runID, m.ModelID, m.ProviderID, m.Payload).Scan(&m.Seq)
}
func (s *Store) Compaction(ctx context.Context, sessionID string) (*agent.Compaction, error) {
	var c agent.Compaction
	err := s.db.QueryRow(ctx, `SELECT through_seq,summary FROM context_compactions WHERE session_id=$1`, sessionID).Scan(&c.ThroughSeq, &c.Summary)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}
func (s *Store) SaveCompaction(ctx context.Context, sessionID string, c agent.Compaction) error {
	_, err := s.db.Exec(ctx, `INSERT INTO context_compactions(session_id,through_seq,summary) VALUES ($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET through_seq=EXCLUDED.through_seq,summary=EXCLUDED.summary,updated_at=now()`, sessionID, c.ThroughSeq, c.Summary)
	return err
}
func (s *Store) Checkpoint(ctx context.Context, v runtime.Snapshot) error {
	steps, _ := json.Marshal(v.Steps)
	usage, _ := json.Marshal(v.Usage)
	waiting, _ := json.Marshal(v.WaitingInput)
	artifacts, _ := json.Marshal(v.Artifacts)
	reasoning, _ := json.Marshal(v.Reasoning)
	timeline, err := marshalTimeline(v.Timeline)
	if err != nil {
		return err
	}
	if v.Reasoning == nil {
		reasoning = []byte("[]")
	}
	_, err = s.db.Exec(ctx, `UPDATE runs SET status=$2,output=$3,steps=$4,seq=$5,updated_at=$6,usage=$7,waiting_input=$8,artifacts=$9,resource=$10,computer_granted=$11,reasoning=$12,timeline=$13 WHERE id=$1 AND seq<=$5`, v.RunID, v.Status, v.Output, steps, v.Seq, v.UpdatedAt, usage, waiting, artifacts, v.Resource, v.ComputerGranted, reasoning, timeline)
	return err
}
func (s *Store) HasImages(ctx context.Context, sessionID string) (bool, error) {
	var found bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM canonical_messages WHERE session_id=$1 AND NOT archived AND jsonb_typeof(payload->'content')='array' AND payload->'content' @> '[{"type":"image_url"}]'::jsonb)`, sessionID).Scan(&found)
	return found, err
}

func (s *Store) HasToolHistory(ctx context.Context, sessionID string) (bool, error) {
	var found bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM canonical_messages WHERE session_id=$1 AND NOT archived AND payload ? 'tool_calls')`, sessionID).Scan(&found)
	return found, err
}

type Revision struct {
	EditMessageID string
	RetryRunID    string
	Priority      bool
}

func (s *Store) LastUserMessage(ctx context.Context, userID, sessionID string, revision Revision) (Message, error) {
	if _, err := s.GetSession(ctx, userID, sessionID); err != nil {
		return Message{}, err
	}
	var m Message
	err := s.db.QueryRow(ctx, `SELECT id::text,run_id::text,role,content,created_at,model_id,model_name,effort,attachments FROM messages WHERE session_id=$1 AND role='user' AND NOT archived ORDER BY created_at DESC,id DESC LIMIT 1`, sessionID).Scan(&m.ID, &m.RunID, &m.Role, &m.Content, &m.CreatedAt, &m.ModelID, &m.ModelName, &m.Effort, &m.Attachments)
	if err != nil {
		return m, err
	}
	if m.RunID == nil || (revision.EditMessageID != "" && m.ID != revision.EditMessageID) || (revision.RetryRunID != "" && *m.RunID != revision.RetryRunID) {
		return m, errors.New("只能修改或重新运行最近的一条消息")
	}
	return m, nil
}
