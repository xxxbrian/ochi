package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func workspaceResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}

func TestEnsureWorkspaceUsesImageOwnedDirectories(t *testing.T) {
	name := userContainer("fixture-user")
	inspect := "GET /v1.44/containers/" + name + "/json"
	start := "POST /v1.44/containers/" + name + "/start"
	create := "POST /v1.44/containers/create?name=" + name
	for _, tc := range []struct {
		name     string
		exists   bool
		running  bool
		expected []string
	}{
		{name: "running", exists: true, running: true, expected: []string{inspect}},
		{name: "stopped", exists: true, expected: []string{inspect, start}},
		{name: "new", expected: []string{inspect, create, start}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDocker(Config{})
			var calls []string
			d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				call := r.Method + " " + r.URL.RequestURI()
				calls = append(calls, call)
				status, body := http.StatusOK, `{}`
				switch call {
				case inspect:
					body = `{"State":{"Running":false}}`
					if !tc.exists {
						status = http.StatusNotFound
					} else if tc.running {
						body = `{"State":{"Running":true}}`
					}
				case create:
					status = http.StatusCreated
				case start:
				default:
					t.Errorf("unexpected workspace attach operation: %s", call)
					status = http.StatusInternalServerError
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodGet || r.URL.Host != name+":8080" || r.URL.Path != "/health" {
					t.Errorf("unexpected bridge request: %s %s", r.Method, r.URL)
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})
			for range 2 {
				address, err := d.ensure(context.Background(), "fixture-user")
				if err != nil || address != "http://"+name+":8080" {
					t.Fatalf("ensure workspace: %s %v", address, err)
				}
			}
			if !reflect.DeepEqual(calls, tc.expected) {
				t.Fatalf("workspace attach operations: got %v, want %v", calls, tc.expected)
			}
		})
	}
}

func TestInspectWorkspaceImageIdentity(t *testing.T) {
	image := "registry.example/ochi-workspace@sha256:configured"
	for _, tc := range []struct {
		name          string
		actualRef     string
		actualID      string
		configuredID  string
		imageStatus   int
		containerGone bool
		wantAvailable *bool
	}{
		{name: "current pinned image", actualRef: image, actualID: "sha256:current", configuredID: "sha256:current", wantAvailable: boolPointer(false)},
		{name: "same tag changed image", actualRef: image, actualID: "sha256:old", configuredID: "sha256:new", wantAvailable: boolPointer(true)},
		{name: "different ref same image", actualRef: "ochi-workspace:local", actualID: "sha256:current", configuredID: "sha256:current", wantAvailable: boolPointer(false)},
		{name: "image not pulled", actualRef: image, actualID: "sha256:old", imageStatus: http.StatusNotFound},
		{name: "image inspect unavailable", actualRef: image, actualID: "sha256:old", imageStatus: http.StatusInternalServerError},
		{name: "container not created", containerGone: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDocker(Config{Image: image})
			d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
				switch r.Method + " " + r.URL.RequestURI() {
				case "GET /v1.44/containers/" + userContainer("fixture-user") + "/json":
					if tc.containerGone {
						return workspaceResponse(http.StatusNotFound, `{}`), nil
					}
					body := fmt.Sprintf(`{"Image":%q,"Config":{"Image":%q},"State":{"Running":true,"Status":"running"}}`, tc.actualID, tc.actualRef)
					return workspaceResponse(http.StatusOK, body), nil
				case "GET /v1.44/images/" + url.PathEscape(image) + "/json":
					if tc.containerGone {
						t.Fatal("nonexistent workspace does not need image comparison")
					}
					if tc.imageStatus != 0 {
						return workspaceResponse(tc.imageStatus, `{}`), nil
					}
					return workspaceResponse(http.StatusOK, fmt.Sprintf(`{"Id":%q}`, tc.configuredID)), nil
				default:
					t.Fatalf("unexpected request: %s %s", r.Method, r.URL)
					return nil, nil
				}
			})
			state, err := d.Inspect(context.Background(), "fixture-user")
			if err != nil {
				t.Fatal(err)
			}
			if state.ConfiguredImage != image || state.ImageID != tc.actualID || state.ConfiguredImageID != tc.configuredID || !reflect.DeepEqual(state.UpdateAvailable, tc.wantAvailable) {
				t.Fatalf("incorrect image identity: %+v", state)
			}
			if tc.containerGone {
				if state.State != "not_created" || state.Running {
					t.Fatalf("incorrect nonexistent workspace state: %+v", state)
				}
			} else if state.State != "running" || !state.Running || state.Image != tc.actualRef {
				t.Fatalf("image lookup changed container status: %+v", state)
			}
		})
	}
}

func boolPointer(value bool) *bool { return &value }

func TestEnsureWorkspaceNeverReplacesExistingImage(t *testing.T) {
	d := NewDocker(Config{Image: "ochi-workspace:new"})
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1.44/containers/"+userContainer("fixture-user")+"/json" {
			t.Fatalf("existing desktop was modified: %s %s", r.Method, r.URL)
		}
		return workspaceResponse(http.StatusOK, `{"Image":"sha256:old","Config":{"Image":"ochi-workspace:old"},"State":{"Running":true}}`), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		return workspaceResponse(http.StatusOK, `{}`), nil
	})
	if _, err := d.ensure(context.Background(), "fixture-user"); err != nil {
		t.Fatal(err)
	}
}

func TestRebuildWorkspacePreservesNamedVolumes(t *testing.T) {
	userID := "fixture-user"
	name := userContainer(userID)
	d := NewDocker(Config{Image: "ochi-workspace:new"})
	created, removed, running := false, false, true
	var calls []string
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		call := r.Method + " " + r.URL.RequestURI()
		calls = append(calls, call)
		switch call {
		case "GET /v1.44/images/ochi-workspace:new/json":
			return workspaceResponse(http.StatusOK, `{"Id":"sha256:new"}`), nil
		case "GET /v1.44/containers/" + name + "/json":
			if removed && !created {
				return workspaceResponse(http.StatusNotFound, `{}`), nil
			}
			image := "old"
			if created {
				image = "new"
			}
			return workspaceResponse(http.StatusOK, fmt.Sprintf(`{"Image":"sha256:%s","Config":{"Image":"ochi-workspace:%s"},"State":{"Running":%t,"Status":"running"}}`, image, image, running)), nil
		case "POST /v1.44/containers/" + name + "/stop?t=15":
			running = false
		case "DELETE /v1.44/containers/" + name:
			if running {
				t.Fatal("deleted a running workspace")
			}
			removed = true
		case "POST /v1.44/containers/create?name=" + name:
			var input struct {
				Image      string
				HostConfig struct {
					Mounts []struct {
						Type, Source, Target string
						ReadOnly             bool
					}
				}
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.Image != d.config.Image || len(input.HostConfig.Mounts) != 2 {
				t.Fatalf("incorrect rebuilt workspace configuration: %+v", input)
			}
			data, extensions := input.HostConfig.Mounts[0], input.HostConfig.Mounts[1]
			if data.Type != "volume" || data.Source != name+"-data" || data.Target != "/data" || extensions.Source != "ochi-extensions" || extensions.Target != "/opt/extensions" || !extensions.ReadOnly {
				t.Fatalf("workspace rebuild changed persistent mounts: %+v", input.HostConfig.Mounts)
			}
			created = true
		case "POST /v1.44/containers/" + name + "/start":
			running = true
		default:
			t.Fatalf("unexpected operation (volumes must not be removed): %s", call)
		}
		return workspaceResponse(http.StatusOK, `{}`), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		return workspaceResponse(http.StatusOK, `{}`), nil
	})
	state, err := d.Manage(context.Background(), userID, "rebuild")
	if err != nil {
		t.Fatal(err)
	}
	if !removed || !created || !state.Running || state.ImageID != "sha256:new" || state.UpdateAvailable == nil || *state.UpdateAvailable {
		t.Fatalf("workspace was not rebuilt to configured image: %+v; calls: %v", state, calls)
	}
}

func TestRebuildWorkspaceChecksImageBeforeStopping(t *testing.T) {
	d := NewDocker(Config{Image: "ochi-workspace:missing"})
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1.44/images/ochi-workspace:missing/json" {
			t.Fatalf("unavailable image caused workspace modification: %s %s", r.Method, r.URL)
		}
		return workspaceResponse(http.StatusNotFound, `{"message":"No such image"}`), nil
	})
	if _, err := d.Manage(context.Background(), "fixture-user", "rebuild"); err == nil {
		t.Fatal("rebuild accepted a missing image")
	}
}
