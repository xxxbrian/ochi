package workspace

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"ochi/server/internal/agent"
)

//go:embed tools.json
var intrinsicTools []byte

type Config struct {
	Socket         string
	Image          string
	Network        string
	ComputeNetwork string
}

type Docker struct {
	config      Config
	engine      *http.Client
	bridge      *http.Client
	mu          sync.Mutex
	urls        map[string]string
	catalogMu   sync.Mutex
	discoveries map[string]*runCatalog
}

// The server uses Docker only for workspace lifecycle. Workspace tools never
// receive the Docker socket or access the host desktop.
func NewDocker(config Config) *Docker {
	if config.Socket == "" {
		config.Socket = "/var/run/docker.sock"
	}
	if config.Image == "" {
		config.Image = "ochi-workspace:local"
	}
	if config.Network == "" {
		config.Network = "ochi"
	}
	if config.ComputeNetwork == "" {
		config.ComputeNetwork = "ochi-compute"
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", config.Socket)
	}}
	return &Docker{
		config: config,
		engine: &http.Client{Transport: transport, Timeout: 30 * time.Second},
		bridge: &http.Client{Timeout: 11 * time.Minute},
		urls:   make(map[string]string),
	}
}

func userContainer(userID string) string {
	hash := sha256.Sum256([]byte(userID))
	return "ochi-workspace-" + hex.EncodeToString(hash[:8])
}

func (d *Docker) ensure(ctx context.Context, userID string) (string, error) {
	if scope, ok := agent.ScopeFromContext(ctx); ok && scope.ComputeOnly {
		return d.ensureCompute(ctx, userID, scope.SessionID)
	}
	// A small deployment needs one persistent workspace per user, not an
	// orchestration layer. Serialize first creation so two tabs reuse one container.
	d.mu.Lock()
	defer d.mu.Unlock()
	if address := d.urls[userID]; address != "" {
		if d.healthy(ctx, address) {
			return address, nil
		}
		delete(d.urls, userID)
	}
	name := userContainer(userID)
	var inspect struct {
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
	}
	status, err := d.request(ctx, http.MethodGet, "/containers/"+name+"/json", nil, &inspect)
	if err != nil && status != http.StatusNotFound {
		return "", err
	}
	if status == http.StatusNotFound {
		container := map[string]any{
			"Image":  d.config.Image,
			"Labels": map[string]string{"app": "ochi", "workspace": name},
			"Env":    []string{"EXTENSIONS_ROOT=/opt/extensions"},
			"HostConfig": map[string]any{
				"NetworkMode": d.config.Network,
				"ShmSize":     512 * 1024 * 1024,
				"Mounts": []map[string]any{
					{"Type": "volume", "Source": name + "-data", "Target": "/data"},
					{"Type": "volume", "Source": "ochi-extensions", "Target": "/opt/extensions", "ReadOnly": userID != "__admin__"},
				},
			},
		}
		if _, err := d.request(ctx, http.MethodPost, "/containers/create?name="+name, container, nil); err != nil {
			return "", fmt.Errorf("create workspace: %w", err)
		}
		inspect.State.Running = false
	}
	if !inspect.State.Running {
		if _, err := d.request(ctx, http.MethodPost, "/containers/"+name+"/start", nil, nil); err != nil {
			return "", fmt.Errorf("start workspace: %w", err)
		}
	}
	address := "http://" + name + ":8080"
	readyCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		if d.healthy(readyCtx, address) {
			d.urls[userID] = address
			return address, nil
		}
		select {
		case <-readyCtx.Done():
			return "", errors.New("workspace bridge did not become ready; check workspace container logs")
		case <-ticker.C:
		}
	}
}

func (d *Docker) request(ctx context.Context, method, path string, body any, out any) (int, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker/v1.44"+path, reader)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.engine.Do(req)
	if err != nil {
		return 0, fmt.Errorf("Docker Engine: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return resp.StatusCode, fmt.Errorf("Docker HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
	}
	_, err = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, err
}

func (d *Docker) healthy(ctx context.Context, address string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, address+"/health", nil)
	resp, err := d.bridge.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (d *Docker) Definitions(ctx context.Context, userID string) ([]agent.ToolDefinition, error) {
	// Describing tools must not provision a computer for an ordinary question.
	// A running admin bridge exposes the shared extensions; intrinsic tools are
	// available immediately even when no workspace has ever been started.
	definitions, err := decodeDefinitions(intrinsicTools, true)
	if err != nil {
		return nil, err
	}
	if scope, ok := agent.ScopeFromContext(ctx); ok && scope.ComputeOnly {
		return computeDefinitions(definitions), nil
	}
	return append(definitions, d.extensionDefinitions(ctx, userID)...), nil
}

// Bridge is private server-to-container I/O, shared by uploads and admin tools.
func (d *Docker) Bridge(ctx context.Context, userID, method, path string, data []byte) (int, http.Header, []byte, error) {
	address, err := d.ensure(ctx, userID)
	if err != nil {
		return 0, nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, address+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	setScopeHeaders(req, ctx)
	if strings.HasPrefix(path, "/extensions/") {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.bridge.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	limit := int64(34 * 1024 * 1024)
	if strings.HasPrefix(path, "/file?") {
		limit = 32 * 1024 * 1024
	}
	if resp.ContentLength > limit {
		return resp.StatusCode, resp.Header.Clone(), nil, errors.New("workspace file exceeds 32 MB")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err == nil && int64(len(body)) > limit {
		err = errors.New("workspace response is too large")
	}
	return resp.StatusCode, resp.Header.Clone(), body, err
}

type State struct {
	UserID    string `json:"user_id"`
	Container string `json:"container"`
	State     string `json:"state"`
	Running   bool   `json:"running"`
	Image     string `json:"image"`
}

func (d *Docker) Inspect(ctx context.Context, userID string) (State, error) {
	state := State{UserID: userID, Container: userContainer(userID), State: "not_created", Image: d.config.Image}
	var inspect struct {
		Config struct{ Image string } `json:"Config"`
		State  struct {
			Running bool
			Status  string
		} `json:"State"`
	}
	status, err := d.request(ctx, http.MethodGet, "/containers/"+state.Container+"/json", nil, &inspect)
	if status == http.StatusNotFound {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	state.State, state.Running, state.Image = inspect.State.Status, inspect.State.Running, inspect.Config.Image
	return state, nil
}

func (d *Docker) Manage(ctx context.Context, userID, action string) (State, error) {
	name := userContainer(userID)
	switch action {
	case "start":
		if _, err := d.ensure(ctx, userID); err != nil {
			return State{}, err
		}
	case "stop", "rebuild":
		d.mu.Lock()
		delete(d.urls, userID)
		d.mu.Unlock()
		state, err := d.Inspect(ctx, userID)
		if err != nil {
			return state, err
		}
		if state.Running {
			if _, err := d.request(ctx, http.MethodPost, "/containers/"+name+"/stop?t=15", nil, nil); err != nil {
				return state, err
			}
		}
		if action == "rebuild" {
			if state.State != "not_created" {
				// The container is replaced, never its named data/extension volumes.
				if _, err := d.request(ctx, http.MethodDelete, "/containers/"+name, nil, nil); err != nil {
					return state, err
				}
			}
			if _, err := d.ensure(ctx, userID); err != nil {
				return state, err
			}
		}
	default:
		return State{}, errors.New("unknown workspace action")
	}
	return d.Inspect(ctx, userID)
}

func (d *Docker) Call(ctx context.Context, userID, name string, args json.RawMessage) (agent.ToolResult, error) {
	extensionCall := name == "skills_list" || name == "skills_read" || name == "tool_search" || strings.HasPrefix(name, "mcp_")
	if extensionCall {
		access, ok := agent.ExtensionAccessFromContext(ctx)
		if scope, scoped := agent.ScopeFromContext(ctx); scoped && scope.RunID != "" && !ok {
			return agent.ToolResult{}, errors.New("extension access has not been resolved for this user")
		}
		if ok && name == "skills_read" {
			var input struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(args, &input) == nil {
				allowed := false
				for _, id := range access.Skills {
					allowed = allowed || id == input.ID
				}
				if !allowed {
					return agent.ToolResult{}, errors.New("skill is unavailable or disabled for this user")
				}
			}
		}
	}
	definitions, err := d.Definitions(ctx, userID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	var definition *agent.ToolDefinition
	for i := range definitions {
		if definitions[i].Name == name {
			definition = &definitions[i]
			break
		}
	}
	if definition == nil {
		return agent.ToolResult{}, errors.New("tool is unavailable or has not been discovered")
	}
	if err := agent.ValidateToolArguments(*definition, args); err != nil {
		return agent.ToolResult{}, err
	}
	address, err := d.ensure(ctx, userID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return agent.ToolResult{}, err
	}
	// The bridge cannot abort a dispatched operation when its HTTP client goes
	// away. Drain that operation before releasing the user's shared desktop.
	callCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.bridge.Timeout)
	defer cancel()
	if name == "exec" || strings.HasPrefix(name, "browser_") || strings.HasPrefix(name, "computer_") {
		if scope, ok := agent.ScopeFromContext(ctx); ok && scope.RunID != "" {
			var id [16]byte
			if _, err := rand.Read(id[:]); err != nil {
				return agent.ToolResult{}, err
			}
			scope.OperationID = hex.EncodeToString(id[:])
			ctx = agent.WithRunScope(ctx, scope)
			callCtx = agent.WithRunScope(callCtx, scope)
			stop := context.AfterFunc(ctx, func() {
				terminate, done := context.WithTimeout(context.Background(), 5*time.Second)
				defer done()
				// Cancel only this operation. Revoking computer access must leave the
				// run able to continue in scratch, and a later grant usable again.
				request, err := http.NewRequestWithContext(agent.WithRunScope(terminate, scope), http.MethodPost, address+"/runs/interrupt", strings.NewReader(`{}`))
				if err != nil {
					return
				}
				request.Header.Set("Content-Type", "application/json")
				setScopeHeaders(request, agent.WithRunScope(terminate, scope))
				if response, err := d.bridge.Do(request); err == nil {
					response.Body.Close()
				}
			})
			defer stop()
		}
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, address+"/tools/"+url.PathEscape(name), bytes.NewReader(args))
	if err != nil {
		return agent.ToolResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	setScopeHeaders(req, ctx)
	resp, err := d.bridge.Do(req)
	if err != nil {
		return agent.ToolResult{}, err
	}
	defer resp.Body.Close()
	var envelope struct {
		OK          bool                     `json:"ok"`
		Result      json.RawMessage          `json:"result"`
		Error       string                   `json:"error"`
		ErrorDetail *agent.ToolArgumentError `json:"error_detail"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&envelope); err != nil {
		return agent.ToolResult{}, err
	}
	if !envelope.OK {
		if envelope.ErrorDetail != nil {
			return agent.ToolResult{}, envelope.ErrorDetail
		}
		return agent.ToolResult{}, errors.New(envelope.Error)
	}
	if name == "tool_search" {
		envelope.Result, err = d.recordDiscovery(ctx, userID, envelope.Result)
		if err != nil {
			return agent.ToolResult{}, err
		}
	}
	var image struct {
		MIME string `json:"mime_type"`
		Data string `json:"data"`
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(envelope.Result, &result) == nil {
		if nested := result["image"]; len(nested) > 0 {
			_ = json.Unmarshal(nested, &image)
			if image.Data != "" {
				// Keep dimensions and coordinate space beside the separate image.
				var metadata map[string]json.RawMessage
				if json.Unmarshal(nested, &metadata) == nil {
					delete(metadata, "data")
					result["image"], _ = json.Marshal(metadata)
				}
			}
		} else if len(result["data"]) > 0 {
			_ = json.Unmarshal(envelope.Result, &image)
			delete(result, "data")
		}
		if image.Data != "" {
			output, _ := json.Marshal(result)
			return agent.ToolResult{Output: string(output), Screenshot: "data:" + image.MIME + ";base64," + image.Data}, nil
		}
	}
	return agent.ToolResult{Output: string(envelope.Result)}, nil
}

func setScopeHeaders(req *http.Request, ctx context.Context) {
	if scope, ok := agent.ScopeFromContext(ctx); ok {
		data, _ := json.Marshal(scope)
		req.Header.Set("X-Run-Scope", string(data))
	}
	if access, ok := agent.ExtensionAccessFromContext(ctx); ok {
		data, _ := json.Marshal(access)
		req.Header.Set("X-Ochi-Extensions", string(data))
	}
}

func (d *Docker) DesktopURL(ctx context.Context, userID string) (string, error) {
	if _, err := d.ensure(ctx, userID); err != nil {
		return "", err
	}
	return "ws://" + userContainer(userID) + ":6080/websockify", nil
}
func (d *Docker) DesktopViewURL(ctx context.Context, userID string) (string, error) {
	if _, err := d.ensure(ctx, userID); err != nil {
		return "", err
	}
	return "ws://" + userContainer(userID) + ":6081/websockify", nil
}
