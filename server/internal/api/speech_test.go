package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"ochi/server/internal/filelimits"
	"ochi/server/internal/storage"
)

const speechFixtureWAV = "RIFF\x26\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x02\x00\x00\x00\x00\x00"

func TestSpeechHTTPSettingsAndDispatch(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	const (
		adminSettings = "/api/admin/speech"
		capabilities  = "/api/speech/capabilities"
		transcription = "/api/speech/transcriptions"
		synthesis     = "/api/speech/synthesis"
		testSynthesis = "/api/admin/speech/test-synthesis"
		adminTestSTT  = "/api/admin/speech/test-transcription"
		apiKey        = "speech-key-fixture"
		secretHeader  = "speech-header-fixture"
	)

	fixtureAudio := []byte{0xff, 0xfb, 0x90, 0x64, 0, 0, 0}
	var transcriptions, syntheses atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiKey || r.Header.Get("X-Connection") != secretHeader {
			t.Error("speech request did not use the selected Provider")
		}
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			transcriptions.Add(1)
			if r.FormValue("model") != "relay/vendor/transcribe" {
				t.Error("transcription used the wrong upstream model")
			}
			if r.MultipartForm != nil {
				defer r.MultipartForm.RemoveAll()
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				http.Error(w, "missing recording", http.StatusBadRequest)
				return
			}
			defer file.Close()
			data, err := io.ReadAll(file)
			if err != nil || string(data) != speechFixtureWAV {
				t.Error("transcription audio bytes changed")
			}
			_, _ = io.WriteString(w, `{"text":"fixture transcript"}`)
		case "/v1/audio/speech":
			syntheses.Add(1)
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
				body["model"] != "relay/vendor/synthesize" || body["voice"] != "voice-one" || body["response_format"] != "mp3" {
				t.Error("synthesis selected the wrong model, voice, or audio format")
			}
			if body["input"] == "provider rejects this" {
				w.WriteHeader(http.StatusPaymentRequired)
				_, _ = fmt.Fprintf(w, `{"error":{"message":%q}}`, apiKey+" and "+secretHeader)
				return
			}
			if body["input"] == "" {
				t.Error("synthesis upstream received empty text")
			}
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write(fixtureAudio)
		default:
			t.Errorf("unexpected speech upstream path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	provider, err := f.server.store.SaveProvider(ctx, storage.Provider{Name: "Fixture", Protocol: "openai-responses",
		BaseURL: upstream.URL + "/v1", APIKey: apiKey, Enabled: true, Headers: map[string]string{"X-Connection": secretHeader}})
	if err != nil {
		t.Fatal(err)
	}
	stt := storage.SpeechModel{ProviderID: provider.ID, Model: "relay/vendor/transcribe"}
	tts := storage.SpeechModel{ProviderID: provider.ID, Model: "relay/vendor/synthesize"}
	formRequest := func(token, path string, recording []byte, fields map[string]string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := speechMultipartRequest(t, path, recording, fields)
		req.Header.Set("Authorization", "Bearer "+token)
		return serveSpeechFixture(t, f.server.Handler(), req, want)
	}
	expectCapabilities := func(dictation, readAloud bool) {
		t.Helper()
		var got struct {
			Dictation           bool `json:"dictation"`
			ReadAloud           bool `json:"read_aloud"`
			MaxRecordingSeconds int  `json:"max_recording_seconds"`
			MaxUploadBytes      int  `json:"max_upload_bytes"`
			MaxTextCharacters   int  `json:"max_text_characters"`
		}
		data := f.request(t, f.token, http.MethodGet, capabilities, "", http.StatusOK)
		if err := json.Unmarshal(data, &got); err != nil || got.Dictation != dictation || got.ReadAloud != readAloud ||
			got.MaxRecordingSeconds != 90 || got.MaxUploadBytes != 10<<20 || got.MaxTextCharacters != 2000 {
			t.Fatal("wrong public speech capabilities", string(data))
		}
		if bytes.Contains(data, []byte(provider.ID)) {
			t.Fatal("public capabilities exposed an internal connection ID")
		}
	}
	f.request(t, "", http.MethodGet, capabilities, "", http.StatusUnauthorized)
	f.request(t, "", http.MethodPost, transcription, "", http.StatusUnauthorized)
	f.request(t, "", http.MethodPost, synthesis, "", http.StatusUnauthorized)
	f.request(t, "", http.MethodGet, adminSettings, "", http.StatusUnauthorized)
	f.request(t, f.token, http.MethodGet, adminSettings, "", http.StatusForbidden)
	f.request(t, f.token, http.MethodPut, adminSettings, "{}", http.StatusForbidden)
	f.request(t, f.token, http.MethodPost, adminTestSTT, "{}", http.StatusForbidden)
	f.request(t, f.token, http.MethodPost, testSynthesis, "{}", http.StatusForbidden)
	expectCapabilities(false, false)
	formRequest(f.token, transcription, []byte(speechFixtureWAV), nil, http.StatusServiceUnavailable)
	f.request(t, f.token, http.MethodPost, synthesis, `{"text":"hello"}`, http.StatusServiceUnavailable)

	preview := formRequest(f.foreign, adminTestSTT, []byte(speechFixtureWAV),
		map[string]string{"provider_id": stt.ProviderID, "model": stt.Model}, http.StatusOK)
	if preview.Body.String() != "{\"text\":\"fixture transcript\"}\n" {
		t.Fatal("admin transcription did not return text")
	}
	payload, _ := json.Marshal(map[string]string{
		"provider_id": tts.ProviderID, "model": tts.Model, "voice": "voice-one", "text": "admin tests unsaved settings",
	})
	audio := f.request(t, f.foreign, http.MethodPost, testSynthesis, string(payload), http.StatusOK)
	if !bytes.Equal(fixtureAudio, audio) {
		t.Fatal("admin synthesis did not return audio")
	}
	expectCapabilities(false, false)
	f.request(t, f.foreign, http.MethodPut, adminSettings, `{}`, http.StatusBadRequest)
	f.request(t, f.foreign, http.MethodPut, adminSettings, `{"dictation":{"enabled":true},"read_aloud":{"enabled":false}}`, http.StatusBadRequest)

	settings := storage.SpeechSettings{
		Dictation: storage.SpeechSlot{SpeechModel: stt, Enabled: true},
		ReadAloud: storage.ReadAloudSettings{SpeechSlot: storage.SpeechSlot{SpeechModel: tts}, Voice: " voice-one "},
	}
	data, _ := json.Marshal(settings)
	f.request(t, f.foreign, http.MethodPut, adminSettings, string(data), http.StatusOK)
	expectCapabilities(true, false)
	f.request(t, f.token, http.MethodPost, synthesis, `{"text":"hello"}`, http.StatusServiceUnavailable)
	settings.ReadAloud.Enabled = true
	data, _ = json.Marshal(settings)
	f.request(t, f.foreign, http.MethodPut, adminSettings, string(data), http.StatusOK)
	data = f.request(t, f.foreign, http.MethodGet, adminSettings, "", http.StatusOK)
	var saved storage.SpeechSettings
	settings.ReadAloud.Voice = "voice-one"
	if err := json.Unmarshal(data, &saved); err != nil || saved != settings ||
		bytes.Contains(data, []byte(apiKey)) || bytes.Contains(data, []byte(secretHeader)) {
		t.Fatal("admin config read did not preserve only the normalized public settings")
	}
	expectCapabilities(true, true)

	formRequest(f.token, transcription, []byte(speechFixtureWAV), nil, http.StatusOK)
	formRequest(f.token, transcription, []byte(speechFixtureWAV), map[string]string{"model": "client override"}, http.StatusBadRequest)
	formRequest(f.token, transcription, nil, nil, http.StatusBadRequest)
	formRequest(f.token, transcription, []byte("not audio"), nil, http.StatusUnsupportedMediaType)
	f.request(t, f.token, http.MethodPost, synthesis, `{"text":"hello","voice":"client override"}`, http.StatusBadRequest)
	f.request(t, f.token, http.MethodPost, synthesis, `{"text":"  "}`, http.StatusBadRequest)
	f.request(t, f.token, http.MethodPost, synthesis, fmt.Sprintf(`{"text":%q}`, strings.Repeat("\u4f60", 2001)), http.StatusBadRequest)
	req := httptest.NewRequest(http.MethodPost, synthesis, strings.NewReader(fmt.Sprintf(`{"text":%q}`, strings.Repeat("\u4f60", 2000))))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+f.token)
	res := serveSpeechFixture(t, f.server.Handler(), req, http.StatusOK)
	if res.Header().Get("Content-Type") != "audio/mpeg" || res.Header().Get("Cache-Control") != "no-store" ||
		!bytes.Equal(res.Body.Bytes(), fixtureAudio) {
		t.Fatal("synthesis did not return private MP3 bytes")
	}
	data = f.request(t, f.token, http.MethodPost, synthesis, `{"text":"provider rejects this"}`, http.StatusBadGateway)
	if !bytes.Contains(data, []byte(`"code":"speech_provider_http_error"`)) || !bytes.Contains(data, []byte(`"status":402`)) ||
		bytes.Contains(data, []byte(apiKey)) || bytes.Contains(data, []byte(secretHeader)) {
		t.Fatal("speech provider diagnostic leaked input or lost its HTTP status")
	}
	if transcriptions.Load() != 2 || syntheses.Load() != 3 {
		t.Fatal("invalid or unavailable speech requests reached the provider")
	}

	provider.Enabled = false
	if _, err = f.server.store.SaveProvider(ctx, provider); err != nil {
		t.Fatal(err)
	}
	expectCapabilities(false, false)
	f.request(t, f.token, http.MethodPost, synthesis, `{"text":"hello"}`, http.StatusServiceUnavailable)
	data, _ = json.Marshal(settings)
	f.request(t, f.foreign, http.MethodPut, adminSettings, string(data), http.StatusBadRequest)
	if err := f.server.store.DeleteProvider(ctx, provider.ID); err != nil {
		t.Fatal(err)
	}
	expectCapabilities(false, false)
	settings.Dictation.Enabled, settings.ReadAloud.Enabled = false, false
	data, _ = json.Marshal(settings)
	f.request(t, f.foreign, http.MethodPut, adminSettings, string(data), http.StatusOK)
}

func TestSpeechRecordingUploadLimits(t *testing.T) {
	samples := []struct {
		name      string
		size      int
		chunked   bool
		wantValid bool
	}{
		{"exactly at the upload limit", maxSpeechUploadBytes, false, true},
		{"file part over the limit", maxSpeechUploadBytes + 1, false, false},
		{"chunked upload over the limit", maxSpeechUploadBytes + 1, true, false},
		{"declared body over the limit", maxSpeechUploadBytes + int(filelimits.MultipartOverheadBytes), false, false},
	}
	for _, sample := range samples {
		t.Run(sample.name, func(t *testing.T) {
			req := speechMultipartRequest(t, "/", make([]byte, sample.size), nil)
			if sample.chunked {
				req.ContentLength = -1
			}
			res := httptest.NewRecorder()
			_, _, valid := readSpeechRecording(res, req, false)
			if valid != sample.wantValid || !valid && res.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("upload valid=%t HTTP %d", valid, res.Code)
			}
		})
	}
}

func speechMultipartRequest(t *testing.T, path string, recording []byte, fields map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "example.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(recording); err != nil {
		t.Fatal(err)
	}
	for key, value := range fields {
		if err := form.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	return req
}

func serveSpeechFixture(t *testing.T, server http.Handler, req *http.Request, want int) *httptest.ResponseRecorder {
	t.Helper()
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != want {
		t.Fatalf("%s %s returned HTTP %d, want %d", req.Method, req.URL.Path, res.Code, want)
	}
	return res
}
