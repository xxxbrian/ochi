package workspace

import (
	"context"
	"sync"
	"time"

	"ochi/server/internal/agent"
)

type workspaceGate struct {
	token chan struct{}
	users int
}

// Provisioning and maintenance serialize per container. A slow boot for one
// user never blocks an unrelated workspace, and abandoned keys are removed.
func (d *Docker) lockWorkspace(ctx context.Context, key string) (func(), error) {
	d.mu.Lock()
	if d.gates == nil {
		d.gates = make(map[string]*workspaceGate)
	}
	gate := d.gates[key]
	if gate == nil {
		gate = &workspaceGate{token: make(chan struct{}, 1)}
		gate.token <- struct{}{}
		d.gates[key] = gate
	}
	gate.users++
	d.mu.Unlock()
	drop := func() {
		d.mu.Lock()
		gate.users--
		if gate.users == 0 {
			delete(d.gates, key)
		}
		d.mu.Unlock()
	}
	select {
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	case <-gate.token:
		var once sync.Once
		return func() {
			once.Do(func() {
				gate.token <- struct{}{}
				drop()
			})
		}, nil
	}
}

func workspaceKey(ctx context.Context, userID string) string {
	if scope, ok := agent.ScopeFromContext(ctx); ok && scope.ComputeOnly {
		return computeContainer(userID, scope.SessionID)
	}
	return userID
}

func (d *Docker) address(key string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.urls[key]
}

func (d *Docker) rememberAddress(key, address string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if address == "" {
		delete(d.urls, key)
	} else {
		d.urls[key] = address
	}
}

func (d *Docker) ensureLocked(ctx context.Context, userID string) (string, error) {
	if scope, ok := agent.ScopeFromContext(ctx); ok && scope.ComputeOnly {
		return d.ensureComputeLocked(ctx, userID, scope.SessionID)
	}
	return d.ensureWorkspaceLocked(ctx, userID)
}

// The reference covers both attachment and the complete bridge request, so an
// idle sweep cannot stop the container in the gap before dispatch.
func (d *Docker) borrow(ctx context.Context, userID string) (string, func(), error) {
	key := workspaceKey(ctx, userID)
	unlock, err := d.lockWorkspace(ctx, key)
	if err != nil {
		return "", nil, err
	}
	defer unlock()
	address, err := d.ensureLocked(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	d.mu.Lock()
	if d.active == nil {
		d.active = make(map[string]int)
	}
	d.active[key]++
	d.mu.Unlock()
	var once sync.Once
	return address, func() {
		once.Do(func() {
			d.mu.Lock()
			d.active[key]--
			if d.active[key] == 0 {
				delete(d.active, key)
			}
			if d.lastUse == nil {
				d.lastUse = make(map[string]time.Time)
			}
			d.lastUse[key] = time.Now()
			d.mu.Unlock()
		})
	}, nil
}
