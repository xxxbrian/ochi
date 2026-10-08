package storage

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPluginValidation(t *testing.T) {
	valid := Plugin{ID: "research", Name: "Research", SkillIDs: []string{"research"}, MCPIDs: []string{"web"}}
	for _, mutate := range []func(*Plugin){
		func(p *Plugin) { p.ID = "../outside" },
		func(p *Plugin) { p.Name = " " },
		func(p *Plugin) { p.Description = strings.Repeat("x", 4001) },
		func(p *Plugin) { p.SkillIDs, p.MCPIDs = nil, nil },
		func(p *Plugin) { p.SkillIDs = []string{"same", "same"} },
		func(p *Plugin) { p.MCPIDs = []string{"invalid/path"} },
	} {
		invalid := valid
		mutate(&invalid)
		if err := ValidatePlugin(invalid); err == nil {
			t.Fatal("invalid plugin was accepted")
		}
	}
	if err := ValidatePlugin(valid); err != nil {
		t.Fatal(err)
	}
}

func TestPluginPolicyPersistenceAndOwnership(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	for _, user := range []string{"plugin-one", "plugin-two"} {
		if _, err := s.db.Exec(ctx, `INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,$1,'not-a-login')`, user); err != nil {
			t.Fatal(err)
		}
	}
	plugins, err := s.ListPlugins(ctx)
	if err != nil || len(plugins) != 0 {
		t.Fatal("new catalog was not empty", err)
	}
	mandatory := Plugin{ID: "required", Name: "Required", Enabled: true, DefaultEnabled: true, SkillIDs: []string{"built-in"}, MCPIDs: []string{}}
	if _, err := s.SavePlugin(ctx, mandatory, true); err != nil {
		t.Fatal(err)
	}
	optional, err := s.SavePlugin(ctx, Plugin{ID: "optional", Name: "Optional", Enabled: true, SkillIDs: []string{"helper"}, MCPIDs: []string{"docs"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetUserPlugin(ctx, "plugin-one", mandatory.ID, false); !errors.Is(err, ErrPluginLocked) {
		t.Fatal("forged mandatory disable was accepted", err)
	}
	if _, err = s.SetUserPlugin(ctx, "plugin-one", optional.ID, true); err != nil {
		t.Fatal(err)
	}
	other, err := s.UserPlugins(ctx, "plugin-two")
	if err != nil || len(other) != 2 {
		t.Fatal(err)
	}
	for _, p := range other {
		if p.ID == optional.ID && p.EffectiveEnabled {
			t.Fatal("one user's preference leaked to another")
		}
	}
	check := func(user string, wantSkills, wantMCP []string) {
		t.Helper()
		skills, mcp, err := s.EffectivePluginComponents(ctx, user)
		if err != nil || !reflect.DeepEqual(skills, wantSkills) || !reflect.DeepEqual(mcp, wantMCP) {
			t.Fatalf("unexpected live policy for %s: skills=%v mcp=%v err=%v", user, skills, mcp, err)
		}
	}
	check("plugin-one", []string{"built-in", "helper"}, []string{"docs"})
	check("plugin-two", []string{"built-in"}, []string{})
	copy := optional
	copy.ID, copy.SkillIDs, copy.MCPIDs = "conflict", []string{"new-component"}, []string{"docs"}
	if _, err = s.SavePlugin(ctx, copy, true); !errors.Is(err, ErrPluginConflict) {
		t.Fatal("shared component ownership accepted", err)
	}
	if owner, err := s.PluginForComponent(ctx, "skills", "new-component"); err != nil || owner != "" {
		t.Fatal("failed write left partial component ownership")
	}
	optional.Enabled = false
	if _, err = s.SavePlugin(ctx, optional, false); err != nil {
		t.Fatal(err)
	}
	check("plugin-one", []string{"built-in"}, []string{})
	optional.Enabled = true
	optional, err = s.SavePlugin(ctx, optional, false)
	if err != nil {
		t.Fatal(err)
	}
	// Read from a new Store value to rule out an in-process preference cache.
	reopened := &Store{db: s.db}
	persisted, err := reopened.UserPlugins(ctx, "plugin-one")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range persisted {
		found = found || (p.ID == optional.ID && p.EffectiveEnabled)
	}
	if !found {
		t.Fatal("enabled preference was not persisted")
	}
	if err := s.DeletePlugin(ctx, optional.ID); err != nil {
		t.Fatal(err)
	}
	check("plugin-one", []string{"built-in"}, []string{})
	if owner, err := s.PluginForComponent(ctx, "mcp", "docs"); err != nil || owner != "" {
		t.Fatal("plugin deletion did not release its component")
	}
}
