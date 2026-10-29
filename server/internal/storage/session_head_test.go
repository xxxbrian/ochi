package storage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestSessionHeadMetadataAndIndependentRevisions(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	const user = "head-fixture"
	if _, err := s.db.Exec(ctx, `INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$1,'QA','not-a-login')`, user); err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateSession(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.SessionHead(ctx, user, session.ID)
	if err != nil || first.LatestRun != nil || first.HistoryRevision == "" || first.QueueRevision == "" {
		t.Fatalf("empty head: %+v, %v", first, err)
	}
	if _, err := s.SessionHead(ctx, "other", session.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("foreign owner saw head: %v", err)
	}
	const runID = "55555555-5555-4555-8555-555555555557"
	if _, err := s.EnqueueRun(ctx, PendingRun{RunID: runID, SessionID: session.ID, UserID: user, Message: "first"}, false); err != nil {
		t.Fatal(err)
	}
	queued, err := s.SessionHead(ctx, user, session.ID)
	if err != nil || queued.LatestRun.RunID != runID || queued.QueueRevision == first.QueueRevision {
		t.Fatalf("queued revision: %+v, %v", queued, err)
	}
	if _, err := s.EditPendingRun(ctx, user, session.ID, runID, "edited", "", "", "high"); err != nil {
		t.Fatal(err)
	}
	edited, err := s.SessionHead(ctx, user, session.ID)
	if err != nil || edited.QueueRevision == queued.QueueRevision {
		t.Fatalf("same-count queue edit was invisible: %+v, %v", edited, err)
	}
	// Deliberately invalid process JSON shape proves this read does not decode
	// the large run body, not merely that its JSON response omits one field.
	if _, err := s.db.Exec(ctx, `UPDATE runs SET items=jsonb_build_object('large',$2::text),seq=seq+1 WHERE id=$1`, runID, strings.Repeat("fixture", 100_000)); err != nil {
		t.Fatal(err)
	}
	large, err := s.SessionHead(ctx, user, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(large)
	if err != nil || len(body) > 2000 || strings.Contains(string(body), `"items"`) {
		t.Fatalf("head included process payload: bytes=%d err=%v", len(body), err)
	}
	if _, err := s.UpdateSession(ctx, user, session.ID, "New title", "", ""); err != nil {
		t.Fatal(err)
	}
	updated, err := s.SessionHead(ctx, user, session.ID)
	if err != nil || updated.HistoryRevision == large.HistoryRevision || updated.Session.Title != "New title" {
		t.Fatalf("session revision stale: %+v, %v", updated, err)
	}
}
