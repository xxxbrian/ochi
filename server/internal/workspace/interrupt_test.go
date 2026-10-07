package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ochi/server/internal/agent"
)

func readInterruptScope(r *http.Request) (agent.RunScope, error) {
	var scope agent.RunScope
	err := json.Unmarshal([]byte(r.Header.Get("X-Run-Scope")), &scope)
	return scope, err
}

func TestCancelledDesktopTransportInterruptsScopedOperationAndDrains(t *testing.T) {
	for _, tool := range []struct{ name, arguments string }{
		{"exec", `{"command":"echo fixture"}`},
		{"browser_action", `{"action":"wait","timeout_ms":20000}`},
		{"computer_type", `{"text":"fixture","delay_ms":100}`},
		{"computer_drag", `{"x":1,"y":2,"to_x":3,"to_y":4}`},
	} {
		t.Run(tool.name, func(t *testing.T) {
			entered, interrupted := make(chan agent.RunScope, 1), make(chan agent.RunScope, 1)
			release := make(chan struct{})
			var once sync.Once
			bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/health":
					w.WriteHeader(http.StatusOK)
				case "/tools/" + tool.name:
					scope, err := readInterruptScope(r)
					if err != nil {
						t.Error(err)
					}
					entered <- scope
					<-release
					io.WriteString(w, `{"ok":false,"error":"fixture operation interrupted"}`)
				case "/runs/interrupt":
					scope, err := readInterruptScope(r)
					if err != nil || r.Method != http.MethodPost {
						t.Errorf("invalid scoped interrupt: %v %s", err, r.Method)
					}
					interrupted <- scope
					io.WriteString(w, `{"interrupted":true}`)
				default:
					t.Errorf("unexpected bridge route %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer func() {
				once.Do(func() { close(release) })
				bridge.Close()
			}()
			d := NewDocker(Config{})
			d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("unexpected container provisioning in transport fixture")
			})
			d.urls["fixture-user"] = bridge.URL
			d.bridge = &http.Client{Timeout: 5 * time.Second}
			scope := agent.RunScope{UserID: "fixture-user", SessionID: "fixture-session", RunID: "fixture-run", ProjectID: "fixture-project", CWD: "/data/projects/fixture-project", OperationID: "upstream-call-id"}
			ctx, cancel := context.WithCancel(agent.WithRunScope(context.Background(), scope))
			defer cancel()
			// The caller releases its lease only after Call has drained, even when
			// cancellation has already reached the bridge's interrupt endpoint.
			releasedLease := make(chan error, 1)
			go func() {
				_, err := d.Call(ctx, scope.UserID, tool.name, json.RawMessage(tool.arguments))
				releasedLease <- err
			}()
			var dispatched agent.RunScope
			select {
			case dispatched = <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("tool did not reach bridge")
			}
			if dispatched.OperationID == "" || dispatched.OperationID == scope.OperationID {
				t.Fatal("tool did not receive a fresh operation identity")
			}
			scope.OperationID = dispatched.OperationID
			if !reflect.DeepEqual(dispatched, scope) {
				t.Fatalf("dispatch scope changed: %+v", dispatched)
			}
			cancel()
			select {
			case interruptedScope := <-interrupted:
				if !reflect.DeepEqual(interruptedScope, dispatched) {
					t.Fatalf("interrupt crossed operation scope: %+v", interruptedScope)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancelled context did not interrupt desktop operation")
			}
			select {
			case err := <-releasedLease:
				t.Fatalf("lease released before dispatched operation drained: %v", err)
			case <-time.After(50 * time.Millisecond):
			}
			once.Do(func() { close(release) })
			select {
			case err := <-releasedLease:
				if err == nil || !strings.Contains(err.Error(), "operation interrupted") {
					t.Fatalf("drained interruption was not returned: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("tool did not return after draining")
			}
		})
	}
}

func TestDesktopInterruptCanReachBridgeBeforeDispatch(t *testing.T) {
	interrupted := make(chan agent.RunScope, 1)
	priorInterrupt := make(chan agent.RunScope, 1)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.WriteHeader(http.StatusOK)
		case "/runs/interrupt":
			scope, err := readInterruptScope(r)
			if err != nil {
				t.Error(err)
			}
			interrupted <- scope
			io.WriteString(w, `{"interrupted":true}`)
		case "/tools/computer_key":
			scope, err := readInterruptScope(r)
			var operation agent.RunScope
			select {
			case operation = <-priorInterrupt:
			case <-time.After(3 * time.Second):
				t.Error("late dispatch arrived without an interrupt marker")
			}
			if err != nil || !reflect.DeepEqual(operation, scope) || operation.OperationID == "" {
				t.Errorf("late dispatch did not match prior interrupt marker: %+v %v", scope, err)
			}
			io.WriteString(w, `{"ok":false,"error":"operation interrupted before execution"}`)
		default:
			t.Errorf("unexpected bridge route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer bridge.Close()
	d := NewDocker(Config{})
	d.engine.Transport = catalogRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected container provisioning in transport fixture")
	})
	d.urls["fixture-user"] = bridge.URL
	scope := agent.RunScope{UserID: "fixture-user", SessionID: "fixture-session", RunID: "fixture-run", CWD: "/data/work/fixture-session"}
	ctx, cancel := context.WithCancel(agent.WithRunScope(context.Background(), scope))
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	d.bridge = &http.Client{Timeout: 5 * time.Second, Transport: catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/tools/computer_key" {
			cancel()
			select {
			case scope := <-interrupted:
				priorInterrupt <- scope
			case <-time.After(3 * time.Second):
				t.Error("interrupt could not reach bridge while tool dispatch was delayed")
			}
		}
		return transport.RoundTrip(r)
	})}
	_, err := d.Call(ctx, scope.UserID, "computer_key", json.RawMessage(`{"key":"Return"}`))
	if err == nil || !strings.Contains(err.Error(), "before execution") {
		t.Fatalf("late dispatch did not fail closed after interruption: %v", err)
	}
}
