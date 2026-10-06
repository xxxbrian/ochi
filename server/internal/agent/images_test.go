package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func imageTestPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestImageGenerationsUsesDedicatedEndpointAndRealBytes(t *testing.T) {
	data := imageTestPNG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("X-Proxy") != "test-header" {
			t.Errorf("unexpected image request contract: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "openai/gpt-image-2" || body["prompt"] != "A blue bird" || body["n"] != float64(1) || body["quality"] != "low" {
			t.Errorf("unexpected payload: %+v", body)
		}
		for _, key := range []string{"tools", "stream", "response_format", "input_fidelity", "background", "output_format"} {
			if _, present := body[key]; present {
				t.Errorf("unsupported/unset field sent: %s", key)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(data), "revised_prompt": "Blue bird"}}, "usage": map[string]int{"input_tokens": 7, "output_tokens": 10, "total_tokens": 17}})
	}))
	defer server.Close()
	result, err := GenerateImage(context.Background(), Config{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "openai/gpt-image-2", Headers: map[string]string{"X-Proxy": "test-header"}}, ImageOptions{Prompt: "A blue bird", Quality: "low"})
	if err != nil || !bytes.Equal(result.Data, data) || result.MIMEType != "image/png" || result.Width != 3 || result.Height != 2 || result.RevisedPrompt != "Blue bird" || result.Usage.TotalTokens != 17 {
		t.Fatalf("image result=%+v error=%v", result, err)
	}
}

func TestImageEditsSendsReferenceBytesMultipart(t *testing.T) {
	data := imageTestPNG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/edits" {
			t.Errorf("wrong image endpoint: %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1024 * 1024); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("model") != "gpt-image-2" || r.FormValue("prompt") != "Make it red" || r.FormValue("n") != "1" || r.FormValue("input_fidelity") != "" {
			t.Errorf("wrong editing fields: %+v", r.MultipartForm.Value)
		}
		file, _, err := r.FormFile("image[]")
		if err != nil {
			t.Error(err)
			return
		}
		defer file.Close()
		got, _ := io.ReadAll(file)
		if !bytes.Equal(got, data) {
			t.Error("reference image bytes changed")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
	}))
	defer server.Close()
	_, err := GenerateImage(context.Background(), Config{BaseURL: server.URL, APIKey: "test-key", Model: "gpt-image-2"}, ImageOptions{Prompt: "Make it red", Images: []ImageInput{{Data: data}}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestImageURLDownloadDoesNotForwardProviderSecrets(t *testing.T) {
	data := imageTestPNG(t)
	imageHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Proxy") != "" {
			t.Error("provider credentials reached image download host")
		}
		_, _ = w.Write(data)
	}))
	defer imageHost.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"url": imageHost.URL + "/signed-image"}}})
	}))
	defer provider.Close()
	result, err := GenerateImage(context.Background(), Config{BaseURL: provider.URL, APIKey: "test-key", Model: "gpt-image-2", Headers: map[string]string{"X-Proxy": "private"}}, ImageOptions{Prompt: "A bird"})
	if err != nil || !bytes.Equal(result.Data, data) {
		t.Fatalf("image download failed: %v", err)
	}
}

func TestImageFailureIsNotRebilledAndOptionsValidateBeforeDispatch(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"message":"upstream disconnected"}}`))
	}))
	defer provider.Close()
	config := Config{BaseURL: provider.URL, APIKey: "test-key", Model: "gpt-image-2"}
	if _, err := GenerateImage(context.Background(), config, ImageOptions{Prompt: "A bird", Size: "1000x1000"}); err == nil || requests.Load() != 0 {
		t.Fatal("invalid image size was billed")
	}
	if _, err := GenerateImage(context.Background(), config, ImageOptions{Prompt: "A bird"}); err == nil || !strings.Contains(err.Error(), "502") || requests.Load() != 1 {
		t.Fatalf("failed generation repeated or hidden: requests=%d err=%v", requests.Load(), err)
	}
}
