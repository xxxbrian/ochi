package storage

import (
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"ochi/server/internal/runtime"
)

const runColumns = `r.id::text,r.session_id::text,r.status,r.output,COALESCE(r.error,''),r.seq,r.updated_at,
 r.steps,r.model_id,r.model_name,r.effort,r.usage,r.waiting_input,r.artifacts,r.resource,r.computer_granted,r.reasoning,r.timeline,r.created_at`

const messageProcessSQL = `m.role='assistant' AND EXISTS (
	SELECT 1 FROM jsonb_array_elements(r.timeline) entry WHERE NOT COALESCE((entry->>'final')::boolean,false)
)`

// History reads only public prose, not the potentially large tool/reasoning
// payloads. Deriving the projection also covers interrupted checkpoints.
const messagePublicSQL = `COALESCE(r.error,''),COALESCE(r.output,''),
 CASE WHEN m.role='assistant' AND r.status IN ('completed','failed','cancelled','interrupted')
 THEN jsonb_path_query_array(r.timeline, '$[*] ? (@.kind == "progress")') ELSE '[]'::jsonb END`

func marshalTimeline(items []runtime.ProcessEntry) ([]byte, error) {
	if items == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(items)
}

func scanRun(row pgx.Row) (runtime.Snapshot, error) {
	var snapshot runtime.Snapshot
	var steps, usage, waiting, artifacts, reasoning, timeline []byte
	err := row.Scan(&snapshot.RunID, &snapshot.SessionID, &snapshot.Status, &snapshot.Output, &snapshot.Error, &snapshot.Seq, &snapshot.UpdatedAt,
		&steps, &snapshot.ModelID, &snapshot.ModelName, &snapshot.Effort, &usage, &waiting, &artifacts, &snapshot.Resource, &snapshot.ComputerGranted, &reasoning, &timeline, &snapshot.CreatedAt)
	if err != nil {
		return snapshot, err
	}
	for _, value := range []struct {
		data []byte
		into any
	}{{steps, &snapshot.Steps}, {usage, &snapshot.Usage}, {waiting, &snapshot.WaitingInput}, {artifacts, &snapshot.Artifacts}, {reasoning, &snapshot.Reasoning}, {timeline, &snapshot.Timeline}} {
		if len(value.data) > 0 {
			if err = json.Unmarshal(value.data, value.into); err != nil {
				return runtime.Snapshot{}, err
			}
		}
	}
	return runtime.ReconcileTerminal(snapshot), nil
}
