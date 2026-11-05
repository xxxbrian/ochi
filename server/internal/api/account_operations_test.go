package api

import (
	"context"
	"errors"
	"testing"

	"ochi/server/internal/storage"
)

func TestAccountMaintenanceExcludesEveryLiveReference(t *testing.T) {
	var accounts accountOperations
	ctx, first, err := accounts.begin(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := accounts.begin(context.WithoutCancel(ctx), "owner")
	if err != nil {
		t.Fatal(err)
	}
	first()
	first()
	if _, err := accounts.maintain(ctx, "owner"); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("a released parent context concealed a detached live reference")
	}
	second()
	finish, err := accounts.maintain(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := accounts.begin(ctx, "owner"); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("inherited context bypassed maintenance")
	}
	_, other, err := accounts.begin(context.Background(), "other")
	if err != nil {
		t.Fatal("maintenance blocked a different account")
	}
	other()
	finish()
	finish()
	accounts.mu.Lock()
	defer accounts.mu.Unlock()
	if len(accounts.users) != 0 {
		t.Fatal("completed maintenance retained account gate state")
	}
}

func TestAccountWorkspaceMaintenanceCanExcludeItsOwnHTTPRequest(t *testing.T) {
	var accounts accountOperations
	ctx, done, err := accounts.begin(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	finish, err := accounts.maintain(ctx, "owner")
	if err != nil {
		t.Fatal("a workspace reset blocked on its own HTTP request")
	}
	if _, _, err := accounts.begin(ctx, "owner"); !errors.Is(err, storage.ErrAccountBusy) {
		t.Fatal("a new nested operation bypassed active maintenance")
	}
	finish()
	done()
}
