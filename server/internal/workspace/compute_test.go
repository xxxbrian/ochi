package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"ochi/server/internal/agent"
)

func TestComputeHasOnlyOrdinaryTools(t *testing.T) {
	var all []agent.ToolDefinition
	if err := json.Unmarshal(intrinsicTools, &all); err != nil {
		t.Fatal(err)
	}
	items := computeDefinitions(all)
	if len(items) != 5 {
		t.Fatalf("ordinary catalogue contains %d tools", len(items))
	}
	for _, d := range items {
		if d.Name != "exec" && d.Name != "files_list" && d.Name != "files_read" && d.Name != "files_write" && d.Name != "web_fetch" {
			t.Fatalf("privileged tool exposed: %s", d.Name)
		}
	}
	if computeContainer("user", "first") == computeContainer("user", "second") || computeContainer("user", "first") == computeContainer("other", "first") {
		t.Fatal("scratch container identity crosses conversation/user boundary")
	}
}

func TestComputeImageUpdatesOnlyStoppedContainers(t *testing.T) {
	name := computeContainer("fixture-user", "fixture-session")
	inspect := "GET /v1.44/containers/" + name + "/json"
	image := "GET /v1.44/images/ochi-workspace:local/json"
	remove := "DELETE /v1.44/containers/" + name
	create := "POST /v1.44/containers/create?name=" + name
	start := "POST /v1.44/containers/" + name + "/start"
	for _, tc := range []struct {
		name         string
		exists       bool
		running      bool
		actualID     string
		configuredID string
		imageStatus  int
		want         []string
	}{
		{name: "new", want: []string{inspect, create, start}},
		{name: "running old image", exists: true, running: true, actualID: "sha256:old", want: []string{inspect}},
		{name: "stopped current image", exists: true, actualID: "sha256:current", configuredID: "sha256:current", want: []string{inspect, image, start}},
		{name: "stopped outdated image", exists: true, actualID: "sha256:old", configuredID: "sha256:new", want: []string{inspect, image, remove, create, start}},
		{name: "configured image not pulled", exists: true, actualID: "sha256:old", imageStatus: http.StatusNotFound, want: []string{inspect, image, start}},
		{name: "configured image inspection unavailable", exists: true, actualID: "sha256:old", imageStatus: http.StatusInternalServerError, want: []string{inspect, image, start}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDocker(Config{})
			var calls []string
			d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				call := r.Method + " " + r.URL.RequestURI()
				calls = append(calls, call)
				switch call {
				case inspect:
					if !tc.exists {
						return workspaceResponse(http.StatusNotFound, `{}`), nil
					}
					return workspaceResponse(http.StatusOK, fmt.Sprintf(`{"Image":%q,"State":{"Running":%t}}`, tc.actualID, tc.running)), nil
				case image:
					if tc.imageStatus != 0 {
						return workspaceResponse(tc.imageStatus, `{}`), nil
					}
					return workspaceResponse(http.StatusOK, fmt.Sprintf(`{"Id":%q}`, tc.configuredID)), nil
				case remove:
					if tc.running {
						t.Fatal("replaced running computation")
					}
				case create:
					var input struct {
						Image      string
						HostConfig struct {
							Mounts []struct{ Type, Source, Target string }
						}
					}
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
						t.Fatal(err)
					}
					if input.Image != d.config.Image || len(input.HostConfig.Mounts) != 1 {
						t.Fatalf("incorrect compute container configuration: %+v", input)
					}
					mount := input.HostConfig.Mounts[0]
					if mount.Type != "volume" || mount.Source != name+"-data" || mount.Target != "/data" {
						t.Fatalf("compute update changed persistent data mount: %+v", mount)
					}
				case start:
				default:
					t.Fatalf("unexpected operation (volumes must not be removed): %s", call)
				}
				return workspaceResponse(http.StatusOK, `{}`), nil
			})
			d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				return workspaceResponse(http.StatusOK, `{}`), nil
			})
			for range 2 {
				if _, err := d.ensureCompute(context.Background(), "fixture-user", "fixture-session"); err != nil {
					t.Fatal(err)
				}
			}
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("incorrect computation update operations: got %v, want %v", calls, tc.want)
			}
		})
	}
}
