package storage

import (
	"context"
	"encoding/json"

	"ochi/server/internal/agent"
)

const MaxSpeechTextCharacters = 2000

type SpeechModel struct {
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
}

type SpeechSlot struct {
	SpeechModel
	Enabled bool `json:"enabled"`
}

type SpeechSynthesisOptions struct {
	Voice             string                   `json:"voice"`
	OutputFormat      agent.SpeechOutputFormat `json:"output_format"`
	MaxTextCharacters int                      `json:"max_text_characters"`
}

type ReadAloudSettings struct {
	SpeechSlot
	SpeechSynthesisOptions
}

type SpeechSettings struct {
	Dictation SpeechSlot        `json:"dictation"`
	ReadAloud ReadAloudSettings `json:"read_aloud"`
}

func (s *Store) SpeechSettings(ctx context.Context) (SpeechSettings, error) {
	var data []byte
	settings := SpeechSettings{ReadAloud: ReadAloudSettings{SpeechSynthesisOptions: SpeechSynthesisOptions{
		OutputFormat:      agent.SpeechOutputMP3,
		MaxTextCharacters: MaxSpeechTextCharacters,
	}}}
	err := s.db.QueryRow(ctx, `SELECT speech_settings FROM app_settings WHERE id=true`).Scan(&data)
	if err == nil {
		err = json.Unmarshal(data, &settings)
	}
	return settings, err
}

func (s *Store) SaveSpeechSettings(ctx context.Context, settings SpeechSettings) error {
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE app_settings SET speech_settings=$1 WHERE id=true`, data)
	return err
}
