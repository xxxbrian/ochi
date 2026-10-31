package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ochi/server/internal/agent"
)

type Job struct {
	ID             string   `json:"job_id"`
	UserID         string   `json:"user_id"`
	SessionID      string   `json:"session_id"`
	RunID          string   `json:"run_id"`
	Kind           string   `json:"kind"`
	CWD            string   `json:"cwd"`
	ResourceClaims []string `json:"resource_claims"`
}

type JobActivity struct {
	Jobs        []Job   `json:"jobs"`
	ActiveCalls int     `json:"active_calls"`
	IdleSeconds float64 `json:"idle_seconds"`
}

func (d *Docker) ToolResources(name string) []string {
	definitions, err := decodeDefinitions(intrinsicTools, true)
	if err != nil {
		return nil
	}
	for _, definition := range definitions {
		if definition.Name == name && definition.Execution != nil {
			return append([]string(nil), definition.Execution.Resources...)
		}
	}
	return nil
}

// Lifecycle queries never create or start a workspace. They recover the private
// transport identity from Docker after a server restart, just like attachment.
func (d *Docker) existingBridge(ctx context.Context, name, key string) (string, bool, error) {
	var container struct {
		Config struct{ Env []string }
		State  struct{ Running bool }
	}
	status, err := d.request(ctx, http.MethodGet, "/containers/"+name+"/json", nil, &container)
	if status == http.StatusNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !container.State.Running {
		return "", false, nil
	}
	if err := d.rememberBridgeToken(key, container.Config.Env); err != nil {
		return "", false, err
	}
	return "http://" + name + ":8080", true, nil
}

func (d *Docker) lifecycleRequest(ctx context.Context, key, address, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setScopeHeaders(req, ctx)
	d.tokenMu.RLock()
	req.Header.Set("Authorization", "Bearer "+d.tokens[key])
	d.tokenMu.RUnlock()
	resp, err := d.bridge.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("workspace lifecycle HTTP %d", resp.StatusCode)
	}
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(&envelope); err != nil {
		return err
	}
	if !envelope.OK {
		return errors.New("workspace lifecycle request failed")
	}
	if out != nil {
		return json.Unmarshal(envelope.Result, out)
	}
	return nil
}

func (d *Docker) jobActivity(ctx context.Context, key, address string) (JobActivity, error) {
	var wire struct {
		Jobs        *[]Job   `json:"jobs"`
		ActiveCalls *int     `json:"active_calls"`
		IdleSeconds *float64 `json:"idle_seconds"`
	}
	if err := d.lifecycleRequest(ctx, key, address, "/jobs/active", map[string]any{}, &wire); err != nil {
		return JobActivity{}, err
	}
	if wire.Jobs == nil || wire.ActiveCalls == nil || wire.IdleSeconds == nil || *wire.ActiveCalls < 0 || *wire.IdleSeconds < 0 {
		return JobActivity{}, errors.New("invalid workspace job activity")
	}
	return JobActivity{Jobs: *wire.Jobs, ActiveCalls: *wire.ActiveCalls, IdleSeconds: *wire.IdleSeconds}, nil
}

// ActiveJobs is the bridge's process authority, including service jobs that
// outlive a model run or a Go server restart.
func (d *Docker) ActiveJobs(ctx context.Context, userID string) ([]Job, error) {
	address, running, err := d.existingBridge(ctx, userContainer(userID), userID)
	if err != nil || !running {
		return nil, err
	}
	state, err := d.jobActivity(ctx, userID, address)
	return state.Jobs, err
}

func (d *Docker) FinishRun(ctx context.Context, scope agent.RunScope, cancelServices bool) error {
	scope.OperationID = ""
	var errs []error
	for _, compute := range []bool{false, true} {
		current := scope
		current.ComputeOnly = compute
		current.ExecutionEnvironment = "desktop"
		key, name := scope.UserID, userContainer(scope.UserID)
		if compute {
			current.ExecutionEnvironment = "compute"
			key = computeContainer(scope.UserID, scope.SessionID)
			name = key
		}
		address, running, err := d.existingBridge(ctx, name, key)
		if err == nil && running {
			err = d.lifecycleRequest(agent.WithRunScope(ctx, current), key, address, "/runs/finish", map[string]any{"cancel_services": cancelServices}, nil)
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (d *Docker) CancelSessionJobs(ctx context.Context, userID, sessionID string) error {
	var errs []error
	for _, compute := range []bool{false, true} {
		if err := d.cancelTargetJobs(ctx, userID, sessionID, compute); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Computer revocation does not terminate the conversation's isolated compute.
func (d *Docker) CancelComputerJobs(ctx context.Context, userID, sessionID string) error {
	return d.cancelTargetJobs(ctx, userID, sessionID, false)
}

func (d *Docker) cancelTargetJobs(ctx context.Context, userID, sessionID string, compute bool) error {
	scope := agent.RunScope{UserID: userID, SessionID: sessionID, ExecutionEnvironment: "desktop"}
	key, name := userID, userContainer(userID)
	if compute {
		scope.ComputeOnly, scope.ExecutionEnvironment = true, "compute"
		key = computeContainer(userID, sessionID)
		name = key
	}
	address, running, err := d.existingBridge(ctx, name, key)
	if err != nil || !running {
		return err
	}
	return d.lifecycleRequest(agent.WithRunScope(ctx, scope), key, address, "/jobs/cancel-session", map[string]any{}, nil)
}

const computeIdleTimeout = 10 * time.Minute

// Maintain stops only idle computation containers. Named data volumes survive;
// an explicit service or live request is an activity reference, never "idle".
func (d *Docker) Maintain(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		sweep, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := d.stopIdleCompute(sweep, computeIdleTimeout); err != nil && ctx.Err() == nil {
			log.Printf("computation idle sweep: %v", err)
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *Docker) stopIdleCompute(ctx context.Context, idle time.Duration) error {
	filters, _ := json.Marshal(map[string][]string{"label": {"app=ochi", "scope=compute"}, "status": {"running"}})
	var containers []struct{ Names []string }
	_, err := d.request(ctx, http.MethodGet, "/containers/json?filters="+url.QueryEscape(string(filters)), nil, &containers)
	if err != nil {
		return err
	}
	var errs []error
	for _, container := range containers {
		if len(container.Names) == 0 {
			continue
		}
		name := strings.TrimPrefix(container.Names[0], "/")
		if !strings.HasPrefix(name, "ochi-compute-") {
			continue
		}
		if err := d.stopIdleContainer(ctx, name, idle); err != nil {
			errs = append(errs, err)
			if ctx.Err() != nil {
				break
			}
		}
	}
	return errors.Join(errs...)
}

func (d *Docker) stopIdleContainer(ctx context.Context, name string, idle time.Duration) error {
	unlock, err := d.lockWorkspace(ctx, name)
	if err != nil {
		return err
	}
	defer unlock()
	d.mu.Lock()
	busy := d.active[name] > 0 || time.Since(d.lastUse[name]) < idle
	d.mu.Unlock()
	if busy {
		return nil
	}
	address, running, err := d.existingBridge(ctx, name, name)
	if err != nil || !running {
		return err
	}
	query, cancel := context.WithTimeout(ctx, 2*time.Second)
	state, err := d.jobActivity(query, name, address)
	cancel()
	if err != nil {
		return err
	}
	if len(state.Jobs) != 0 || state.ActiveCalls != 0 || state.IdleSeconds < idle.Seconds() {
		return nil
	}
	if _, err := d.request(ctx, http.MethodPost, "/containers/"+name+"/stop?t=5", nil, nil); err != nil {
		return err
	}
	d.rememberAddress(name, "")
	d.mu.Lock()
	delete(d.lastUse, name)
	d.mu.Unlock()
	d.tokenMu.Lock()
	delete(d.tokens, name)
	d.tokenMu.Unlock()
	return nil
}
