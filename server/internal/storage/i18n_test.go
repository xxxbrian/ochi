package storage

import (
	"context"
	"testing"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/i18n"
	"ochi/server/internal/runtime"
)

func TestLanguagePreferenceIsDurableAndAccountScoped(t *testing.T) {
	s, first, _ := modelSelectionStore(t)
	ctx := context.Background()
	for _, user := range []string{"language-a", "language-b"} {
		if err := s.BootstrapUser(ctx, User{ID: user, Username: user, DisplayName: user, Role: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := s.Preferences(ctx, "language-a")
	if err != nil || before.Language != "system" {
		t.Fatal("a new account must follow the system language", err)
	}
	off, on := false, true
	before, err = s.PatchPreferences(ctx, "language-a", PreferencesPatch{MemoryEnabled: &off, ComputerDefault: &on, PreferredModelID: &first.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, language := range []string{"zh-TW", "en", "zh-CN", "system"} {
		if _, err := s.PatchPreferences(ctx, "language-a", PreferencesPatch{Language: &language}); err != nil {
			t.Fatal(err)
		}
		saved, err := s.Preferences(ctx, "language-a")
		if err != nil || saved.Language != language || saved.MemoryEnabled || !saved.ComputerDefault || saved.PreferredModelID != first.ID || saved.MemoryRevision != before.MemoryRevision {
			t.Fatalf("language changed unrelated preferences: %+v, %v", saved, err)
		}
		other, err := s.Preferences(ctx, "language-b")
		if err != nil || other.Language != "system" || other.PreferredModelID != "" || !other.MemoryEnabled || other.ComputerDefault {
			t.Fatalf("language crossed account boundaries: %+v, %v", other, err)
		}
	}
	for _, language := range []string{"", "fr", "zh-Hant", "ZH-CN"} {
		_, err := s.PatchPreferences(ctx, "language-a", PreferencesPatch{Language: &language})
		code, _, public := i18n.Details(err)
		if !public || code != "invalid_language" {
			t.Fatalf("invalid language %q did not return its stable validation error", language)
		}
	}
	saved, _ := s.Preferences(ctx, "language-a")
	saved.Language = "zh-TW"
	if err := s.SavePreferences(ctx, "language-a", saved); err != nil {
		t.Fatal(err)
	}
	saved.Language = ""
	if err := s.SavePreferences(ctx, "language-a", saved); err != nil {
		t.Fatal(err)
	}
	after, err := s.Preferences(ctx, "language-a")
	if err != nil || after.Language != "zh-TW" {
		t.Fatal("an unspecified language reset a saved preference", err)
	}
	if _, err := s.db.Exec(ctx, `UPDATE user_preferences SET language='fr' WHERE user_id='language-a'`); err == nil {
		t.Fatal("the schema accepted a non-canonical language")
	}
}

func TestRunFailureCodesRoundTripToHistoryAdminAndSchedules(t *testing.T) {
	s, model, _ := modelSelectionStore(t)
	ctx := context.Background()
	const user = "language-history"
	if err := s.BootstrapUser(ctx, User{ID: user, Username: user, DisplayName: "QA", Role: "user"}); err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateSession(ctx, user)
	if err != nil || session.Title != "" {
		t.Fatal("new sessions must store a locale-neutral empty title", err)
	}
	// A title that happens to equal a translated default is still user content.
	session, err = s.UpdateSession(ctx, user, session.ID, "新对话", "", "")
	if err != nil || session.Title != "新对话" || session.TitleSource != "manual" {
		t.Fatal("an explicit title was treated as a localized sentinel", err)
	}
	const runID = "11111111-2026-4290-8000-000000000029"
	snapshot, _, err := s.CreateConfiguredRun(ctx, user, session.ID, "Controlled failure fixture", runID, model, "", agent.SystemPrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Status, snapshot.ErrorCode = runtime.StatusFailed, "model_rate_limit"
	snapshot.Error, snapshot.Seq, snapshot.UpdatedAt = i18n.Text("en", snapshot.ErrorCode, nil), snapshot.Seq+1, time.Now().UTC()
	if err := s.CompleteRun(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	stored, err := s.GetRun(ctx, user, runID)
	if err != nil || stored.ErrorCode != snapshot.ErrorCode || stored.Error != snapshot.Error {
		t.Fatal("persisted run lost the locale-neutral failure identity", err)
	}
	latest, err := s.LatestRun(ctx, user, session.ID)
	if err != nil || latest == nil || latest.ErrorCode != snapshot.ErrorCode {
		t.Fatal("the latest run projection dropped its failure code", err)
	}
	messages, err := s.Messages(ctx, user, session.ID)
	if err != nil || len(messages) != 2 || messages[0].RunErrorCode != "" || messages[1].RunErrorCode != snapshot.ErrorCode {
		t.Fatalf("history dropped or misapplied the failure code: %+v, %v", messages, err)
	}
	page, err := s.AdminRuns(ctx, AdminRunFilter{From: time.Now().Add(-time.Hour), To: time.Now().Add(time.Hour), Limit: 20})
	if err != nil || len(page.Items) != 1 || page.Items[0].ErrorCode != snapshot.ErrorCode {
		t.Fatal("administrator run list dropped its failure code", err)
	}
	detail, err := s.AdminRun(ctx, runID)
	if err != nil || detail.ErrorCode != snapshot.ErrorCode {
		t.Fatal("administrator run details dropped their failure code", err)
	}
	schedule, err := s.SaveSchedule(ctx, user, Schedule{SessionID: session.ID, Name: "Fixture", Prompt: "Fixture", Recurrence: "interval", IntervalMinutes: 60, Timezone: "UTC", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	execution, admitted, err := s.BeginScheduleExecution(ctx, user, schedule.ID)
	if err != nil || !admitted {
		t.Fatal("could not prepare owned schedule execution", err)
	}
	if err := s.LinkScheduleExecution(ctx, execution, "", "", i18n.New("model_unavailable")); err != nil {
		t.Fatal(err)
	}
	schedule, err = s.Schedule(ctx, user, schedule.ID)
	if err != nil || schedule.LastErrorCode != "model_unavailable" {
		t.Fatal("schedule lost its startup error identity", err)
	}
	executions, err := s.ScheduleExecutions(ctx, user, schedule.ID)
	if err != nil || len(executions) != 1 || executions[0].ErrorCode != "model_unavailable" {
		t.Fatal("schedule execution lost its startup error identity", err)
	}
	execution, _, err = s.BeginScheduleExecution(ctx, user, schedule.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkScheduleExecution(ctx, execution, runID, session.ID, nil); err != nil {
		t.Fatal(err)
	}
	executed, err := s.ScheduleExecution(ctx, user, schedule.ID, execution)
	if err != nil || executed.ErrorCode != snapshot.ErrorCode || executed.Snapshot == nil || executed.Snapshot.ErrorCode != snapshot.ErrorCode {
		t.Fatal("a linked execution did not expose its canonical run failure", err)
	}
}
