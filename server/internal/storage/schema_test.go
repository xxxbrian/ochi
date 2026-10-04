package storage

import (
	"context"
	"testing"
)

func TestSchemaInitializationLeavesExistingDataUnchanged(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	if _, err := s.db.Exec(ctx, `UPDATE app_settings SET system_prompt='Administrator instructions';
		INSERT INTO users(id,username,display_name,password_hash) VALUES('schema-qa','schema-qa','QA','not-a-login');
		INSERT INTO sessions(user_id,workspace_path,memory_context) VALUES('schema-qa','','Retain this profile');`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := s.initialize(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var prompt, path, profile string
	if err := s.db.QueryRow(ctx, `SELECT a.system_prompt,s.workspace_path,s.memory_context
		FROM app_settings a CROSS JOIN sessions s WHERE s.user_id='schema-qa'`).Scan(&prompt, &path, &profile); err != nil {
		t.Fatal(err)
	}
	if prompt != "Administrator instructions" || path != "" || profile != "Retain this profile" {
		t.Fatal("schema initialization rewrote existing configuration or session data")
	}
}

func TestSchemaInitializationIsAtomicAndCanRetry(t *testing.T) {
	s := emptyProcessTestStore(t)
	ctx := context.Background()
	if _, err := s.db.Exec(ctx, `CREATE TABLE models (marker text); INSERT INTO models VALUES ('preserve');`); err != nil {
		t.Fatal(err)
	}
	if err := s.initialize(ctx); err == nil {
		t.Fatal("conflicting partial schema was silently accepted")
	}
	var rolledBack bool
	var marker string
	if err := s.db.QueryRow(ctx, `SELECT to_regclass(format('%I.app_settings',current_schema())) IS NULL,marker FROM models`).Scan(&rolledBack, &marker); err != nil {
		t.Fatal(err)
	}
	if !rolledBack || marker != "preserve" {
		t.Fatal("failed initialization left partial tables or changed existing data")
	}
	if _, err := s.db.Exec(ctx, `DROP TABLE models`); err != nil {
		t.Fatal(err)
	}
	if err := s.initialize(ctx); err != nil {
		t.Fatal(err)
	}
	var app, search int
	if err := s.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM app_settings),(SELECT count(*) FROM search_settings)`).Scan(&app, &search); err != nil || app != 1 || search != 1 {
		t.Fatal("fresh initialization did not seed the singleton settings", err)
	}
}
