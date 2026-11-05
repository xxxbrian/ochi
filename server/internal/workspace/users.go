package workspace

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

var ErrUserBusy = errors.New("user workspace has active work")

type userDataTarget struct {
	key, name, sessionID string
}

type userContainerState struct {
	ID     string
	Names  []string
	Labels map[string]string
	State  string
	Mounts []struct {
		Type, Name, Destination string
		RW                      bool
	}
}

func (v userContainerState) mounts(name string) bool {
	for _, mount := range v.Mounts {
		if mount.Type == "volume" && mount.Name == name {
			return true
		}
	}
	return false
}

func (v userContainerState) named(name string) bool {
	for _, candidate := range v.Names {
		if strings.TrimPrefix(candidate, "/") == name {
			return true
		}
	}
	return false
}

func (v userContainerState) owned(target userDataTarget) bool {
	if v.Labels["app"] != "ochi" {
		return false
	}
	if target.sessionID == "" {
		return v.Labels["workspace"] == target.name
	}
	return v.Labels["scope"] == "compute" && v.Labels["session"] == target.sessionID
}

func (d *Docker) userContainers(ctx context.Context) ([]userContainerState, error) {
	var containers []userContainerState
	_, err := d.request(ctx, http.MethodGet, "/containers/json?all=true", nil, &containers)
	return containers, err
}

func userDataTargets(userID string, sessionIDs []string, containers []userContainerState) (map[string]userDataTarget, error) {
	desktop := userContainer(userID)
	targets := map[string]userDataTarget{
		desktop + "-data": {key: userID, name: desktop},
	}
	addCompute := func(sessionID string) {
		if sessionID != "" {
			name := computeContainer(userID, sessionID)
			targets[name+"-data"] = userDataTarget{key: name, name: name, sessionID: sessionID}
		}
	}
	for _, sessionID := range sessionIDs {
		addCompute(sessionID)
	}
	// A missing conversation would lose the only durable mapping to its data
	// volume if container deletion succeeded but volume deletion failed.
	for _, container := range containers {
		sessionID := container.Labels["session"]
		if container.Labels["app"] == "ochi" && container.Labels["scope"] == "compute" &&
			sessionID != "" && container.mounts(computeContainer(userID, sessionID)+"-data") {
			if _, exists := targets[computeContainer(userID, sessionID)+"-data"]; !exists {
				return nil, errors.New("user has computation data without a recorded conversation")
			}
		}
	}
	return targets, nil
}

func ownedUserContainers(containers []userContainerState, targets map[string]userDataTarget) ([]userContainerState, error) {
	owned := []userContainerState{}
	for _, container := range containers {
		found := false
		for volume, target := range targets {
			consumes := container.mounts(volume)
			desktopOwner := target.sessionID == "" && container.owned(target)
			if !consumes && !container.named(target.name) && !desktopOwner {
				continue
			}
			if !consumes || !container.owned(target) {
				return nil, errors.New("user data has an unrecognized container owner")
			}
			for _, mount := range container.Mounts {
				if mount.Type == "volume" && mount.Name == volume && mount.Destination == "/data" {
					found = true
				} else if target.sessionID == "" && mount.Type == "volume" &&
					mount.Name != "ochi-plugin-control" && mount.Destination == "/opt/extensions" && !mount.RW {
					continue
				} else {
					return nil, errors.New("user container has an unrecognized data mount")
				}
			}
			if !found {
				return nil, errors.New("user container has no owned data mount")
			}
		}
		if found {
			if container.ID == "" || len(container.Names) == 0 {
				return nil, errors.New("user container identity is incomplete")
			}
			owned = append(owned, container)
		}
	}
	sort.Slice(owned, func(i, j int) bool { return owned[i].ID < owned[j].ID })
	return owned, nil
}

// RemoveUser removes only this user's execution containers and exact data
// volumes. The caller must close user admission before taking this snapshot.
// Every liveness/ownership check completes before the first destructive call.
func (d *Docker) RemoveUser(ctx context.Context, userID string, sessionIDs []string) error {
	if userID == "" || userID == "__admin__" {
		return errors.New("shared plugin control cannot be removed")
	}
	containers, err := d.userContainers(ctx)
	if err != nil {
		return err
	}
	targets, err := userDataTargets(userID, sessionIDs, containers)
	if err != nil {
		return err
	}
	volumes := make([]string, 0, len(targets))
	keys := make([]string, 0, len(targets))
	for volume, target := range targets {
		volumes = append(volumes, volume)
		keys = append(keys, target.key)
	}
	sort.Strings(volumes)
	sort.Strings(keys)
	for _, key := range keys {
		unlock, err := d.lockWorkspace(ctx, key)
		if err != nil {
			return err
		}
		defer unlock()
	}
	d.mu.Lock()
	busy := false
	for _, key := range keys {
		busy = busy || d.active[key] > 0
	}
	d.mu.Unlock()
	if busy {
		return ErrUserBusy
	}
	containers, err = d.userContainers(ctx)
	if err != nil {
		return err
	}
	if _, err := userDataTargets(userID, sessionIDs, containers); err != nil {
		return err
	}
	owned, err := ownedUserContainers(containers, targets)
	if err != nil {
		return err
	}
	for _, container := range owned {
		switch container.State {
		case "created", "exited", "dead":
			continue
		case "running":
		default:
			return ErrUserBusy
		}
		name := strings.TrimPrefix(container.Names[0], "/")
		probeKey := "remove:" + container.ID
		defer func() {
			d.tokenMu.Lock()
			delete(d.tokens, probeKey)
			d.tokenMu.Unlock()
		}()
		address, running, err := d.existingBridge(ctx, name, probeKey)
		if err != nil {
			return err
		}
		if !running {
			continue
		}
		state, err := d.jobActivity(ctx, probeKey, address)
		if err != nil {
			return fmt.Errorf("check user workspace activity: %w", err)
		}
		if len(state.Jobs) > 0 || state.ActiveCalls > 0 {
			return ErrUserBusy
		}
	}
	defer d.forgetUser(userID, keys)
	for _, container := range owned {
		status, err := d.request(ctx, http.MethodDelete, "/containers/"+url.PathEscape(container.ID)+"?force=true", nil, nil)
		if err != nil && status != http.StatusNotFound {
			return fmt.Errorf("remove user container: %w", err)
		}
	}
	for _, volume := range volumes {
		status, err := d.request(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(volume), nil, nil)
		if err != nil && status != http.StatusNotFound {
			return fmt.Errorf("remove user data volume: %w", err)
		}
	}
	return nil
}

func (d *Docker) forgetUser(userID string, keys []string) {
	d.mu.Lock()
	for _, key := range keys {
		delete(d.urls, key)
		delete(d.lastUse, key)
	}
	d.mu.Unlock()
	d.tokenMu.Lock()
	for _, key := range keys {
		delete(d.tokens, key)
	}
	d.tokenMu.Unlock()
	d.catalogMu.Lock()
	for key := range d.discoveries {
		if strings.HasPrefix(key, userID+"\x00") {
			delete(d.discoveries, key)
		}
	}
	d.catalogMu.Unlock()
}
