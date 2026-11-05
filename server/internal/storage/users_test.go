package storage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/i18n"
)

func seedUserDeletionData(t *testing.T, s *Store, userID string, sessions int) {
	t.Helper()
	ctx := context.Background()
	var projectID, sessionID, scheduleID, runID string
	if err := s.db.QueryRow(ctx, `INSERT INTO projects(user_id,name) VALUES($1,'Owned project') RETURNING id::text`, userID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < sessions; i++ {
		if err := s.db.QueryRow(ctx, `INSERT INTO sessions(user_id,project_id,source) VALUES($1,$2,'schedule') RETURNING id::text`, userID, projectID).Scan(&sessionID); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.db.QueryRow(ctx, `INSERT INTO schedules(user_id,session_id,project_id,name,prompt,interval_minutes,next_run_at)
 VALUES($1,$2,$3,'Owned schedule','Fixture',30,now()+interval '1 day') RETURNING id::text`, userID, sessionID, projectID).Scan(&scheduleID); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(ctx, `INSERT INTO runs(id,session_id,status,schedule_id)
 VALUES(gen_random_uuid(),$1,'completed',$2) RETURNING id::text`, sessionID, scheduleID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO messages(session_id,run_id,role,content) VALUES(@sessionID,@runID,'assistant','Owned reply')`,
		`INSERT INTO canonical_messages(session_id,run_id,payload) VALUES(@sessionID,@runID,'{"role":"assistant","content":"Owned reply"}')`,
		`INSERT INTO context_compactions(session_id,through_seq,summary) VALUES(@sessionID,1,'Owned summary')`,
		`INSERT INTO run_instructions(run_id,user_id,client_key,content) VALUES(@runID,@userID,'owned-client-key','Owned input')`,
		`INSERT INTO run_requests(run_id,user_id,session_id,message) VALUES(@runID,@userID,@sessionID,'Owned request')`,
		`INSERT INTO run_request_debug(id,run_id,started_at,summary,detail) VALUES(gen_random_uuid(),@runID,now(),'{}','{}')`,
		`INSERT INTO run_diagnostics(run_id,event) VALUES(@runID,'{}')`,
		`INSERT INTO run_context_inspections(run_id,round,inspection) VALUES(@runID,'round','{}')`,
		`INSERT INTO session_tasks(session_id,user_id,state) VALUES(@sessionID,@userID,'{}')`,
		`INSERT INTO artifacts(user_id,session_id,run_id,name,path) VALUES(@userID,@sessionID,@runID,'Report','/data/report.txt')`,
		`INSERT INTO memories(user_id,project_id,source_session_id,source_run_id,content) VALUES(@userID,@projectID,@sessionID,@runID,'Owned memory')`,
		`INSERT INTO memory_jobs(user_id,session_id,run_id,memory_revision) VALUES(@userID,@sessionID,@runID,0)`,
		`INSERT INTO memory_index_jobs(user_id,model_id,target_identity,embedding_revision,memory_revision) VALUES(@userID,'fixture','fixture',1,0)`,
		`INSERT INTO memory_tombstones(user_id,content_hash) VALUES(@userID,'owned')`,
		`INSERT INTO user_preferences(user_id) VALUES(@userID)`,
		`INSERT INTO user_plugins(user_id,plugin_id,enabled) VALUES(@userID,'deletion-fixture',true)`,
		`INSERT INTO verified_skills(user_id,name,description,body,project_id,source_session_id,source_run_id,source_objective,source_task_revision,source_evidence)
 VALUES(@userID,'Owned method','Fixture','Fixture',@projectID,@sessionID,@runID,'Fixture',1,'[]')`,
		`INSERT INTO schedule_executions(schedule_id,run_id,session_id,status) VALUES(@scheduleID,@runID,@sessionID,'completed')`,
	} {
		if _, err := s.db.Exec(ctx, query, pgx.NamedArgs{"userID": userID, "sessionID": sessionID, "runID": runID, "projectID": projectID, "scheduleID": scheduleID}); err != nil {
			t.Fatalf("seed user deletion data: %v", err)
		}
	}
	if err := s.CreateLogin(ctx, userID+"-token", userID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteUserRemovesAllOwnedDataAndPreservesOtherAccount(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	for _, user := range []User{
		{ID: "delete-admin", Username: "delete-admin", DisplayName: "Admin", Role: "admin"},
		{ID: "delete-owner", Username: "delete-owner", DisplayName: "Owner", Role: "user"},
		{ID: "delete-other", Username: "delete-other", DisplayName: "Other", Role: "user"},
	} {
		if err := s.BootstrapUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO plugins(id,name) VALUES('deletion-fixture','Fixture')`); err != nil {
		t.Fatal(err)
	}
	seedUserDeletionData(t, s, "delete-owner", 205)
	seedUserDeletionData(t, s, "delete-other", 1)
	called := false
	if err := s.DeleteUser(ctx, "delete-admin", "delete-owner", func(_ context.Context, sessions []string) error {
		called = true
		if len(sessions) != 205 {
			t.Fatalf("maintenance used the bounded chat list: %d", len(sessions))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("database deletion bypassed external cleanup")
	}
	for _, table := range []string{"projects", "sessions", "runs", "messages", "canonical_messages", "context_compactions", "run_instructions", "run_requests", "run_request_debug", "run_diagnostics", "run_context_inspections", "session_tasks", "artifacts", "memories", "memory_jobs", "memory_index_jobs", "memory_tombstones", "user_preferences", "user_plugins", "verified_skills", "schedules", "schedule_executions"} {
		var count int
		if err := s.db.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s retained deleted data or removed the other account: count=%d err=%v", table, count, err)
		}
	}
	if _, err := s.UserByID(ctx, "delete-owner"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("deleted user still exists")
	}
	if _, err := s.LoginUser(ctx, "delete-owner-token"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("deleted login still works")
	}
	if _, err := s.LoginUser(ctx, "delete-other-token"); err != nil {
		t.Fatal("other account's login was removed")
	}
	var plugins int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM plugins`).Scan(&plugins); err != nil || plugins != 1 {
		t.Fatal("account deletion removed shared plugin definitions")
	}
}

func TestDeleteUserRejectsBusyAndPreservesDataAfterCleanupFailure(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	for _, id := range []string{"cleanup-admin", "cleanup-owner"} {
		if err := s.BootstrapUser(ctx, User{ID: id, Username: id, DisplayName: id, Role: "admin"}); err != nil {
			t.Fatal(err)
		}
	}
	session, err := s.CreateSession(ctx, "cleanup-owner")
	if err != nil {
		t.Fatal(err)
	}
	const runID = "11111111-dddd-4111-8111-111111111111"
	for _, status := range []string{"queued", "running", "cancelling", "waiting_user", "waiting_resource"} {
		if _, err = s.db.Exec(ctx, `INSERT INTO runs(id,session_id,status) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status`, runID, session.ID, status); err != nil {
			t.Fatal(err)
		}
		if err = s.DeleteUser(ctx, "cleanup-admin", "cleanup-owner", func(context.Context, []string) error {
			t.Fatal("busy account reached destructive cleanup")
			return nil
		}); !errors.Is(err, ErrAccountBusy) {
			t.Fatalf("%s did not block deletion: %v", status, err)
		}
	}
	if _, err = s.db.Exec(ctx, `UPDATE runs SET status='completed' WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("fixture cleanup failed after removing one container")
	if err = s.DeleteUser(ctx, "cleanup-admin", "cleanup-owner", func(context.Context, []string) error { return injected }); !errors.Is(err, injected) {
		t.Fatal("cleanup failure was hidden")
	}
	if _, err = s.UserByID(ctx, "cleanup-owner"); err != nil {
		t.Fatal("failed cleanup lost its retryable account")
	}
	if _, err = s.GetSession(ctx, "cleanup-owner", session.ID); err != nil {
		t.Fatal("failed cleanup lost the durable resource mapping")
	}
	if err = s.DeleteUser(ctx, "cleanup-admin", "cleanup-owner", func(context.Context, []string) error { return nil }); err != nil {
		t.Fatal("cleanup retry did not finish")
	}
}

func TestDeleteAndDisableAdministratorsCannotRemoveAllAccess(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	for _, id := range []string{"guard-one", "guard-two"} {
		if err := s.BootstrapUser(ctx, User{ID: id, Username: id, DisplayName: id, Role: "admin"}); err != nil {
			t.Fatal(err)
		}
	}
	called := false
	if err := s.DeleteUser(ctx, "guard-one", "guard-one", func(context.Context, []string) error { called = true; return nil }); err == nil || called {
		t.Fatal("self-deletion reached external cleanup")
	}
	var wg sync.WaitGroup
	wg.Add(2)
	results := make(chan error, 2)
	go func() {
		defer wg.Done()
		results <- s.DeleteUser(ctx, "guard-one", "guard-two", func(context.Context, []string) error { return nil })
	}()
	go func() {
		defer wg.Done()
		_, err := s.SaveUser(ctx, User{ID: "guard-one", Username: "guard-one", DisplayName: "Admin", Role: "admin", Enabled: false})
		results <- err
	}()
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if code, _, public := i18n.Details(err); !public || code != "last_admin_required" && code != "admin_required" {
			t.Fatalf("unexpected concurrent guard failure: %v", err)
		}
	}
	var admins int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM users WHERE role='admin' AND enabled`).Scan(&admins); err != nil || admins != 1 || successes != 1 {
		t.Fatal("concurrent deletion and demotion removed administrator access")
	}
}
