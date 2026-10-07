package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"ochi/server/internal/agent"
)

const maxDiscoveredTools = 16
const maxRunCatalogs = 128
const maxDiscoveryBytes = 64 * 1024

type runCatalog struct {
	definitions []agent.ToolDefinition
	updated     time.Time
}

// ToolDefinition intentionally excludes private execution fields on model wire
// formats; only the trusted intrinsic registry is allowed to provide them here.
func decodeDefinitions(raw []byte, trusted bool) ([]agent.ToolDefinition, error) {
	var wire []struct {
		Name        string               `json:"name"`
		Description string               `json:"description"`
		Parameters  json.RawMessage      `json:"parameters"`
		Execution   *agent.ToolExecution `json:"execution"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, err
	}
	definitions := make([]agent.ToolDefinition, 0, len(wire))
	for _, item := range wire {
		if item.Name == "" || len(item.Name) > 64 {
			return nil, errors.New("invalid tool name")
		}
		if err := agent.ValidateToolSchema(item.Parameters); err != nil {
			return nil, fmt.Errorf("tool %s: %w", item.Name, err)
		}
		definition := agent.ToolDefinition{Name: item.Name, Description: item.Description, Parameters: item.Parameters}
		if trusted {
			definition.Execution = item.Execution
		}
		definitions = append(definitions, definition)
	}
	return definitions, nil
}

func catalogKey(ctx context.Context, userID string) string {
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.UserID != userID || scope.RunID == "" || scope.ComputeOnly {
		return ""
	}
	return userID + "\x00" + scope.RunID
}

func (d *Docker) discovered(ctx context.Context, userID string) []agent.ToolDefinition {
	key := catalogKey(ctx, userID)
	if key == "" {
		return nil
	}
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if entry := d.discoveries[key]; entry != nil {
		entry.updated = time.Now()
		return append([]agent.ToolDefinition(nil), entry.definitions...)
	}
	return nil
}

func (d *Docker) recordDiscovery(ctx context.Context, userID string, raw json.RawMessage) (json.RawMessage, error) {
	key := catalogKey(ctx, userID)
	if key == "" {
		return nil, errors.New("extension discovery requires a scoped computer run")
	}
	if len(raw) > maxDiscoveryBytes+8*1024 {
		return nil, errors.New("extension discovery response exceeds budget")
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	definitions, err := decodeDefinitions(result["tools"], false)
	if err != nil {
		return nil, err
	}
	if len(definitions) > 6 {
		return nil, errors.New("extension discovery returned more than 6 tools")
	}
	for _, definition := range definitions {
		if !strings.HasPrefix(definition.Name, "mcp_") {
			return nil, errors.New("discovery returned a non-extension tool")
		}
	}
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if d.discoveries == nil {
		d.discoveries = make(map[string]*runCatalog)
	}
	now := time.Now()
	for id, entry := range d.discoveries {
		if now.Sub(entry.updated) > 6*time.Hour {
			delete(d.discoveries, id)
		}
	}
	entry := d.discoveries[key]
	if entry == nil {
		if len(d.discoveries) >= maxRunCatalogs {
			oldest := ""
			for id, candidate := range d.discoveries {
				if oldest == "" || candidate.updated.Before(d.discoveries[oldest].updated) {
					oldest = id
				}
			}
			delete(d.discoveries, oldest)
		}
		entry = &runCatalog{}
		d.discoveries[key] = entry
	}
	known := map[string]agent.ToolDefinition{}
	for _, definition := range entry.definitions {
		known[definition.Name] = definition
	}
	selected := []agent.ToolDefinition{}
	for _, definition := range definitions {
		if existing, ok := known[definition.Name]; ok {
			selected = append(selected, existing)
		} else if len(entry.definitions) < maxDiscoveredTools {
			entry.definitions = append(entry.definitions, definition)
			known[definition.Name] = definition
			selected = append(selected, definition)
		}
	}
	entry.updated = now
	result["tools"], _ = json.Marshal(selected)
	result["discovered_this_run"], _ = json.Marshal(len(entry.definitions))
	result["run_limit"], _ = json.Marshal(maxDiscoveredTools)
	if len(selected) < len(definitions) {
		result["truncated"] = json.RawMessage("true")
		result["limit_reached"] = json.RawMessage("true")
	}
	return json.Marshal(result)
}

// Only already-running bridges may describe metadata. No ensure/provision,
// Docker request, MCP connection, or extension subprocess occurs on this path.
func (d *Docker) readCatalog(ctx context.Context, userID, path string, maxBytes int64) ([]byte, error) {
	var last error
	ids := []string{userID}
	if userID != "__admin__" {
		ids = append(ids, "__admin__")
	}
	for _, id := range ids {
		short, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		request, err := http.NewRequestWithContext(short, http.MethodGet, "http://"+userContainer(id)+":8080"+path, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		setScopeHeaders(request, ctx)
		response, err := d.bridge.Do(request)
		if err == nil {
			raw, readErr := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				err = fmt.Errorf("metadata HTTP %d", response.StatusCode)
			} else if readErr != nil {
				err = readErr
			} else if int64(len(raw)) > maxBytes {
				err = errors.New("metadata exceeds budget")
			} else {
				cancel()
				return raw, nil
			}
		}
		cancel()
		last = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, fmt.Errorf("extension metadata unavailable: %w", last)
}

func (d *Docker) SkillsIndex(ctx context.Context, userID string) (string, error) {
	if scope, ok := agent.ScopeFromContext(ctx); ok && scope.ComputeOnly {
		return "", errors.New("skills require computer permission")
	}
	raw, err := d.readCatalog(ctx, userID, "/skills/index", 8*1024)
	if err != nil {
		return "", err
	}
	var index struct {
		Skills []struct {
			ID, Name, Description string
		} `json:"skills"`
		Total     int  `json:"total"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		return "", err
	}
	if index.Skills == nil || len(index.Skills) > 32 || index.Total < len(index.Skills) {
		return "", errors.New("invalid skills metadata index")
	}
	return string(raw), nil
}

func (d *Docker) extensionDefinitions(ctx context.Context, userID string) []agent.ToolDefinition {
	known := d.discovered(ctx, userID)
	if len(known) == 0 {
		return nil
	}
	names := make([]string, 0, len(known))
	allowed := map[string]bool{}
	for _, definition := range known {
		names = append(names, definition.Name)
		allowed[definition.Name] = true
	}
	sort.Strings(names)
	raw, err := d.readCatalog(ctx, userID, "/tools?names="+url.QueryEscape(strings.Join(names, ",")), 512*1024)
	if err != nil {
		// Metadata cannot establish that an extension is still enabled. Fail
		// closed for cached tools; ordinary computation remains available.
		return nil
	}
	current, err := decodeDefinitions(raw, false)
	if err != nil {
		return nil
	}
	live := map[string]bool{}
	for _, definition := range current {
		if allowed[definition.Name] {
			live[definition.Name] = true
		}
	}
	definitions := []agent.ToolDefinition{}
	for _, definition := range known {
		if live[definition.Name] {
			definitions = append(definitions, definition)
		}
	}
	return definitions
}
