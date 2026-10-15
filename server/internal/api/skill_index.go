package api

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"

	"ochi/server/internal/agent"
)

type skillIndexCache struct {
	mu     sync.Mutex
	loaded bool
	value  string
}

type skillMetadata struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source,omitempty"`
}

type skillMetadataIndex struct {
	Skills      []skillMetadata `json:"skills"`
	Total       int             `json:"total"`
	Truncated   bool            `json:"truncated"`
	Unavailable []string        `json:"unavailable_sources,omitempty"`
}

// Whitelist metadata so an installed index cannot smuggle instruction bodies
// into the automatic prompt. Private and installed methods share one budget.
func mergeSkillsIndex(private, installed string, unavailable []string) string {
	result := skillMetadataIndex{Skills: []skillMetadata{}, Unavailable: unavailable}
	seen := map[string]bool{}
	for _, raw := range []string{private, installed} {
		var index skillMetadataIndex
		if json.Unmarshal([]byte(raw), &index) != nil {
			continue
		}
		result.Total += index.Total
		result.Truncated = result.Truncated || index.Truncated
		sort.Slice(index.Skills, func(i, j int) bool { return index.Skills[i].ID < index.Skills[j].ID })
		for _, item := range index.Skills {
			if strings.TrimSpace(item.ID) == "" || len(item.ID) > 160 || seen[item.ID] {
				continue
			}
			item.Name = compactText(item.Name, 64)
			item.Description = compactText(item.Description, 240)
			if strings.HasPrefix(item.ID, "private:") {
				item.Source = "private_verified_method"
			} else {
				item.Source = "installed_metadata"
			}
			seen[item.ID] = true
			if len(result.Skills) >= 32 {
				result.Truncated = true
				continue
			}
			result.Skills = append(result.Skills, item)
			data, _ := json.Marshal(result)
			if len(data) > 8*1024-64 {
				result.Skills = result.Skills[:len(result.Skills)-1]
				result.Truncated = true
			}
		}
	}
	if result.Total < len(result.Skills) {
		result.Total = len(result.Skills)
	}
	data, _ := json.Marshal(result)
	return string(data)
}

func (p *personalTools) ForgetSkillsIndex(userID, runID string) {
	p.skillIndexes.Delete(userID + "\x00" + runID)
}

func (p *personalTools) cachedSkillsIndex(ctx context.Context, userID string) (string, error) {
	scope, ok := agent.ScopeFromContext(ctx)
	if !ok || scope.RunID == "" || scope.ComputeOnly {
		return "", nil
	}
	item, _ := p.skillIndexes.LoadOrStore(userID+"\x00"+scope.RunID, &skillIndexCache{})
	cache := item.(*skillIndexCache)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	child, done, err := p.server.computerCallContext(ctx, scope)
	if err != nil {
		return "", err
	}
	defer done()
	unavailable := []string{}
	if !cache.loaded {
		cache.value, err = p.server.privateSkillsIndex(child, userID)
		if err != nil {
			unavailable = append(unavailable, "private")
		} else {
			cache.loaded = true
		}
	}
	installed := ""
	if source, ok := p.source.(agent.SkillIndexSource); ok {
		// Installed metadata and its allowlist stay live after plugin toggles.
		// Only owner-private verified metadata is cached for the run.
		child, err = p.pluginContext(child, userID)
		if err != nil {
			return "", err
		}
		installed, err = source.SkillsIndex(child, userID)
		if err != nil {
			unavailable = append(unavailable, "installed")
		}
	} else {
		unavailable = append(unavailable, "installed")
	}
	if child.Err() != nil {
		return "", child.Err()
	}
	value := mergeSkillsIndex(cache.value, installed, unavailable)
	if len(unavailable) > 0 {
		return value, errors.New("some skill metadata sources were unavailable")
	}
	return value, nil
}
