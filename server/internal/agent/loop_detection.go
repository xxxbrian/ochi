package agent

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

func failureFingerprint(name, arguments, output string) string {
	var args any
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.UseNumber()
	if decoder.Decode(&args) == nil {
		if data, err := json.Marshal(args); err == nil {
			arguments = string(data)
		}
	}
	if name == "exec" {
		var result map[string]json.RawMessage
		if json.Unmarshal([]byte(output), &result) == nil && result != nil {
			// Only bridge-owned timing/log locations are volatile. Real stdout,
			// stderr, exit status, cwd and user file paths remain part of the key.
			paths := []string{}
			for _, key := range []string{"stdout_path", "stderr_path"} {
				var path string
				if json.Unmarshal(result[key], &path) == nil && path != "" {
					paths = append(paths, path)
				}
				delete(result, key)
			}
			delete(result, "duration_ms")
			for _, key := range []string{"stdout", "stderr"} {
				var text string
				if json.Unmarshal(result[key], &text) == nil {
					for _, path := range paths {
						text = strings.ReplaceAll(text, path, "[execution-log]")
					}
					result[key], _ = json.Marshal(text)
				}
			}
			if data, err := json.Marshal(result); err == nil {
				output = string(data)
			}
		}
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(name+"\n"+arguments+"\n"+output)))
}

type loopObservation struct {
	fingerprint string
	failed      bool
	readOnly    bool
}

type loopDetector struct{ recent []loopObservation }

func (d *loopDetector) observe(call toolCall, step Step, execution *ToolExecution) string {
	failed := step.Status == "failed"
	readOnly := execution != nil && execution.ReadOnly && !execution.ExternalSend && !execution.Irreversible
	if !failed && !readOnly {
		// A successful side-effecting operation is possible real progress, even
		// when its visible output happens to equal the preceding output.
		d.recent = nil
		return ""
	}
	observation := loopObservation{fingerprint: failureFingerprint(call.Function.Name, call.Function.Arguments, step.Output), failed: failed, readOnly: readOnly}
	d.recent = append(d.recent, observation)
	if len(d.recent) > 12 {
		d.recent = d.recent[len(d.recent)-12:]
	}
	repeats := 0
	for _, previous := range d.recent {
		if previous.fingerprint == observation.fingerprint && previous.failed == failed {
			repeats++
		}
	}
	if failed && repeats >= 3 {
		return "repeated_failure"
	}
	if readOnly && repeats >= 6 {
		return "no_progress"
	}
	if len(d.recent) >= 8 {
		tail := d.recent[len(d.recent)-8:]
		cycle := true
		for index := 2; index < len(tail); index++ {
			cycle = cycle && tail[index].fingerprint == tail[index%2].fingerprint
		}
		if cycle {
			return "no_progress_cycle"
		}
	}
	return ""
}
