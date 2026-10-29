package api

import (
	"encoding/json"

	"ochi/server/internal/runtime"
)

type executionObservation struct {
	StepID, ResultStepID, Command, JobID string
	Successful                           bool
	Logs                                 []string
}

type executionOutput struct {
	JobID    string `json:"job_id"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exit_code"`
	TimedOut bool   `json:"timed_out"`
	IsError  bool   `json:"isError"`
	Error    string `json:"error"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func (o *executionObservation) observe(step runtime.Step, output executionOutput) {
	o.ResultStepID = step.ID
	o.Successful = step.Status == "completed" && output.ExitCode != nil && *output.ExitCode == 0 &&
		!output.TimedOut && !output.IsError && output.Error == "" &&
		(output.Status == "completed" || output.JobID == "" && output.Status == "")
	if output.Stdout != "" {
		o.Logs = append(o.Logs, output.Stdout)
	}
	if output.Stderr != "" {
		o.Logs = append(o.Logs, output.Stderr)
	}
}

// Join only observed results in this run. Command identity comes from exec;
// a later job observation supplies its outcome, without rewriting either tool
// item or treating an old service's poll as a new execution.
func executionObservations(steps []runtime.Step) []executionObservation {
	observations := []executionObservation{}
	jobs := map[string]int{}
	for _, step := range steps {
		switch step.Name {
		case "exec":
			var args struct {
				Command string `json:"command"`
			}
			if json.Unmarshal(step.Arguments, &args) != nil || args.Command == "" {
				continue
			}
			observation := executionObservation{StepID: step.ID, Command: args.Command}
			var output executionOutput
			if json.Unmarshal([]byte(step.Output), &output) == nil {
				observation.JobID = output.JobID
				observation.observe(step, output)
			}
			observations = append(observations, observation)
			if observation.JobID != "" {
				jobs[observation.JobID] = len(observations) - 1
			}
		case "job":
			var args struct {
				JobID string `json:"job_id"`
			}
			var output executionOutput
			if step.Status != "completed" || json.Unmarshal(step.Arguments, &args) != nil ||
				json.Unmarshal([]byte(step.Output), &output) != nil || output.JobID == "" || output.JobID != args.JobID {
				continue
			}
			if index, exists := jobs[output.JobID]; exists {
				observations[index].observe(step, output)
			}
		}
	}
	return observations
}
