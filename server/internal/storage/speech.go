package storage

import (
	"context"
	"encoding/json"
)

type SpeechModel struct {
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
}

type SpeechSlot struct {
	SpeechModel
	Enabled bool `json:"enabled"`
}

type ReadAloudSettings struct {
	SpeechSlot
	Voice string `json:"voice"`
}

type SpeechSettings struct {
	Dictation SpeechSlot        `json:"dictation"`
	ReadAloud ReadAloudSettings `json:"read_aloud"`
}

func (s *Store) SpeechSettings(ctx context.Context) (SpeechSettings, error) {
	var data []byte
	var settings SpeechSettings
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
