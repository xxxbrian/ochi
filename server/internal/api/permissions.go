package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"ochi/server/internal/agent"
	"ochi/server/internal/runtime"
	"ochi/server/internal/storage"
)

var errComputerPermission = errors.New("请先允许此对话使用电脑")

type computerCall struct {
	sessionID string
	runID     string
	cancel    context.CancelCauseFunc
}

func (s *Server) interruptComputerCalls(sessionID string) (active bool) {
	s.computerCalls.Range(func(_, value any) bool {
		call := value.(*computerCall)
		if call.sessionID == sessionID {
			active = true
			call.cancel(errComputerModeChanged)
		}
		return true
	})
	return active
}

func (s *Server) releaseDrainedComputerResources(runID string) {
	s.permissionMu.Lock()
	defer s.permissionMu.Unlock()
	s.releaseDrainedComputerResourcesLocked(runID)
}

func (s *Server) releaseDrainedComputerResourcesLocked(runID string) {
	active := false
	s.computerCalls.Range(func(_, value any) bool {
		if value.(*computerCall).runID == runID {
			active = true
		}
		return !active
	})
	if !active {
		s.resources.releaseRun(runID)
	}
}

func (s *Server) computerCallContext(ctx context.Context, scope agent.RunScope) (context.Context, func(), error) {
	if scope.ComputeOnly || scope.RunID == "" {
		return ctx, func() {}, nil
	}
	// Register under the same lock as revoke, covering the interval between the
	// last database check and dispatch. Cancelling this call does not stop the run.
	s.permissionMu.Lock()
	defer s.permissionMu.Unlock()
	allowed, err := s.computerAllowed(ctx, scope)
	if err != nil {
		return ctx, nil, err
	}
	if !allowed {
		return ctx, nil, errComputerModeChanged
	}
	child, cancel := context.WithCancelCause(ctx)
	call := &computerCall{sessionID: scope.SessionID, runID: scope.RunID, cancel: cancel}
	// A read-only batch can have several calls in one run. Register every call,
	// otherwise the last reader hides its siblings from permission revocation.
	s.computerCalls.Store(call, call)
	return child, func() {
		s.permissionMu.Lock()
		defer s.permissionMu.Unlock()
		s.computerCalls.Delete(call)
		if errors.Is(context.Cause(child), errComputerModeChanged) {
			// A dispatched browser/MCP operation has now drained. Only then may
			// the human or a different run acquire this user's computer resources.
			s.releaseDrainedComputerResourcesLocked(scope.RunID)
		}
		cancel(nil)
	}, nil
}

func (s *Server) computerAllowed(ctx context.Context, scope agent.RunScope) (bool, error) {
	if scope.UserID == "" || scope.SessionID == "" {
		return false, errComputerPermission
	}
	session, err := s.store.GetSession(ctx, scope.UserID, scope.SessionID)
	if err != nil {
		return false, err
	}
	if session.ComputerEnabled {
		return true, nil
	}
	if scope.RunID != "" {
		if run, ok := s.runtime.Get(scope.RunID); ok {
			v := run.Snapshot()
			return v.SessionID == scope.SessionID && v.ComputerGranted && runtime.IsActive(v.Status), nil
		}
	}
	return false, nil
}

func computationTool(name string) bool {
	switch name {
	case "exec", "files_list", "files_read", "files_write", "web_fetch", "publish_file", "read_artifact":
		return true
	}
	return false
}

func (s *Server) effectiveScope(ctx context.Context, scope agent.RunScope) (agent.RunScope, error) {
	allowed, err := s.computerAllowed(ctx, scope)
	if err != nil {
		return scope, err
	}
	scope.ComputeOnly = !allowed
	return scope, nil
}

func revokedComputerResult(result agent.ToolResult) (agent.ToolResult, error) {
	err := errors.New("computer permission was revoked; the in-flight operation was interrupted where possible. Inspect this result before continuing in isolated computation; persistent computer access is no longer allowed")
	// Canonical tool history uses Output even when Call also returns an error.
	var output map[string]any
	if json.Unmarshal([]byte(result.Output), &output) != nil || output == nil {
		output = map[string]any{"result": result.Output}
	}
	output["error"] = err.Error()
	data, _ := json.Marshal(output)
	result.Output = string(data)
	return result, err
}

type artifactUpdate struct {
	SourcePath           string `json:"source_path"`
	ArtifactPath         string `json:"artifact_path"`
	LocalSourcePreserved bool   `json:"local_source_preserved"`
}

func (s *Server) prepareToolScope(ctx context.Context, scope agent.RunScope, bridge bridgeSource) ([]artifactUpdate, error) {
	// Parallel reads share staging, but staging/import itself changes the scope.
	// Serialize that short preparation per run, never lock the entire account.
	lock, _ := s.scopePreparations.LoadOrStore(scope.RunID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	effective, err := s.effectiveScope(ctx, scope)
	if err != nil {
		return nil, err
	}
	if effective.ComputeOnly != scope.ComputeOnly {
		return nil, errComputerModeChanged
	}
	key := scope.RunID + ":computer"
	if scope.ComputeOnly {
		key = scope.RunID + ":compute"
	}
	if _, prepared := s.preparedScopes.Load(key); prepared {
		if mode, ok := s.preparedScopes.Load(scope.RunID + ":last-mode"); ok && mode == scope.ComputeOnly {
			return nil, nil
		}
	}
	// A conversation may cross the permission boundary mid-turn. Copy only its
	// scratch directory, never a persistent Project/profile into computation.
	if !scope.ComputeOnly {
		_, used := s.preparedScopes.Load(scope.RunID + ":compute")
		if !used {
			if source, ok := bridge.(interface {
				ComputeExists(context.Context, string, string) (bool, error)
			}); ok {
				var err error
				used, err = source.ComputeExists(ctx, scope.UserID, scope.SessionID)
				if err != nil {
					return nil, err
				}
			}
		}
		if used {
			from := scope
			from.ComputeOnly = true
			status, _, bundle, err := bridge.Bridge(agent.WithRunScope(ctx, from), scope.UserID, http.MethodGet, "/workspace/export", nil)
			if err != nil || status >= 400 {
				return nil, bridgeError(status, bundle, err)
			}
			status, _, body, err := bridge.Bridge(agent.WithRunScope(ctx, scope), scope.UserID, http.MethodPost, "/workspace/import", bundle)
			if err != nil || status >= 400 {
				return nil, bridgeError(status, body, err)
			}
		}
	}
	items, err := s.store.SessionArtifacts(ctx, scope.UserID, scope.SessionID)
	if err != nil {
		return nil, err
	}
	// Explicit uploads from prior turns remain available after changing modes.
	inputs, err := s.store.SessionInputArtifacts(ctx, scope.UserID, scope.SessionID)
	if err != nil {
		return nil, err
	}
	items = append(items, inputs...)
	for _, item := range items {
		if _, err := s.stageArtifact(ctx, scope, item, bridge); err != nil {
			// An inaccessible attachment must not disable unrelated ordinary
			// tools. read_artifact still returns the exact failure when requested.
			log.Printf("stage prior artifact %s: %v", item.ID, err)
		}
	}
	updates := []artifactUpdate{}
	for source, versions := range sameSessionArtifactVersions(items, scope) {
		latest := versions[len(versions)-1]
		data, err := artifactBytes(latest)
		if err != nil {
			log.Printf("restore latest artifact %s: %v", latest.ID, err)
			continue
		}
		digests := []string{}
		for _, item := range versions {
			if digest := publishedDigest(item.Path); digest != "" {
				digests = append(digests, digest)
			}
		}
		if len(digests) == 0 {
			digests = []string{"absent"}
		}
		status, _, body, err := bridge.Bridge(agent.WithRunScope(ctx, scope), scope.UserID, http.MethodPut, "/file?path="+url.QueryEscape(source)+"&if_digest="+url.QueryEscape(strings.Join(digests, ",")), data)
		if err != nil || status >= 400 {
			log.Printf("restore latest artifact source %s: %v", latest.ID, bridgeError(status, body, err))
			continue
		}
		var result struct {
			Conflict bool `json:"source_conflict"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if result.Conflict {
			updates = append(updates, artifactUpdate{SourcePath: source, ArtifactPath: latest.Attachment().Path, LocalSourcePreserved: true})
		}
	}
	s.preparedScopes.Store(key, true)
	s.preparedScopes.Store(scope.RunID+":last-mode", scope.ComputeOnly)
	return updates, nil
}

func withArtifactUpdates(result agent.ToolResult, updates []artifactUpdate) agent.ToolResult {
	if len(updates) == 0 {
		return result
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(result.Output), &output); err != nil || output == nil {
		output = map[string]any{"result": result.Output}
	}
	output["artifact_updates"] = updates
	data, _ := json.Marshal(output)
	result.Output = string(data)
	return result
}

func (s *Server) stageArtifact(ctx context.Context, scope agent.RunScope, item storage.Artifact, bridge bridgeSource) (agent.Attachment, error) {
	data, err := artifactBytes(item)
	if err != nil {
		return agent.Attachment{}, err
	}
	attachment := item.Attachment()
	path := attachment.Path
	status, _, body, err := bridge.Bridge(agent.WithRunScope(ctx, scope), scope.UserID, http.MethodPut, "/file?if_missing=1&path="+url.QueryEscape(path), data)
	if err != nil || status >= 400 {
		return attachment, bridgeError(status, body, err)
	}
	return attachment, nil
}

func publishedDigest(path string) string {
	if !strings.HasPrefix(path, "/data/published/") {
		return ""
	}
	digest := filepath.Base(filepath.Dir(path))
	if len(digest) != 20 {
		return ""
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return ""
	}
	return digest
}

func sameSessionArtifactVersions(items []storage.Artifact, scope agent.RunScope) map[string][]storage.Artifact {
	versions := map[string][]storage.Artifact{}
	for _, item := range items {
		if item.RunID == "" || item.SessionID != scope.SessionID || item.SourcePath == "" {
			continue
		}
		clean := filepath.Clean(item.SourcePath)
		if !strings.HasPrefix(clean, filepath.Clean(scope.CWD)+"/") {
			continue
		}
		versions[clean] = append(versions[clean], item)
	}
	for source, items := range versions {
		slices.SortStableFunc(items, func(a, b storage.Artifact) int {
			if a.Version != b.Version {
				return a.Version - b.Version
			}
			return a.CreatedAt.Compare(b.CreatedAt)
		})
		versions[source] = items
	}
	return versions
}

func contextWithoutScope(ctx context.Context) context.Context {
	return agent.WithRunScope(ctx, agent.RunScope{})
}

func (s *Server) readArtifactTool(ctx context.Context, scope agent.RunScope, args json.RawMessage) (agent.ToolResult, error) {
	var input struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return agent.ToolResult{}, err
	}
	item, err := s.store.GetArtifact(ctx, scope.UserID, input.ID)
	if err != nil {
		return agent.ToolResult{}, err
	}
	bridge, err := s.bridgeSource()
	if err != nil {
		return agent.ToolResult{}, err
	}
	attachment, err := s.stageArtifact(ctx, scope, item, bridge)
	if err != nil {
		return agent.ToolResult{}, fmt.Errorf("read artifact: %w", err)
	}
	data, _ := json.Marshal(attachment)
	return agent.ToolResult{Output: string(data)}, nil
}
