package storage

import (
	"context"

	"ochi/server/internal/i18n"
)

var ErrModelSelection = i18n.New("model_selection_invalid")
var ErrModelOrderChanged = i18n.New("model_order_changed")

func validateModelOrder(current, ordered []string, defaultID string) error {
	if len(current) != len(ordered) {
		return ErrModelOrderChanged
	}
	remaining := make(map[string]bool, len(current))
	for _, id := range current {
		remaining[id] = true
	}
	for _, id := range ordered {
		if !remaining[id] {
			return ErrModelOrderChanged
		}
		delete(remaining, id)
	}
	if defaultID == "" && len(current) == 0 {
		return nil
	}
	for _, id := range current {
		if id == defaultID {
			return nil
		}
	}
	return ErrModelSelection
}

// Order and the initial model are independent: an existing user's choice wins.
func (s *Store) SaveModelOrder(ctx context.Context, ordered []string, defaultID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(891303)`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT m.id::text FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled AND p.enabled AND m.available AND m.kind='chat' FOR UPDATE OF m`)
	if err != nil {
		return err
	}
	var current []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		current = append(current, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if err = validateModelOrder(current, ordered, defaultID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE models SET is_default=false WHERE is_default`); err != nil {
		return err
	}
	for position, id := range ordered {
		if _, err = tx.Exec(ctx, `UPDATE models SET sort_order=$2,is_default=($1::text=$3) WHERE id=$1`, id, position, defaultID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
