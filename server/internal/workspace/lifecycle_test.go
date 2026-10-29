package workspace

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProvisioningDoesNotBlockOtherWorkspace(t *testing.T) {
	d := NewDocker(Config{})
	entered, ready := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var inspections atomic.Int32
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		inspections.Add(1)
		return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == userContainer("slow")+":8080" {
			once.Do(func() { close(entered) })
			select {
			case <-r.Context().Done():
				return nil, r.Context().Err()
			case <-ready:
			}
		}
		return workspaceResponse(http.StatusOK, fixtureHealth("workspace")), nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	slow := make(chan error, 1)
	go func() { _, err := d.ensure(ctx, "slow"); slow <- err }()
	<-entered
	fast := make(chan error, 1)
	go func() { _, err := d.ensure(ctx, "fast"); fast <- err }()
	select {
	case err := <-fast:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("unrelated workspace blocked behind slow readiness")
	}
	close(ready)
	if err := <-slow; err != nil {
		t.Fatal(err)
	}
	if inspections.Load() != 2 {
		t.Fatalf("unexpected provisioning count: %d", inspections.Load())
	}
}

func TestWorkspaceGateCancellationAndConcurrentReuse(t *testing.T) {
	d := NewDocker(Config{})
	unlock, err := d.lockWorkspace(context.Background(), "same")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	waiter := make(chan error, 1)
	go func() { _, err := d.lockWorkspace(ctx, "same"); waiter <- err }()
	cancel()
	if err := <-waiter; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting attachment did not cancel: %v", err)
	}
	unlock()
	d.mu.Lock()
	remaining := len(d.gates)
	d.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("abandoned gates retained: %d", remaining)
	}

	var inspections atomic.Int32
	d.engine.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		inspections.Add(1)
		return workspaceResponse(http.StatusOK, fixtureContainer(`{"State":{"Running":true}}`)), nil
	})
	d.bridge.Transport = catalogRoundTripper(func(r *http.Request) (*http.Response, error) {
		return workspaceResponse(http.StatusOK, fixtureHealth("workspace")), nil
	})
	var wait sync.WaitGroup
	for range 12 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			address, release, err := d.borrow(context.Background(), "same")
			if err != nil {
				t.Error(err)
				return
			}
			if address == "" {
				t.Error("missing attachment")
			}
			release()
			release()
		}()
	}
	wait.Wait()
	d.mu.Lock()
	defer d.mu.Unlock()
	if inspections.Load() != 1 || len(d.gates) != 0 || len(d.active) != 0 {
		t.Fatalf("concurrent reuse leaked state or reprovisioned: inspections=%d gates=%d active=%v", inspections.Load(), len(d.gates), d.active)
	}
}
