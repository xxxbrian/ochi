package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"

	"ochi/server/internal/i18n"
	"ochi/server/internal/product"
)

const (
	maxTranscriptionResponseBytes = 256 << 10
	maxSynthesisResponseBytes     = 16 << 20
)

// Speech uses the provider connection independently of its chat protocol.
func TranscribeSpeech(ctx context.Context, config Config, recording []byte) (string, error) {
	name, audioType := recordingFormat(recording)
	if audioType == "" {
		return "", i18n.New("speech_recording_format_invalid")
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("model", config.Model); err != nil {
		return "", err
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": name}))
	header.Set("Content-Type", audioType)
	part, err := form.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(recording); err != nil {
		return "", err
	}
	if err = form.Close(); err != nil {
		return "", err
	}
	data, err := speechProviderRequest(ctx, config, "audio/transcriptions", form.FormDataContentType(), "application/json", &body, maxTranscriptionResponseBytes)
	if err != nil {
		return "", err
	}
	var response struct {
		Text *string `json:"text"`
	}
	if err := json.Unmarshal(data, &response); err != nil || response.Text == nil {
		return "", i18n.New("speech_transcription_response_invalid")
	}
	return *response.Text, nil
}

func SynthesizeSpeech(ctx context.Context, config Config, voice, text string) ([]byte, error) {
	payload, err := json.Marshal(struct {
		Model          string `json:"model"`
		Input          string `json:"input"`
		Voice          string `json:"voice"`
		ResponseFormat string `json:"response_format"`
	}{config.Model, text, voice, "mp3"})
	if err != nil {
		return nil, err
	}
	data, err := speechProviderRequest(ctx, config, "audio/speech", "application/json", "audio/mpeg", bytes.NewReader(payload), maxSynthesisResponseBytes)
	if err != nil {
		return nil, err
	}
	if !isMP3(data) {
		return nil, i18n.New("speech_synthesis_response_invalid")
	}
	return data, nil
}

func speechProviderRequest(ctx context.Context, config Config, endpoint, contentType, accept string, body io.Reader, maxResponseBytes int64) ([]byte, error) {
	base, err := url.Parse(config.BaseURL)
	if err != nil || base.Hostname() == "" || base.User != nil || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, i18n.New("speech_provider_url_invalid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base.JoinPath(endpoint).String(), body)
	if err != nil {
		return nil, i18n.New("speech_provider_url_invalid")
	}
	// Do not replay a billable audio POST, even with a configured idempotency header.
	req.GetBody = nil
	req.Header.Set("User-Agent", product.UserAgent())
	if config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	}
	for key, value := range config.Headers {
		req.Header.Set(key, value)
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("Content-Type", contentType)
	client := providerClient(config)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, speechTransportError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, i18n.With("speech_provider_http_error", map[string]any{"status": resp.StatusCode})
	}
	if resp.ContentLength > maxResponseBytes {
		return nil, i18n.New("speech_provider_response_too_large")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, speechTransportError(err)
	}
	if int64(len(data)) > maxResponseBytes {
		return nil, i18n.New("speech_provider_response_too_large")
	}
	return data, nil
}

func speechTransportError(err error) error {
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) && network.Timeout() {
		return i18n.Wrap("speech_provider_timeout", err)
	}
	return i18n.Wrap("speech_provider_connection_failed", err)
}

func recordingFormat(data []byte) (name, contentType string) {
	switch http.DetectContentType(data) {
	case "audio/wave":
		return "recording.wav", "audio/wav"
	case "application/ogg":
		return "recording.ogg", "audio/ogg"
	case "video/webm":
		return "recording.webm", "audio/webm"
	}
	switch {
	case len(data) >= 12 && string(data[4:8]) == "ftyp":
		return "recording.m4a", "audio/mp4"
	case bytes.HasPrefix(data, []byte("fLaC")):
		return "recording.flac", "audio/flac"
	case isMP3(data):
		return "recording.mp3", "audio/mpeg"
	default:
		return "", ""
	}
}

func isMP3(data []byte) bool {
	if len(data) >= 10 && bytes.HasPrefix(data, []byte("ID3")) {
		return true
	}
	// MPEG Layer III frames can start without an ID3 tag.
	return len(data) >= 4 && data[0] == 0xff && data[1]&0xe6 == 0xe2 &&
		data[1]&0x18 != 0x08 && data[2]&0xf0 != 0xf0 && data[2]&0x0c != 0x0c
}
