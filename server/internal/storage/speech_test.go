package storage

import (
	"context"
	"testing"

	"ochi/server/internal/agent"
)

func TestSpeechSettingsDefaultMissingSynthesisOptions(t *testing.T) {
	store := processTestStore(t)
	ctx := context.Background()
	const existing = `{"dictation":{"enabled":true,"model":"fixture/stt"},"read_aloud":{"enabled":true,"model":"fixture/tts","voice":"fixture"}}`
	if _, err := store.db.Exec(ctx, `UPDATE app_settings SET speech_settings=$1::jsonb WHERE id=true`, existing); err != nil {
		t.Fatal(err)
	}
	settings, err := store.SpeechSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Dictation.Enabled || settings.Dictation.Model != "fixture/stt" ||
		!settings.ReadAloud.Enabled || settings.ReadAloud.Model != "fixture/tts" || settings.ReadAloud.Voice != "fixture" ||
		settings.ReadAloud.OutputFormat != agent.SpeechOutputMP3 || settings.ReadAloud.MaxTextCharacters != MaxSpeechTextCharacters {
		t.Fatalf("defaults did not preserve the existing speech configuration: %+v", settings)
	}
}
