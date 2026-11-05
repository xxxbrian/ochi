package storage

import (
	"context"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/i18n"
)

var ErrAccountBusy = i18n.New("account_busy")

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	var u User
	err := s.db.QueryRow(ctx, `SELECT id,username,display_name,password_hash,role,enabled,created_at FROM users WHERE id=$1`, id).Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt)
	return u, err
}

func (s *Store) SessionOwner(ctx context.Context, sessionID string) (string, error) {
	var userID string
	err := s.db.QueryRow(ctx, `SELECT user_id FROM sessions WHERE id=$1`, sessionID).Scan(&userID)
	return userID, err
}

// UserWorkspaceSessions includes scheduled and archived conversations, without a
// display-list limit. The caller holds account maintenance admission throughout.
func (s *Store) UserWorkspaceSessions(ctx context.Context, userID string) ([]string, error) {
	if _, err := s.UserByID(ctx, userID); err != nil {
		return nil, err
	}
	return userWorkspaceSessions(ctx, s.db, userID)
}

type userMaintenanceQuery interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func userWorkspaceSessions(ctx context.Context, db userMaintenanceQuery, userID string) ([]string, error) {
	var busy bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id
 WHERE s.user_id=$1 AND r.status IN ('queued','running','cancelling','waiting_user','waiting_resource'))`, userID).Scan(&busy); err != nil {
		return nil, err
	}
	if busy {
		return nil, ErrAccountBusy
	}
	rows, err := db.Query(ctx, `SELECT id::text FROM sessions WHERE user_id=$1 ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// DeleteUser keeps role protection and the final database removal atomic. The
// callback removes only this account's external resources; a failed callback
// rolls back database changes so an administrator can retry the same account.
func (s *Store) DeleteUser(ctx context.Context, actorID, userID string, cleanup func(context.Context, []string) error) error {
	if actorID == userID {
		return i18n.New("user_delete_self")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891302)`); err != nil {
		return err
	}
	var actorAllowed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='admin' AND enabled)`, actorID).Scan(&actorAllowed); err != nil {
		return err
	}
	if !actorAllowed {
		return i18n.New("admin_required")
	}
	var role string
	var enabled bool
	if err = tx.QueryRow(ctx, `SELECT role,enabled FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&role, &enabled); err != nil {
		return err
	}
	if role == "admin" && enabled {
		var others bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id<>$1 AND role='admin' AND enabled)`, userID).Scan(&others); err != nil {
			return err
		}
		if !others {
			return i18n.New("last_admin_required")
		}
	}
	sessions, err := userWorkspaceSessions(ctx, tx, userID)
	if err != nil {
		return err
	}
	if err = cleanup(ctx, sessions); err != nil {
		return err
	}
	// These top-level ownership tables have no user foreign key; their children
	// and the remaining user-owned tables cascade from here.
	for _, table := range []string{"run_requests", "schedules", "sessions", "projects", "artifacts", "user_preferences", "users"} {
		column := "user_id"
		if table == "users" {
			column = "id"
		}
		if _, err = tx.Exec(ctx, "DELETE FROM "+table+" WHERE "+column+"=$1", userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
