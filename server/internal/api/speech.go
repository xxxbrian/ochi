package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ochi/server/internal/agent"
	"ochi/server/internal/filelimits"
	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
)

const (
	maxSpeechRecordingSeconds = 90
	maxSpeechUploadBytes      = 10 << 20
	maxSpeechTextCharacters   = 2000
	maxSpeechConfigFieldBytes = 512
)

func (s *Server) registerSpeechRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/speech/capabilities", s.auth.require(s.speechCapabilities))
	mux.HandleFunc("POST /api/speech/transcriptions", s.auth.require(s.transcribeSpeech))
	mux.HandleFunc("POST /api/speech/synthesis", s.auth.require(s.synthesizeSpeech))
	mux.HandleFunc("GET /api/admin/speech", s.auth.admin(s.adminSpeech))
	mux.HandleFunc("PUT /api/admin/speech", s.auth.admin(s.adminSpeech))
	mux.HandleFunc("POST /api/admin/speech/test-transcription", s.auth.admin(s.testSpeechTranscription))
	mux.HandleFunc("POST /api/admin/speech/test-synthesis", s.auth.admin(s.testSpeechSynthesis))
}

// Resolve the connection on each use so a provider can be disabled or removed
// without rewriting speech preferences or advertising unusable capabilities.
func (s *Server) enabledSpeechProvider(ctx context.Context, id string) (storage.Provider, error) {
	if id == "" {
		return storage.Provider{}, nil
	}
	provider, err := s.store.Provider(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return storage.Provider{}, nil
	}
	if err != nil {
		return storage.Provider{}, err
	}
	if !provider.Enabled || (provider.APIKey == "" && !provider.AllowNoKey) {
		return storage.Provider{}, nil
	}
	return provider, nil
}

func (s *Server) speechCapabilities(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.SpeechSettings(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	capabilities := struct {
		Dictation           bool `json:"dictation"`
		ReadAloud           bool `json:"read_aloud"`
		MaxRecordingSeconds int  `json:"max_recording_seconds"`
		MaxUploadBytes      int  `json:"max_upload_bytes"`
		MaxTextCharacters   int  `json:"max_text_characters"`
	}{MaxRecordingSeconds: maxSpeechRecordingSeconds, MaxUploadBytes: maxSpeechUploadBytes, MaxTextCharacters: maxSpeechTextCharacters}
	for _, item := range []struct {
		slot      storage.SpeechSlot
		available *bool
	}{{settings.Dictation, &capabilities.Dictation}, {settings.ReadAloud.SpeechSlot, &capabilities.ReadAloud}} {
		if item.slot.Enabled {
			provider, err := s.enabledSpeechProvider(r.Context(), item.slot.ProviderID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			*item.available = provider.ID != ""
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, capabilities)
}

func normalizeSpeechModel(model *storage.SpeechModel, required bool) error {
	model.ProviderID = strings.TrimSpace(model.ProviderID)
	model.Model = strings.TrimSpace(model.Model)
	var id pgtype.UUID
	if model.ProviderID != "" && (id.Scan(model.ProviderID) != nil || id.String() != strings.ToLower(model.ProviderID)) {
		return i18n.New("speech_provider_unavailable")
	}
	model.ProviderID = id.String()
	if len(model.Model) > maxSpeechConfigFieldBytes || !utf8.ValidString(model.Model) || strings.ContainsFunc(model.Model, unicode.IsControl) ||
		(required && (model.ProviderID == "" || model.Model == "")) {
		return i18n.New("speech_configuration_invalid")
	}
	return nil
}

func normalizeSpeechVoice(voice *string, required bool) error {
	*voice = strings.TrimSpace(*voice)
	if (required && *voice == "") || len(*voice) > maxSpeechConfigFieldBytes || strings.ContainsFunc(*voice, unicode.IsControl) {
		return i18n.New("speech_voice_required")
	}
	return nil
}

func (s *Server) adminSpeech(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		settings, err := s.store.SpeechSettings(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, settings)
		return
	}
	var input struct {
		Dictation *storage.SpeechSlot        `json:"dictation"`
		ReadAloud *storage.ReadAloudSettings `json:"read_aloud"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	if input.Dictation == nil || input.ReadAloud == nil {
		writeError(w, http.StatusBadRequest, i18n.New("speech_configuration_invalid"))
		return
	}
	settings := storage.SpeechSettings{Dictation: *input.Dictation, ReadAloud: *input.ReadAloud}
	if err := normalizeSpeechVoice(&settings.ReadAloud.Voice, settings.ReadAloud.Enabled); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	for _, slot := range []*storage.SpeechSlot{&settings.Dictation, &settings.ReadAloud.SpeechSlot} {
		if err := normalizeSpeechModel(&slot.SpeechModel, slot.Enabled); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if slot.Enabled {
			if _, ok := s.speechConfig(w, r, slot.SpeechModel, true); !ok {
				return
			}
		}
	}
	if err := s.store.SaveSpeechSettings(r.Context(), settings); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) speechConfig(w http.ResponseWriter, r *http.Request, model storage.SpeechModel, admin bool) (agent.Config, bool) {
	provider, err := s.enabledSpeechProvider(r.Context(), model.ProviderID)
	if err != nil {
		writeStoreError(w, err)
		return agent.Config{}, false
	}
	if provider.ID == "" {
		if admin {
			writeError(w, http.StatusBadRequest, i18n.New("speech_provider_unavailable"))
		} else {
			writeError(w, http.StatusServiceUnavailable, i18n.New("speech_unavailable"))
		}
		return agent.Config{}, false
	}
	return agent.Config{
		BaseURL: provider.BaseURL, APIKey: provider.APIKey, Headers: provider.Headers,
		Model: model.Model, TimeoutSeconds: provider.TimeoutSeconds,
	}, true
}

func readSpeechRecording(w http.ResponseWriter, r *http.Request, test bool) (storage.SpeechModel, []byte, bool) {
	const bodyLimit = maxSpeechUploadBytes + filelimits.MultipartOverheadBytes
	if r.ContentLength > bodyLimit {
		writeSpeechRecordingError(w, &http.MaxBytesError{Limit: bodyLimit})
		return storage.SpeechModel{}, nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	form, err := r.MultipartReader()
	if err != nil {
		writeSpeechRecordingError(w, err)
		return storage.SpeechModel{}, nil, false
	}
	var model storage.SpeechModel
	parts := map[string][]byte{}
	for {
		part, err := form.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeSpeechRecordingError(w, err)
			return model, nil, false
		}
		name := part.FormName()
		isFile := name == "file" && part.FileName() != ""
		isField := test && (name == "provider_id" || name == "model") && part.FileName() == ""
		if _, seen := parts[name]; seen || (!isFile && !isField) {
			writeError(w, http.StatusBadRequest, i18n.New("speech_recording_invalid"))
			return model, nil, false
		}
		limit := int64(maxSpeechConfigFieldBytes)
		if isFile {
			limit = maxSpeechUploadBytes
		}
		value, err := io.ReadAll(io.LimitReader(part, limit+1))
		if err != nil {
			writeSpeechRecordingError(w, err)
			return model, nil, false
		}
		if isFile && int64(len(value)) > limit {
			writeSpeechRecordingError(w, &http.MaxBytesError{Limit: limit})
			return model, nil, false
		}
		if int64(len(value)) > limit {
			writeError(w, http.StatusBadRequest, i18n.New("speech_configuration_invalid"))
			return model, nil, false
		}
		parts[name] = value
	}
	recording := parts["file"]
	if len(recording) == 0 {
		writeError(w, http.StatusBadRequest, i18n.New("speech_recording_required"))
		return model, nil, false
	}
	if test {
		model = storage.SpeechModel{ProviderID: string(parts["provider_id"]), Model: string(parts["model"])}
		if err := normalizeSpeechModel(&model, true); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return model, nil, false
		}
	}
	return model, recording, true
}

func writeSpeechRecordingError(w http.ResponseWriter, err error) {
	if errors.As(err, new(*http.MaxBytesError)) {
		writeError(w, http.StatusRequestEntityTooLarge, i18n.With("speech_recording_too_large", map[string]any{"max": maxSpeechUploadBytes >> 20}))
		return
	}
	writeError(w, http.StatusBadRequest, i18n.New("speech_recording_invalid"))
}

func (s *Server) transcribeSpeech(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.SpeechSettings(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !settings.Dictation.Enabled {
		writeError(w, http.StatusServiceUnavailable, i18n.New("speech_unavailable"))
		return
	}
	config, ok := s.speechConfig(w, r, settings.Dictation.SpeechModel, false)
	if !ok {
		return
	}
	if _, recording, ok := readSpeechRecording(w, r, false); ok {
		writeTranscription(w, r, config, recording)
	}
}

func (s *Server) testSpeechTranscription(w http.ResponseWriter, r *http.Request) {
	model, recording, ok := readSpeechRecording(w, r, true)
	if !ok {
		return
	}
	if config, ok := s.speechConfig(w, r, model, true); ok {
		writeTranscription(w, r, config, recording)
	}
}

func writeTranscription(w http.ResponseWriter, r *http.Request, config agent.Config, recording []byte) {
	text, err := agent.TranscribeSpeech(r.Context(), config, recording)
	if err != nil {
		code, _, _ := i18n.Details(err)
		if code == "speech_recording_format_invalid" {
			writeError(w, http.StatusUnsupportedMediaType, err)
		} else {
			writeSpeechProviderError(w, err)
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (s *Server) synthesizeSpeech(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Text string `json:"text"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	settings, err := s.store.SpeechSettings(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !settings.ReadAloud.Enabled {
		writeError(w, http.StatusServiceUnavailable, i18n.New("speech_unavailable"))
		return
	}
	if config, ok := s.speechConfig(w, r, settings.ReadAloud.SpeechModel, false); ok {
		writeSpeechAudio(w, r, config, settings.ReadAloud.Voice, input.Text)
	}
}

func (s *Server) testSpeechSynthesis(w http.ResponseWriter, r *http.Request) {
	var input struct {
		storage.SpeechModel
		Voice string `json:"voice"`
		Text  string `json:"text"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	if err := normalizeSpeechModel(&input.SpeechModel, true); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := normalizeSpeechVoice(&input.Voice, true); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if config, ok := s.speechConfig(w, r, input.SpeechModel, true); ok {
		writeSpeechAudio(w, r, config, input.Voice, input.Text)
	}
}

func writeSpeechAudio(w http.ResponseWriter, r *http.Request, config agent.Config, voice, text string) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > maxSpeechTextCharacters {
		writeError(w, http.StatusBadRequest, i18n.With("speech_text_invalid", map[string]any{"max": maxSpeechTextCharacters}))
		return
	}
	audio, err := agent.SynthesizeSpeech(r.Context(), config, voice, text)
	if err != nil {
		writeSpeechProviderError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(audio)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(audio)
}

func writeSpeechProviderError(w http.ResponseWriter, err error) {
	code, _, _ := i18n.Details(err)
	status := http.StatusBadGateway
	if code == "speech_provider_timeout" {
		status = http.StatusGatewayTimeout
	}
	writeError(w, status, err)
}
