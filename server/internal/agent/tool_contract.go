package agent

import "context"

// SkillIndexSource lists metadata only. Callers capture it once at run start
// after permission checks; reading instruction bodies remains demand-driven.
type SkillIndexSource interface {
	SkillsIndex(context.Context, string) (string, error)
}

// ToolExecution describes scheduler safety, not model-facing instructions.
// Missing metadata is conservative: serial execution without automatic retries.
type ToolExecution struct {
	ReadOnly     bool `json:"read_only"`
	ParallelSafe bool `json:"parallel_safe"`
	RetrySafe    bool `json:"retry_safe"`
	ExternalSend bool `json:"external_send"`
	Irreversible bool `json:"irreversible"`
}
