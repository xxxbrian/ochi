package storage

import (
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"ochi/server/internal/runtime"
)

const runColumns = `r.id::text,r.session_id::text,r.status,COALESCE(r.error,''),r.error_code,r.seq,r.updated_at,
 r.items,r.model_id,r.model_name,r.effort,r.usage,r.waiting_input,r.artifacts,r.resource,r.computer_granted,r.created_at`
const messageProcessSQL = `m.role='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.items) item WHERE item->>'kind'<>'text' OR item->>'phase'<>'final')`
const messagePublicSQL = `COALESCE(r.error,''),COALESCE(r.error_code,''),CASE WHEN m.role='assistant' AND r.status IN ('completed','failed','cancelled','interrupted') THEN jsonb_path_query_array(r.items,'$[*] ? (@.kind == "text")') ELSE '[]'::jsonb END`
const itemStepCountSQL = `COALESCE(jsonb_array_length(jsonb_path_query_array(r.items,'$[*] ? (@.kind == "tool" && @.step.status == "completed" && (!exists(@.step.outcome) || (@.step.outcome != "needs_user" && @.step.outcome != "not_executed")))')),0)`
const itemHasReasoningSQL = `COALESCE(jsonb_array_length(jsonb_path_query_array(r.items,'$[*] ? (@.kind == "reasoning")'))>0,false)`

func marshalItems(items []runtime.Item) ([]byte, error) {
	if items == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(items)
}
func scanRun(row pgx.Row) (runtime.Snapshot, error) {
	var snapshot runtime.Snapshot
	var items, usage, waiting, artifacts []byte
	err := row.Scan(&snapshot.RunID, &snapshot.SessionID, &snapshot.Status, &snapshot.Error, &snapshot.ErrorCode, &snapshot.Seq, &snapshot.UpdatedAt, &items, &snapshot.ModelID, &snapshot.ModelName, &snapshot.Effort, &usage, &waiting, &artifacts, &snapshot.Resource, &snapshot.ComputerGranted, &snapshot.CreatedAt)
	if err != nil {
		return snapshot, err
	}
	for _, value := range []struct {
		data []byte
		into any
	}{{items, &snapshot.Items}, {usage, &snapshot.Usage}, {waiting, &snapshot.WaitingInput}, {artifacts, &snapshot.Artifacts}} {
		if len(value.data) > 0 {
			if err = json.Unmarshal(value.data, value.into); err != nil {
				return runtime.Snapshot{}, err
			}
		}
	}
	return runtime.ReconcileTerminal(snapshot), nil
}
