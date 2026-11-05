package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type userRemovalEngine struct {
	containers map[string]userContainerState
	volumes    map[string]bool
	fail       map[string]int
	mutations  []string
	activity   map[string]string
}

func removalContainer(id, name, volume string, labels map[string]string, running bool) userContainerState {
	state := "exited"
	if running {
		state = "running"
	}
	raw, _ := json.Marshal(map[string]any{
		"ID": id, "Names": []string{"/" + name}, "Labels": labels, "State": state,
		"Mounts": []map[string]any{{"Type": "volume", "Name": volume, "Destination": "/data", "RW": true}},
	})
	var item userContainerState
	_ = json.Unmarshal(raw, &item)
	return item
}

func removalDesktop(id, userID, name string, running bool) userContainerState {
	canonical := userContainer(userID)
	item := removalContainer(id, name, canonical+"-data", map[string]string{"app": "ochi", "workspace": canonical}, running)
	item.Mounts = append(item.Mounts, struct {
		Type, Name, Destination string
		RW                      bool
	}{Type: "volume", Name: "ochi-plugin-assets", Destination: "/opt/extensions"})
	return item
}

func (f *userRemovalEngine) docker(t *testing.T) *Docker {
	t.Helper()
	d := NewDocker(Config{})
	if f.fail == nil {
		f.fail = map[string]int{}
	}
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		call := r.Method + " " + r.URL.Path
		if r.Method != http.MethodGet {
			f.mutations = append(f.mutations, call)
		}
		if status := f.fail[call]; status != 0 {
			delete(f.fail, call)
			return workspaceResponse(status, `{"message":"fixture failure"}`), nil
		}
		if call == "GET /v1.44/containers/json" {
			if r.URL.Query().Get("all") != "true" {
				t.Fatal("stopped retained containers were excluded")
			}
			var items []userContainerState
			for _, item := range f.containers {
				items = append(items, item)
			}
			raw, _ := json.Marshal(items)
			return workspaceResponse(http.StatusOK, string(raw)), nil
		}
		for id, item := range f.containers {
			if call == "DELETE /v1.44/containers/"+id {
				if r.URL.Query().Get("force") != "true" {
					t.Fatal("idle running container was not removed explicitly")
				}
				delete(f.containers, id)
				return workspaceResponse(http.StatusNoContent, ""), nil
			}
			for _, name := range item.Names {
				if call == "GET /v1.44/containers"+name+"/json" {
					raw, _ := json.Marshal(map[string]any{
						"Config": map[string]any{"Env": []string{"OCHI_BRIDGE_TOKEN=" + fixtureToken}},
						"State":  map[string]bool{"Running": item.State == "running"},
					})
					return workspaceResponse(http.StatusOK, string(raw)), nil
				}
			}
		}
		if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/v1.44/volumes/") {
			name := strings.TrimPrefix(r.URL.Path, "/v1.44/volumes/")
			for _, container := range f.containers {
				if container.mounts(name) {
					return workspaceResponse(http.StatusConflict, `{"message":"volume in use"}`), nil
				}
			}
			if !f.volumes[name] {
				return workspaceResponse(http.StatusNotFound, "{}"), nil
			}
			delete(f.volumes, name)
			return workspaceResponse(http.StatusNoContent, ""), nil
		}
		if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/v1.44/containers/") {
			return workspaceResponse(http.StatusNotFound, "{}"), nil
		}
		t.Fatalf("unexpected Docker operation: %s", call)
		return nil, nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Path != "/jobs/active" || r.Header.Get("Authorization") != "Bearer "+fixtureToken {
			t.Fatalf("unexpected or unauthenticated bridge operation: %s %s", r.Method, r.URL.Path)
		}
		state := f.activity[r.URL.Hostname()]
		if state == "" {
			state = `{"jobs":[],"active_calls":0,"idle_seconds":0}`
		}
		return workspaceResponse(http.StatusOK, `{"ok":true,"result":`+state+`}`), nil
	})
	return d
}

func TestRemoveUserRemovesOnlyOwnedContainersAndData(t *testing.T) {
	userID, sessionID := "owner", "session"
	desktop, compute := userContainer(userID), computeContainer(userID, sessionID)
	retired := computeContainer(userID, "retained-conversation")
	other := userContainer("other")
	f := &userRemovalEngine{
		containers: map[string]userContainerState{
			"desktop": removalDesktop("desktop", userID, desktop, true),
			"retired": removalDesktop("retired", userID, desktop+"-pre-release", false),
			"compute": removalContainer("compute", compute, compute+"-data", map[string]string{"app": "ochi", "scope": "compute", "session": sessionID}, true),
			"old-compute": removalContainer("old-compute", retired+"-pre-release", retired+"-data",
				map[string]string{"app": "ochi", "scope": "compute", "session": "retained-conversation"}, false),
			"other":   removalDesktop("other", "other", other, true),
			"control": removalDesktop("control", "__admin__", userContainer("__admin__"), true),
		},
		volumes: map[string]bool{
			desktop + "-data": true, compute + "-data": true, retired + "-data": true,
			other + "-data": true, "ochi-plugin-assets": true, "ochi-plugin-control": true,
		},
	}
	d := f.docker(t)
	d.urls = map[string]string{userID: "old-desktop", compute: "old-compute", "other": "retained"}
	d.tokens = map[string]string{userID: "old-token", compute: "old-token", "other": "retained"}
	d.lastUse = map[string]time.Time{userID: time.Now(), compute: time.Now(), "other": time.Now()}
	d.discoveries = map[string]*runCatalog{userID + "\x00run": {}, "other\x00run": {}}
	if err := d.RemoveUser(context.Background(), userID, []string{sessionID, sessionID, "retained-conversation"}); err != nil {
		t.Fatal(err)
	}
	if len(f.containers) != 2 || f.containers["other"].ID == "" || f.containers["control"].ID == "" {
		t.Fatalf("other users/shared control changed: %#v", f.containers)
	}
	if len(f.volumes) != 3 || !f.volumes[other+"-data"] || !f.volumes["ochi-plugin-assets"] || !f.volumes["ochi-plugin-control"] {
		t.Fatalf("shared/unrelated volume changed: %#v", f.volumes)
	}
	if !reflect.DeepEqual(d.urls, map[string]string{"other": "retained"}) ||
		!reflect.DeepEqual(d.tokens, map[string]string{"other": "retained"}) ||
		len(d.lastUse) != 1 || len(d.discoveries) != 1 || d.discoveries["other\x00run"] == nil {
		t.Fatal("user caches survived or another user's caches were removed")
	}
	firstVolume := -1
	for i, mutation := range f.mutations {
		if strings.Contains(mutation, "/volumes/") && firstVolume == -1 {
			firstVolume = i
		}
		if firstVolume != -1 && strings.Contains(mutation, "/containers/") {
			t.Fatal("a data volume was removed before all containers")
		}
	}
	if firstVolume != 4 {
		t.Fatalf("expected all four owned containers before data removal: %v", f.mutations)
	}
}

func TestRemoveUserChecksAllLivenessBeforeMutation(t *testing.T) {
	userID, sessionID := "owner", "session"
	desktop, compute := userContainer(userID), computeContainer(userID, sessionID)
	for _, tc := range []struct {
		name     string
		localKey string
		state    string
		activity string
	}{
		{name: "desktop local request", localKey: userID},
		{name: "compute local request", localKey: compute},
		{name: "persistent service", activity: `{"jobs":[{"job_id":"service"}],"active_calls":0,"idle_seconds":90}`},
		{name: "bridge active request", activity: `{"jobs":[],"active_calls":1,"idle_seconds":90}`},
		{name: "paused", state: "paused"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			computeState := removalContainer("compute", compute, compute+"-data", map[string]string{"app": "ochi", "scope": "compute", "session": sessionID}, true)
			if tc.state != "" {
				computeState.State = tc.state
			}
			f := &userRemovalEngine{
				containers: map[string]userContainerState{
					"desktop": removalDesktop("desktop", userID, desktop, true),
					"compute": computeState,
				},
				activity: map[string]string{compute: tc.activity},
			}
			d := f.docker(t)
			if tc.localKey != "" {
				d.active = map[string]int{tc.localKey: 1}
			}
			if err := d.RemoveUser(context.Background(), userID, []string{sessionID}); !errors.Is(err, ErrUserBusy) {
				t.Fatalf("active work was not rejected: %v", err)
			}
			if len(f.mutations) != 0 {
				t.Fatalf("removed resources before checking every target: %v", f.mutations)
			}
			for key := range d.tokens {
				if strings.HasPrefix(key, "remove:") {
					t.Fatal("activity probe credential was retained")
				}
			}
		})
	}
}

func TestRemoveUserRefusesForeignOrUnexpectedMounts(t *testing.T) {
	userID := "owner"
	desktop := userContainer(userID)
	for _, test := range []string{"foreign consumer", "foreign canonical", "extra volume", "plugin control", "writable plugin assets", "missing data mount"} {
		t.Run(test, func(t *testing.T) {
			item := removalDesktop("desktop", userID, desktop, false)
			containers := map[string]userContainerState{"desktop": item}
			switch test {
			case "foreign consumer":
				containers["foreign"] = removalContainer("foreign", "foreign", desktop+"-data", map[string]string{"app": "other"}, false)
			case "foreign canonical":
				item.Labels["app"] = "other"
			case "extra volume":
				item.Mounts[1].Name = "other-user-data"
				item.Mounts[1].Destination = "/data/other"
			case "plugin control":
				item.Mounts[1].Name = "ochi-plugin-control"
			case "writable plugin assets":
				item.Mounts[1].RW = true
			case "missing data mount":
				item.Mounts = item.Mounts[1:]
			}
			containers["desktop"] = item
			f := &userRemovalEngine{containers: containers}
			d := f.docker(t)
			if err := d.RemoveUser(context.Background(), userID, nil); err == nil {
				t.Fatal("unexpected ownership permitted deletion")
			}
			if len(f.mutations) != 0 {
				t.Fatalf("ownership checks partly deleted resources: %v", f.mutations)
			}
		})
	}
}

func TestRemoveUserPreservesReadOnlyExtensionVolume(t *testing.T) {
	userID := "owner"
	desktop := userContainer(userID)
	item := removalDesktop("desktop", userID, desktop+"-retained", false)
	item.Mounts[1].Name = "fixture-shared-extension-assets"
	f := &userRemovalEngine{
		containers: map[string]userContainerState{"desktop": item},
		volumes:    map[string]bool{desktop + "-data": true, "fixture-shared-extension-assets": true},
	}
	if err := f.docker(t).RemoveUser(context.Background(), userID, nil); err != nil {
		t.Fatal(err)
	}
	if len(f.containers) != 0 || !reflect.DeepEqual(f.volumes, map[string]bool{"fixture-shared-extension-assets": true}) {
		t.Fatal("read-only extension assets were removed with user data")
	}
}

func TestRemoveUserRequiresDurableComputeOwnershipForRetry(t *testing.T) {
	userID, sessionID := "owner", "missing-conversation"
	compute := computeContainer(userID, sessionID)
	f := &userRemovalEngine{
		containers: map[string]userContainerState{
			"orphan": removalContainer("orphan", compute, compute+"-data",
				map[string]string{"app": "ochi", "scope": "compute", "session": sessionID}, false),
		},
	}
	if err := f.docker(t).RemoveUser(context.Background(), userID, nil); err == nil {
		t.Fatal("cleanup could lose its only durable ownership mapping")
	}
	if len(f.mutations) != 0 {
		t.Fatal("untracked computation was partly removed before manual reconciliation")
	}
}

func TestRemoveUserCanRetryPartialCleanup(t *testing.T) {
	userID, sessionID := "owner", "session"
	desktop, compute := userContainer(userID), computeContainer(userID, sessionID)
	for _, failure := range []string{"container", "volume"} {
		t.Run(failure, func(t *testing.T) {
			f := &userRemovalEngine{
				containers: map[string]userContainerState{
					"a": removalDesktop("a", userID, desktop, false),
					"b": removalContainer("b", compute, compute+"-data", map[string]string{"app": "ochi", "scope": "compute", "session": sessionID}, false),
				},
				volumes: map[string]bool{desktop + "-data": true, compute + "-data": true},
				fail:    map[string]int{},
			}
			path := "DELETE /v1.44/containers/b"
			if failure == "volume" {
				names := []string{desktop + "-data", compute + "-data"}
				sort.Strings(names)
				path = "DELETE /v1.44/volumes/" + names[1]
			}
			f.fail[path] = http.StatusInternalServerError
			d := f.docker(t)
			if err := d.RemoveUser(context.Background(), userID, []string{sessionID}); err == nil {
				t.Fatal("partial cleanup was reported as successful")
			}
			if err := d.RemoveUser(context.Background(), userID, []string{sessionID}); err != nil {
				t.Fatalf("retry could not finish remaining resources: %v", err)
			}
			if len(f.containers) != 0 || len(f.volumes) != 0 {
				t.Fatal("retry left resources behind")
			}
			if err := d.RemoveUser(context.Background(), userID, []string{sessionID}); err != nil {
				t.Fatalf("already removed resources are not idempotent: %v", err)
			}
		})
	}
}

func TestRemoveUserProtectsControlAndCancelledGateWait(t *testing.T) {
	d := NewDocker(Config{})
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet {
			t.Fatal("control/cancelled removal mutated Docker")
		}
		return workspaceResponse(http.StatusOK, "[]"), nil
	})
	for _, userID := range []string{"", "__admin__"} {
		if err := d.RemoveUser(context.Background(), userID, nil); err == nil {
			t.Fatal("shared control can be removed")
		}
	}
	unlock, err := d.lockWorkspace(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := d.RemoveUser(ctx, "owner", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled gate acquisition did not end: %v", err)
	}
}
