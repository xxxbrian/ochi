package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

type pluginComponent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type pluginComponents struct {
	Skills []pluginComponent `json:"skills"`
	MCP    []pluginComponent `json:"mcp"`
}

func (s *Server) registerPluginRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/plugins", s.auth.require(s.listUserPlugins))
	mux.HandleFunc("PATCH /api/plugins/{id}", s.auth.require(s.setUserPlugin))
	mux.HandleFunc("GET /api/admin/plugins", s.auth.admin(s.listAdminPlugins))
	mux.HandleFunc("POST /api/admin/plugins", s.auth.admin(s.saveAdminPlugin))
	mux.HandleFunc("PATCH /api/admin/plugins/{id}", s.auth.admin(s.saveAdminPlugin))
	mux.HandleFunc("DELETE /api/admin/plugins/{id}", s.auth.admin(s.deleteAdminPlugin))
	mux.HandleFunc("GET /api/admin/plugins/components", s.auth.admin(s.listPluginComponents))
}

func (s *Server) pluginComponents(ctx context.Context) (pluginComponents, error) {
	values := pluginComponents{Skills: []pluginComponent{}, MCP: []pluginComponent{}}
	bridge, err := s.bridgeSource()
	if err != nil {
		return values, err
	}
	for _, kind := range []string{"skills", "mcp"} {
		status, _, raw, err := bridge.Bridge(ctx, "__admin__", http.MethodGet, "/extensions/"+kind, nil)
		if err != nil {
			return values, err
		}
		if status >= 400 {
			return values, errors.New("could not read administrator plugin components")
		}
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return values, errors.New("invalid extension metadata")
		}
		raw = envelope[kind]
		var items []pluginComponent
		if err = json.Unmarshal(raw, &items); err != nil || items == nil {
			return values, errors.New("invalid extension metadata")
		}
		seen := map[string]bool{}
		for _, item := range items {
			if item.ID == "" || seen[item.ID] {
				return values, errors.New("invalid extension component ID")
			}
			seen[item.ID] = true
		}
		if kind == "skills" {
			values.Skills = items
		} else {
			values.MCP = items
		}
	}
	return values, nil
}

func (s *Server) listUserPlugins(w http.ResponseWriter, r *http.Request) {
	values, err := s.store.UserPlugins(r.Context(), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, values)
}

func (s *Server) setUserPlugin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		writeError(w, http.StatusBadRequest, errors.New("enabled is required"))
		return
	}
	value, err := s.store.SetUserPlugin(r.Context(), currentUser(r).ID, r.PathValue("id"), *input.Enabled)
	if err != nil {
		writePluginError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) listAdminPlugins(w http.ResponseWriter, r *http.Request) {
	values, err := s.store.ListPlugins(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, values)
}

func (s *Server) listPluginComponents(w http.ResponseWriter, r *http.Request) {
	values, err := s.pluginComponents(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("插件组件暂时不可用，请重试"))
		return
	}
	writeJSON(w, http.StatusOK, values)
}

type pluginPatch struct {
	ID             *string   `json:"id"`
	Name           *string   `json:"name"`
	Description    *string   `json:"description"`
	Enabled        *bool     `json:"enabled"`
	DefaultEnabled *bool     `json:"default_enabled"`
	SkillIDs       *[]string `json:"skill_ids"`
	MCPIDs         *[]string `json:"mcp_ids"`
}

func (s *Server) saveAdminPlugin(w http.ResponseWriter, r *http.Request) {
	var input pluginPatch
	if !decodeRequest(w, r, &input) {
		return
	}
	s.extensionMu.Lock()
	defer s.extensionMu.Unlock()
	create := r.Method == http.MethodPost
	value := storage.Plugin{Enabled: true, SkillIDs: []string{}, MCPIDs: []string{}}
	if !create {
		var err error
		value, err = s.store.GetPlugin(r.Context(), r.PathValue("id"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	previous := value
	if input.ID != nil {
		if !create && *input.ID != value.ID {
			writeError(w, http.StatusBadRequest, errors.New("plugin ID cannot be changed"))
			return
		}
		value.ID = *input.ID
	}
	if input.Name != nil {
		value.Name = strings.TrimSpace(*input.Name)
	}
	if input.Description != nil {
		value.Description = strings.TrimSpace(*input.Description)
	}
	if input.Enabled != nil {
		value.Enabled = *input.Enabled
	}
	if input.DefaultEnabled != nil {
		value.DefaultEnabled = *input.DefaultEnabled
	}
	if input.SkillIDs != nil {
		value.SkillIDs = *input.SkillIDs
	}
	if input.MCPIDs != nil {
		value.MCPIDs = *input.MCPIDs
	}
	if err := storage.ValidatePlugin(value); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if create || !sameComponentIDs(previous.SkillIDs, value.SkillIDs) || !sameComponentIDs(previous.MCPIDs, value.MCPIDs) {
		components, err := s.pluginComponents(r.Context())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, errors.New("插件组件暂时不可用，请重试"))
			return
		}
		for kind, requested := range map[string][]string{"skills": value.SkillIDs, "mcp": value.MCPIDs} {
			items := components.Skills
			if kind == "mcp" {
				items = components.MCP
			}
			known := map[string]bool{}
			for _, item := range items {
				known[item.ID] = true
			}
			for _, id := range requested {
				if !known[id] {
					writeError(w, http.StatusBadRequest, fmt.Errorf("unknown %s component %q", kind, id))
					return
				}
			}
		}
	}
	value, err := s.store.SavePlugin(r.Context(), value, create)
	if err != nil {
		writePluginError(w, err)
		return
	}
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	writeJSON(w, status, value)
}

func sameComponentIDs(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

func (s *Server) deleteAdminPlugin(w http.ResponseWriter, r *http.Request) {
	s.extensionMu.Lock()
	defer s.extensionMu.Unlock()
	if err := s.store.DeletePlugin(r.Context(), r.PathValue("id")); err != nil {
		writePluginError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writePluginError(w http.ResponseWriter, err error) {
	if errors.Is(err, storage.ErrPluginLocked) || errors.Is(err, storage.ErrPluginConflict) {
		writeError(w, http.StatusConflict, err)
		return
	}
	writeStoreError(w, err)
}

func (p *personalTools) pluginContext(ctx context.Context, userID string) (context.Context, error) {
	access := agent.ExtensionAccess{Skills: []string{}, MCP: []string{}}
	scope, scoped := agent.ScopeFromContext(ctx)
	if !scoped || scope.ComputeOnly || scope.UserID != userID || scope.SessionID == "" {
		return agent.WithExtensionAccess(ctx, access), nil
	}
	skills, mcp, err := p.server.store.EffectivePluginComponents(ctx, userID)
	if err != nil {
		return ctx, err
	}
	access.Skills, access.MCP = skills, mcp
	return agent.WithExtensionAccess(ctx, access), nil
}
