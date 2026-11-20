package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ochi/server/internal/i18n"
	"ochi/server/internal/product"
)

func TestSpeechProviderAudioProtocol(t *testing.T) {
	const model = "relay/voice/vendor-model"
	const text = "A short voice sample."
	const voice = "preview-voice"
	mp3 := []byte{0xff, 0xfb, 0x90, 0x64, 0, 0, 0}
	var calls atomic.Int32
	received := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost ||
			r.Header.Get("Authorization") != "Bearer local-provider-fixture" ||
			r.Header.Get("X-Provider-Account") != "fixture-account" ||
			r.Header.Get("User-Agent") != product.UserAgent() {
			t.Error("provider method, credentials, custom headers or product user agent were lost")
		}
		switch r.URL.Path {
		case "/proxy/v1/audio/transcriptions":
			if r.Header.Get("Accept") != "application/json" {
				t.Error("transcription did not request JSON")
			}
			if err := r.ParseMultipartForm(1024); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if !slices.Equal(r.MultipartForm.Value["model"], []string{model}) || len(r.MultipartForm.Value) != 1 {
				t.Error("multipart speech model changed or included an unexpected field")
			}
			file, header, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer file.Close()
			payload, err := io.ReadAll(file)
			name, mimeType := recordingFormat(payload)
			if err != nil || name != header.Filename || mimeType != header.Header.Get("Content-Type") || name == "" {
				t.Error("recording metadata does not match the audio container")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"text":"Transcribed text"}`)
		case "/proxy/v1/audio/speech":
			var fields map[string]string
			if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Accept") != "audio/mpeg" ||
				json.NewDecoder(r.Body).Decode(&fields) != nil || len(fields) != 4 ||
				fields["model"] != model || fields["voice"] != voice || fields["input"] != text || fields["response_format"] != "mp3" {
				t.Error("synthesis did not send the expected Audio API request")
			}
			w.Header().Set("Content-Type", "audio/mp3")
			_, _ = w.Write(mp3)
		default:
			t.Errorf("unexpected audio route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(received.Close)
	config := Config{BaseURL: received.URL + "/proxy/v1/", Protocol: "openai-responses", Model: model,
		APIKey: "local-provider-fixture", Headers: map[string]string{
			"X-Provider-Account": "fixture-account", "Accept": "text/event-stream", "Content-Type": "application/json",
		}}
	recordings := [][]byte{
		[]byte("RIFF\x00\x00\x00\x00WAVE"),
		[]byte("OggS\x00fixture"),
		[]byte("\x1a\x45\xdf\xa3"),
		[]byte("\x00\x00\x00\x18ftypM4A "),
		[]byte("fLaCfixture"),
		[]byte("ID3\x03\x00\x00\x00\x00\x00\x0f"),
		mp3,
	}
	for _, recording := range recordings {
		if result, err := TranscribeSpeech(context.Background(), config, recording); err != nil || result != "Transcribed text" {
			t.Fatalf("transcription was %q, %v", result, err)
		}
	}
	if result, err := SynthesizeSpeech(context.Background(), config, voice, text); err != nil || !bytes.Equal(result, mp3) {
		t.Fatalf("synthesis did not return the audio bytes: %v", err)
	}
	if got := calls.Load(); got != int32(len(recordings)+1) {
		t.Fatalf("provider calls = %d", got)
	}
}

func TestSpeechProviderDoesNotReplayOrFollowRedirects(t *testing.T) {
	var calls, redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
	}))
	t.Cleanup(target.Close)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(server.Close)
	_, err := SynthesizeSpeech(context.Background(), Config{BaseURL: server.URL, Model: "fixture"}, "voice", "hello")
	code, params, _ := i18n.Details(err)
	if code != "speech_provider_http_error" || params["status"] != http.StatusTemporaryRedirect ||
		calls.Load() != 1 || redirected.Load() != 0 {
		t.Fatalf("speech request was redirected or repeated: %v", err)
	}
}

func TestSpeechRejectsInvalidAndOversizeResponses(t *testing.T) {
	tests := []struct {
		name          string
		body          string
		transcription bool
		want          string
	}{
		{"missing transcript", `{"error":{"message":"invalid"}}`, true, "speech_transcription_response_invalid"},
		{"oversize transcript", `{"text":"` + strings.Repeat("x", maxTranscriptionResponseBytes) + `"}`, true, "speech_provider_response_too_large"},
		{"JSON masquerading as audio", `{"audio_data":"fixture"}`, false, "speech_synthesis_response_invalid"},
		{"wrong codec", "RIFF\x00\x00\x00\x00WAVE", false, "speech_synthesis_response_invalid"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "audio/mpeg")
				_, _ = io.WriteString(w, test.body)
			}))
			t.Cleanup(server.Close)
			config := Config{BaseURL: server.URL, Model: "fixture"}
			var err error
			if test.transcription {
				_, err = TranscribeSpeech(context.Background(), config, []byte("RIFF\x00\x00\x00\x00WAVE"))
			} else {
				_, err = SynthesizeSpeech(context.Background(), config, "voice", "hello")
			}
			if code, _, _ := i18n.Details(err); code != test.want {
				t.Fatalf("error = %v, want %s", err, test.want)
			}
		})
	}
}

func TestSpeechProviderRespectsRequestCancellation(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := SynthesizeSpeech(ctx, Config{BaseURL: server.URL, Model: "fixture"}, "voice", "hello")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("synthesis succeeded with a canceled connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("synthesis ignored cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("provider connection stayed open after client cancellation")
	}
}
