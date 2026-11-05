package api

import (
	"context"
	"sync"

	"ochi/server/internal/storage"
)

type accountOperationKey struct{}
type accountOperation struct {
	owner  *accountOperations
	userID string
	active bool
}
type accountActivity struct {
	active      int
	maintenance bool
}

// Account maintenance excludes new writes and execution admissions. It never
// waits behind a model run or silently cancels work to make deletion possible.
type accountOperations struct {
	mu    sync.Mutex
	users map[string]*accountActivity
}

func (a *accountOperations) begin(ctx context.Context, userID string) (context.Context, func(), error) {
	a.mu.Lock()
	if a.users == nil {
		a.users = make(map[string]*accountActivity)
	}
	state := a.users[userID]
	if state == nil {
		state = &accountActivity{}
		a.users[userID] = state
	}
	if state.maintenance {
		a.mu.Unlock()
		return ctx, nil, storage.ErrAccountBusy
	}
	state.active++
	operation := &accountOperation{owner: a, userID: userID, active: true}
	a.mu.Unlock()
	var once sync.Once
	return context.WithValue(ctx, accountOperationKey{}, operation), func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			operation.active = false
			state.active--
			if state.active == 0 && !state.maintenance {
				delete(a.users, userID)
			}
		})
	}, nil
}

func (a *accountOperations) maintain(ctx context.Context, userID string) (func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.users == nil {
		a.users = make(map[string]*accountActivity)
	}
	state := a.users[userID]
	if state == nil {
		state = &accountActivity{}
		a.users[userID] = state
	}
	own := 0
	if current, ok := ctx.Value(accountOperationKey{}).(*accountOperation); ok && current.owner == a && current.userID == userID && current.active {
		own = 1
	}
	if state.maintenance || state.active > own {
		return nil, storage.ErrAccountBusy
	}
	state.maintenance = true
	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			state.maintenance = false
			if state.active == 0 {
				delete(a.users, userID)
			}
		})
	}, nil
}
