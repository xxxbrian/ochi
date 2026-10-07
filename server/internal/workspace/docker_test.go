package workspace

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

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
