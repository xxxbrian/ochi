package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	"ochi/server/internal/agent"
)

func computeContainer(userID, sessionID string) string {
	hash := sha256.Sum256([]byte(userID + ":" + sessionID))
	return "ochi-compute-" + hex.EncodeToString(hash[:10])
}

func computeDefinitions(definitions []agent.ToolDefinition) []agent.ToolDefinition {
	items := []agent.ToolDefinition{}
	for _, d := range definitions {
		switch d.Name {
		case "exec", "files_list", "files_read", "files_write", "web_fetch":
			if d.Name == "exec" {
				d.Description = "Run shell, Python or Node in this conversation's isolated computation container. Install dependencies with pip/npm, fetch public URLs, analyze uploaded data and generate working files. Files are not automatically published; use publish_file separately only for requested final files. It has no persistent computer, Project files, login profiles, desktop or MCP access. The conversation's scratch files and dependencies survive subsequent turns."
			}
			items = append(items, d)
		}
	}
	return items
}

func (d *Docker) ensureCompute(ctx context.Context, userID, sessionID string) (string, error) {
	if sessionID == "" {
		return "", errors.New("computation requires a conversation scope")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	name := computeContainer(userID, sessionID)
	if address := d.urls[name]; address != "" && d.healthy(ctx, address) {
		return address, nil
	}
	delete(d.urls, name)
	var inspect struct{ State struct{ Running bool } }
	status, err := d.request(ctx, http.MethodGet, "/containers/"+name+"/json", nil, &inspect)
	if err != nil && status != http.StatusNotFound {
		return "", err
	}
	if status == http.StatusNotFound {
		container := map[string]any{
			"Image": d.config.Image, "User": "root", "Env": []string{"COMPUTE_ONLY=1"},
			"Labels": map[string]string{"app": "ochi", "scope": "compute", "session": sessionID},
			"HostConfig": map[string]any{
				"NetworkMode": d.config.ComputeNetwork, "Memory": 2 * 1024 * 1024 * 1024, "NanoCpus": 2_000_000_000,
				"CapAdd": []string{"NET_ADMIN"}, "SecurityOpt": []string{"no-new-privileges:true"},
				"Mounts": []map[string]any{{"Type": "volume", "Source": name + "-data", "Target": "/data"}},
			},
		}
		if _, err = d.request(ctx, http.MethodPost, "/containers/create?name="+name, container, nil); err != nil {
			return "", fmt.Errorf("create computation: %w", err)
		}
	}
	if !inspect.State.Running {
		if _, err = d.request(ctx, http.MethodPost, "/containers/"+name+"/start", nil, nil); err != nil {
			return "", fmt.Errorf("start computation: %w", err)
		}
	}
	address := "http://" + name + ":8080"
	ready, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		if d.healthy(ready, address) {
			d.urls[name] = address
			return address, nil
		}
		select {
		case <-ready.Done():
			return "", errors.New("computation bridge did not become ready")
		case <-ticker.C:
		}
	}
}

// Scratch state belongs to a conversation, never a Project. Its immutable
// published downloads live in the server artifact store and survive deletion.
func (d *Docker) RemoveCompute(ctx context.Context, userID, sessionID string) error {
	name := computeContainer(userID, sessionID)
	d.mu.Lock()
	delete(d.urls, name)
	d.mu.Unlock()
	status, err := d.request(ctx, http.MethodDelete, "/containers/"+name+"?force=true", nil, nil)
	if err != nil && status != http.StatusNotFound {
		return err
	}
	status, err = d.request(ctx, http.MethodDelete, "/volumes/"+name+"-data", nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

func (d *Docker) ComputeExists(ctx context.Context, userID, sessionID string) (bool, error) {
	status, err := d.request(ctx, http.MethodGet, "/containers/"+computeContainer(userID, sessionID)+"/json", nil, nil)
	if status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}
