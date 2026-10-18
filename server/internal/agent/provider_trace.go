package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const providerTraceBodyLimit = 1 << 20
const providerTraceChunkLimit = 2048

// ProviderTrace is admin-only diagnostic data, never part of a user run stream.
// ObserveProvider must enqueue without waiting for storage. Capture is disabled
// unless DebugEnabled is true when this individual HTTP attempt starts.
type ProviderTrace struct {
	ID                string                `json:"id"`
	RunID             string                `json:"run_id,omitempty"`
	SessionID         string                `json:"session_id,omitempty"`
	Round             string                `json:"round,omitempty"`
	Attempt           int                   `json:"attempt"`
	Purpose           string                `json:"purpose"`
	ProviderID        string                `json:"provider_id,omitempty"`
	ModelID           string                `json:"model_id,omitempty"`
	Model             string                `json:"model"`
	Protocol          string                `json:"protocol"`
	Method            string                `json:"method"`
	URL               string                `json:"url"`
	Stream            bool                  `json:"stream"`
	RequestHeaders    http.Header           `json:"request_headers"`
	RequestBody       string                `json:"request_body,omitempty"`
	RequestBytes      int64                 `json:"request_bytes"`
	StatusCode        int                   `json:"status_code,omitempty"`
	ResponseHeaders   http.Header           `json:"response_headers,omitempty"`
	RequestID         string                `json:"request_id,omitempty"`
	ResponseBody      string                `json:"response_body,omitempty"`
	StreamChunks      []ProviderStreamChunk `json:"stream_chunks,omitempty"`
	ResponseBytes     int64                 `json:"response_bytes"`
	CapturedBytes     int                   `json:"captured_bytes"`
	StartedAt         time.Time             `json:"started_at"`
	FirstByteAt       *time.Time            `json:"first_byte_at,omitempty"`
	FirstTokenAt      *time.Time            `json:"first_token_at,omitempty"`
	LastDataAt        *time.Time            `json:"last_data_at,omitempty"`
	FinishedAt        time.Time             `json:"finished_at"`
	DurationMS        int64                 `json:"duration_ms"`
	TTFBMS            *int64                `json:"ttfb_ms,omitempty"`
	TTFTMS            *int64                `json:"ttft_ms,omitempty"`
	FinishReason      string                `json:"finish_reason,omitempty"`
	ResponseStatus    string                `json:"response_status,omitempty"`
	SawDone           bool                  `json:"saw_done"`
	SawCompleted      bool                  `json:"saw_completed"`
	SawEOF            bool                  `json:"saw_eof"`
	Usage             *Usage                `json:"usage,omitempty"`
	ErrorClass        string                `json:"error_class,omitempty"`
	Error             string                `json:"error,omitempty"`
	ReadError         string                `json:"read_error,omitempty"`
	UpstreamErrorCode string                `json:"upstream_error_code,omitempty"`
	UpstreamErrorType string                `json:"upstream_error_type,omitempty"`
	UpstreamError     string                `json:"upstream_error,omitempty"`
	RequestTruncated  bool                  `json:"request_truncated"`
	ResponseTruncated bool                  `json:"response_truncated"`
	Truncated         bool                  `json:"truncated"`
	Redacted          bool                  `json:"redacted"`
}

// Chunks contain complete, redacted SSE lines, including event/comment/blank
// lines, in wire order. AtMS is when the line's final captured byte arrived.
type ProviderStreamChunk struct {
	Sequence int    `json:"sequence"`
	AtMS     int64  `json:"at_ms"`
	Data     string `json:"data"`
}

type providerTraceContext struct {
	round   string
	attempt int
	purpose string
}

type providerTraceKey struct{}

// WithProviderTracePurpose distinguishes auxiliary work such as titles, memory
// and compaction without changing any provider request parameters.
func WithProviderTracePurpose(ctx context.Context, purpose string) context.Context {
	value, _ := ctx.Value(providerTraceKey{}).(providerTraceContext)
	value.purpose = purpose
	return context.WithValue(ctx, providerTraceKey{}, value)
}

func defaultProviderTracePurpose(ctx context.Context, purpose string) context.Context {
	value, _ := ctx.Value(providerTraceKey{}).(providerTraceContext)
	if value.purpose == "" {
		return WithProviderTracePurpose(ctx, purpose)
	}
	return ctx
}

func withProviderTraceRound(ctx context.Context, round string) context.Context {
	value, _ := ctx.Value(providerTraceKey{}).(providerTraceContext)
	value.round = round
	return context.WithValue(ctx, providerTraceKey{}, value)
}

func withProviderTraceAttempt(ctx context.Context, round string, attempt int) context.Context {
	value, _ := ctx.Value(providerTraceKey{}).(providerTraceContext)
	if round != "" {
		value.round = round
	}
	value.attempt = attempt
	return context.WithValue(ctx, providerTraceKey{}, value)
}

type providerTraceCapture struct {
	mu        sync.Mutex
	trace     ProviderTrace
	observe   func(ProviderTrace)
	redactor  traceRedactor
	response  bytes.Buffer
	arrivals  []traceArrival
	finished  bool
	length    int64
	streaming bool
	binary    bool
}

type traceArrival struct {
	end int
	at  int64
}

type providerTraceBody struct {
	io.ReadCloser
	capture *providerTraceCapture
}

func newProviderTrace(config Config, req *http.Request, payload []byte) *providerTraceCapture {
	if config.DebugEnabled == nil || config.ObserveProvider == nil || !config.DebugEnabled() {
		return nil
	}
	redactor := newTraceRedactor(config, req.URL, req.Header)
	metadata, _ := req.Context().Value(providerTraceKey{}).(providerTraceContext)
	scope, _ := ScopeFromContext(req.Context())
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	trace := ProviderTrace{ID: hex.EncodeToString(id), RunID: scope.RunID, SessionID: scope.SessionID,
		Round: metadata.round, Attempt: max(1, metadata.attempt), Purpose: metadata.purpose,
		ProviderID: config.ProviderID, ModelID: config.ModelID, Model: config.Model,
		Protocol: config.Protocol, Method: req.Method, StartedAt: time.Now().UTC(), RequestBytes: req.ContentLength}
	if trace.Protocol == "" {
		trace.Protocol = "openai"
	}
	if trace.Purpose == "" {
		trace.Purpose = "chat"
		if strings.Contains(req.URL.Path, "/embeddings") {
			trace.Purpose = "embedding"
		} else if strings.Contains(req.URL.Path, "/images/") {
			trace.Purpose = "image"
		}
	}
	trace.URL = redactor.url(req.URL)
	trace.RequestHeaders = redactor.headers(req.Header)
	if strings.HasPrefix(strings.ToLower(req.Header.Get("Content-Type")), "multipart/") {
		trace.RequestBody = "[multipart image input omitted]"
		redactor.changed = true
	} else if traceBinaryContentType(req.Header.Get("Content-Type")) {
		trace.RequestBody = "[binary payload omitted]"
		redactor.changed = true
	} else if len(payload) > providerTraceBodyLimit {
		trace.RequestBody, trace.RequestTruncated = "[request body exceeds debug capture limit]", true
	} else {
		trace.RequestBody = redactor.body(string(payload), false)
		if len(trace.RequestBody) > providerTraceBodyLimit {
			trace.RequestBody, trace.RequestTruncated = "[redacted request body exceeds debug capture limit]", true
		}
	}
	var options struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(payload, &options)
	trace.Stream = options.Stream
	trace.Redacted = redactor.changed
	return &providerTraceCapture{trace: trace, observe: config.ObserveProvider, redactor: redactor}
}

func (c *providerTraceCapture) request(req *http.Request) *http.Request {
	if c == nil {
		return req
	}
	trace := &httptrace.ClientTrace{GotFirstResponseByte: func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.trace.FirstByteAt == nil {
			now := time.Now().UTC()
			c.trace.FirstByteAt = &now
		}
	}}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
}

func (c *providerTraceCapture) responseHeaders(resp *http.Response) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.trace.StatusCode = resp.StatusCode
	c.length = resp.ContentLength
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	c.binary = traceBinaryContentType(contentType) || c.trace.Purpose == "image_download"
	c.streaming = strings.Contains(contentType, "text/event-stream") || c.trace.Stream && resp.StatusCode >= 200 && resp.StatusCode < 300 && !strings.Contains(contentType, "json") && !c.binary
	c.trace.ResponseHeaders = resp.Header.Clone()
	c.redactor.headerSecrets(resp.Header)
	for _, name := range []string{"X-Request-ID", "Request-ID", "OpenAI-Request-ID", "X-Amzn-Requestid", "CF-Ray", "Traceparent"} {
		if value := resp.Header.Get(name); value != "" {
			c.trace.RequestID = value
			break
		}
	}
	resp.Body = &providerTraceBody{ReadCloser: resp.Body, capture: c}
}

func (r *providerTraceBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	c := r.capture
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.finished {
		return n, err
	}
	if n > 0 {
		now := time.Now().UTC()
		if c.trace.FirstByteAt == nil {
			c.trace.FirstByteAt = &now
		}
		c.trace.LastDataAt = &now
		c.trace.ResponseBytes += int64(n)
		if !c.binary {
			c.appendResponse(p[:n], now.Sub(c.trace.StartedAt).Milliseconds())
		}
	}
	if err != nil {
		if errors.Is(err, io.EOF) {
			c.trace.SawEOF = true
		} else {
			c.trace.ReadError = err.Error()
		}
	}
	return n, err
}

func traceBinaryContentType(contentType string) bool {
	contentType = strings.ToLower(contentType)
	return strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "audio/") || strings.HasPrefix(contentType, "video/") || strings.Contains(contentType, "application/octet-stream")
}

func (c *providerTraceCapture) appendResponse(data []byte, at int64) {
	keep := min(len(data), providerTraceBodyLimit-c.response.Len())
	if c.streaming {
		offset := 0
		for offset < keep {
			if len(c.arrivals) >= providerTraceChunkLimit {
				keep = offset
				break
			}
			newline := bytes.IndexByte(data[offset:keep], '\n')
			if newline < 0 {
				break
			}
			offset += newline + 1
			c.arrivals = append(c.arrivals, traceArrival{end: c.response.Len() + offset, at: at})
		}
	}
	_, _ = c.response.Write(data[:keep])
	if keep < len(data) {
		c.trace.ResponseTruncated = true
	}
}

func responseTrace(resp *http.Response) *providerTraceCapture {
	if resp != nil {
		if body, ok := resp.Body.(*providerTraceBody); ok {
			return body.capture
		}
	}
	return nil
}

func (c *providerTraceCapture) token() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.trace.FirstTokenAt == nil {
		now := time.Now().UTC()
		c.trace.FirstTokenAt = &now
	}
}

func (c *providerTraceCapture) terminal(reason, status string, done, completed bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if reason != "" {
		c.trace.FinishReason = reason
	}
	if status != "" {
		c.trace.ResponseStatus = status
	}
	c.trace.SawDone = c.trace.SawDone || done
	c.trace.SawCompleted = c.trace.SawCompleted || completed
}

func (c *providerTraceCapture) upstream(code, kind, message string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.trace.UpstreamErrorCode, c.trace.UpstreamErrorType, c.trace.UpstreamError = code, kind, message
}

func finishProviderTrace(resp *http.Response, usage *Usage, err error) {
	responseTrace(resp).finish(usage, err)
}

func (c *providerTraceCapture) finish(usage *Usage, err error) {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return
	}
	c.finished = true
	c.trace.FinishedAt = time.Now().UTC()
	c.trace.DurationMS = c.trace.FinishedAt.Sub(c.trace.StartedAt).Milliseconds()
	if c.trace.FirstByteAt != nil {
		ms := c.trace.FirstByteAt.Sub(c.trace.StartedAt).Milliseconds()
		c.trace.TTFBMS = &ms
	}
	if c.trace.FirstTokenAt != nil {
		ms := c.trace.FirstTokenAt.Sub(c.trace.StartedAt).Milliseconds()
		c.trace.TTFTMS = &ms
	}
	if usage != nil {
		copied := *usage
		if usage.CachedTokens != nil {
			value := *usage.CachedTokens
			copied.CachedTokens = &value
		}
		if usage.ReasoningTokens != nil {
			value := *usage.ReasoningTokens
			copied.ReasoningTokens = &value
		}
		c.trace.Usage = &copied
	}
	if err != nil {
		c.trace.Error = err.Error()
		var model *ModelError
		switch {
		case errors.As(err, &model):
			c.trace.ErrorClass = model.Class
		case errors.Is(err, context.Canceled):
			c.trace.ErrorClass = "cancelled"
		case errors.Is(err, context.DeadlineExceeded):
			c.trace.ErrorClass = "timeout"
		default:
			if c.trace.StatusCode >= 400 {
				c.trace.ErrorClass = providerError(c.trace.StatusCode, c.response.Bytes(), "").Class
			} else {
				c.trace.ErrorClass = "response"
			}
		}
		for cause := errors.Unwrap(err); cause != nil; cause = errors.Unwrap(cause) {
			c.trace.Error += ": " + cause.Error()
		}
	}
	c.trace.CapturedBytes = c.response.Len()
	if c.length > c.trace.ResponseBytes {
		c.trace.ResponseTruncated = true
	}
	raw := c.response.String()
	if c.binary {
		c.trace.ResponseBody = "[binary payload omitted]"
		c.redactor.changed = true
	} else if c.streaming {
		c.trace.StreamChunks = c.frames(raw)
	} else {
		if c.trace.ResponseTruncated && !json.Valid([]byte(raw)) {
			c.trace.ResponseBody = "[incomplete response body exceeds debug capture limit]"
		} else {
			c.trace.ResponseBody = c.redactor.body(raw, false)
			if len(c.trace.ResponseBody) > providerTraceBodyLimit {
				c.trace.ResponseBody, c.trace.ResponseTruncated = "[redacted response body exceeds debug capture limit]", true
			}
		}
		c.inspectJSON(raw)
	}
	// Non-streaming requests only expose output after the complete JSON body.
	if !c.trace.Stream && !c.binary && c.trace.FirstTokenAt == nil && c.trace.ErrorClass == "" && c.trace.Purpose != "embedding" && c.trace.LastDataAt != nil {
		c.trace.FirstTokenAt = c.trace.LastDataAt
		ms := c.trace.FirstTokenAt.Sub(c.trace.StartedAt).Milliseconds()
		c.trace.TTFTMS = &ms
	}
	c.trace.ResponseHeaders = c.redactor.headers(c.trace.ResponseHeaders)
	c.trace.RequestHeaders = c.redactor.headers(c.trace.RequestHeaders)
	c.trace.URL = c.redactor.text(c.trace.URL)
	c.trace.RequestBody = c.redactor.body(c.trace.RequestBody, false)
	if len(c.trace.RequestBody) > providerTraceBodyLimit {
		c.trace.RequestBody, c.trace.RequestTruncated = "[redacted request body exceeds debug capture limit]", true
	}
	c.trace.RequestID = c.redactor.text(c.trace.RequestID)
	c.trace.Error = c.redactor.text(c.trace.Error)
	c.trace.ReadError = c.redactor.text(c.trace.ReadError)
	c.trace.UpstreamErrorCode = c.redactor.text(c.trace.UpstreamErrorCode)
	c.trace.UpstreamErrorType = c.redactor.text(c.trace.UpstreamErrorType)
	c.trace.UpstreamError = c.redactor.text(c.trace.UpstreamError)
	c.trace.FinishReason = c.redactor.text(c.trace.FinishReason)
	c.trace.ResponseStatus = c.redactor.text(c.trace.ResponseStatus)
	c.trace.Purpose = c.redactor.text(c.trace.Purpose)
	c.trace.Model = c.redactor.text(c.trace.Model)
	c.trace.Protocol = c.redactor.text(c.trace.Protocol)
	c.trace.Truncated = c.trace.RequestTruncated || c.trace.ResponseTruncated
	c.trace.Redacted = c.trace.Redacted || c.redactor.changed
	trace, observe := c.trace, c.observe
	c.response.Reset()
	c.arrivals = nil
	c.mu.Unlock()
	observe(trace)
}

func (c *providerTraceCapture) frames(raw string) []ProviderStreamChunk {
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "data:") {
			c.redactor.rememberBodySecrets(line[len("data:"):])
		}
	}
	frames := []ProviderStreamChunk{}
	offset, arrival, captured := 0, 0, 0
	for offset < len(raw) {
		length := strings.IndexByte(raw[offset:], '\n') + 1
		if length == 0 {
			if c.trace.ResponseTruncated {
				break
			}
			length = len(raw) - offset
		}
		if len(frames) == providerTraceChunkLimit {
			c.trace.ResponseTruncated = true
			break
		}
		end := offset + length
		for arrival < len(c.arrivals)-1 && c.arrivals[arrival].end < end {
			arrival++
		}
		at := int64(0)
		if arrival < len(c.arrivals) && c.arrivals[arrival].end >= end {
			at = c.arrivals[arrival].at
		} else if c.trace.LastDataAt != nil {
			at = c.trace.LastDataAt.Sub(c.trace.StartedAt).Milliseconds()
		}
		line := raw[offset:end]
		if strings.HasPrefix(line, "data:") {
			data := line[len("data:"):]
			if strings.TrimSpace(data) == "[DONE]" {
				c.trace.SawDone = true
			} else {
				c.inspectJSON(data)
			}
			line = "data:" + c.redactor.body(data, true)
		} else {
			line = c.redactor.text(line)
		}
		if captured+len(line) > providerTraceBodyLimit {
			c.trace.ResponseTruncated = true
			break
		}
		frames = append(frames, ProviderStreamChunk{Sequence: len(frames) + 1, AtMS: at, Data: line})
		captured += len(line)
		offset = end
	}
	return frames
}

func (c *providerTraceCapture) inspectJSON(raw string) {
	var result struct {
		Type      string          `json:"type"`
		Status    string          `json:"status"`
		Code      json.RawMessage `json:"code"`
		ErrorType string          `json:"error_type"`
		Message   string          `json:"message"`
		Error     *struct {
			Code    json.RawMessage `json:"code"`
			Type    string          `json:"type"`
			Message string          `json:"message"`
		} `json:"error"`
		Response          json.RawMessage `json:"response"`
		Usage             json.RawMessage `json:"usage"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal([]byte(raw), &result) == nil {
		if result.Status != "" {
			c.trace.ResponseStatus = result.Status
		}
		if result.Error != nil {
			c.trace.UpstreamErrorCode, c.trace.UpstreamErrorType, c.trace.UpstreamError = traceScalar(result.Error.Code), result.Error.Type, result.Error.Message
		} else if result.Type == "error" {
			c.trace.UpstreamErrorCode, c.trace.UpstreamErrorType, c.trace.UpstreamError = traceScalar(result.Code), result.ErrorType, result.Message
		}
		if result.IncompleteDetails != nil {
			c.trace.FinishReason = result.IncompleteDetails.Reason
		}
		if result.Type == "response.completed" {
			c.trace.SawCompleted = true
		}
		if len(result.Response) > 0 {
			c.inspectJSON(string(result.Response))
		}
		if c.trace.Usage == nil && len(result.Usage) > 0 {
			c.trace.Usage = traceUsage(result.Usage)
		}
		if len(result.Choices) > 0 && result.Choices[0].FinishReason != "" {
			c.trace.FinishReason = result.Choices[0].FinishReason
		}
	}
}

func traceScalar(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	if string(raw) == "null" {
		return ""
	}
	return string(raw)
}

func traceUsage(raw json.RawMessage) *Usage {
	var chat completionDelta
	var response responsesResult
	envelope := append(append([]byte(`{"usage":`), raw...), '}')
	if json.Unmarshal(envelope, &chat) != nil || chat.Usage == nil {
		return nil
	}
	if bytes.Contains(raw, []byte(`"input_tokens"`)) && json.Unmarshal(envelope, &response) == nil {
		return response.usage()
	}
	u := chat.Usage
	cached := u.PromptTokensDetails.CachedTokens
	if cached == nil {
		cached = u.PromptCacheHitTokens
	}
	return &Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens, CachedTokens: cached, ReasoningTokens: u.CompletionTokensDetails.ReasoningTokens}
}

type traceRedactor struct {
	secrets []string
	changed bool
}

var traceCredentialPattern = regexp.MustCompile(`(?i)(\b(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie)\b["']?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;\}\]&"']+)`)
var traceBearerPattern = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9_./+~=-]+`)
var traceDataPattern = regexp.MustCompile(`data:[A-Za-z0-9.+/-]+(?:;[^,\s"]*)?;base64,[A-Za-z0-9+/=_-]+`)
var traceBinaryJSONPattern = regexp.MustCompile(`(?is)("(?:b64_json|image_base64|image_data|encrypted_content|embedding|image_url)"\s*:\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|\[[^\]]*(?:\]|$))`)
var traceURLPattern = regexp.MustCompile(`https?://[^\s<>"']+`)

func newTraceRedactor(config Config, target *url.URL, headers http.Header) traceRedactor {
	r := traceRedactor{}
	r.addSecret(config.APIKey)
	for key, value := range config.Headers {
		// Arbitrary relay headers can carry credentials under nonstandard names.
		if !publicTraceHeader(key) {
			r.addSecret(value)
		}
	}
	r.headerSecrets(headers)
	if target.User != nil {
		r.addSecret(target.User.Username())
		password, _ := target.User.Password()
		r.addSecret(password)
	}
	for key, values := range target.Query() {
		if sensitiveTraceKey(key) {
			for _, value := range values {
				r.addSecret(value)
			}
		}
	}
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
	return r
}

func (r *traceRedactor) addSecret(value string) {
	if value == "" {
		return
	}
	values := []string{value, url.QueryEscape(value), url.PathEscape(value)}
	encoded, _ := json.Marshal(value)
	values = append(values, string(encoded[1:len(encoded)-1]))
	for _, candidate := range values {
		found := false
		for _, previous := range r.secrets {
			found = found || previous == candidate
		}
		if !found {
			r.secrets = append(r.secrets, candidate)
		}
	}
}

func (r *traceRedactor) headerSecrets(headers http.Header) {
	for key, values := range headers {
		if !sensitiveTraceKey(key) {
			continue
		}
		for _, value := range values {
			r.addSecret(value)
			if strings.EqualFold(key, "Cookie") || strings.EqualFold(key, "Set-Cookie") {
				for _, part := range strings.Split(value, ";") {
					if _, credential, found := strings.Cut(part, "="); found {
						r.addSecret(strings.Trim(strings.TrimSpace(credential), `"`))
					}
				}
			}
			if parts := strings.Fields(value); len(parts) == 2 {
				r.addSecret(parts[1])
				if strings.EqualFold(parts[0], "Basic") {
					if decoded, err := base64.StdEncoding.DecodeString(parts[1]); err == nil {
						user, password, _ := strings.Cut(string(decoded), ":")
						r.addSecret(user)
						r.addSecret(password)
					}
				}
			}
		}
	}
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
}

func publicTraceHeader(key string) bool {
	switch strings.ToLower(key) {
	case "accept", "content-type", "user-agent", "openai-organization", "openai-project", "anthropic-version", "openai-beta", "x-request-id":
		return true
	default:
		return false
	}
}

func sensitiveTraceKey(key string) bool {
	key = strings.ToLower(strings.NewReplacer("-", "", "_", "", ".", "", " ", "").Replace(key))
	return strings.Contains(key, "authorization") || strings.Contains(key, "apikey") || strings.Contains(key, "accesskey") || strings.Contains(key, "password") || strings.Contains(key, "passwd") || strings.Contains(key, "cookie") || strings.Contains(key, "secret") || strings.Contains(key, "credential") || strings.HasSuffix(key, "token") || strings.Contains(key, "signature") || key == "key" || key == "sig"
}

func (r *traceRedactor) headers(headers http.Header) http.Header {
	result := http.Header{}
	for key, values := range headers {
		for _, value := range values {
			if sensitiveTraceKey(key) {
				result.Add(key, "[REDACTED]")
				r.changed = true
			} else {
				result.Add(key, r.text(value))
			}
		}
	}
	return result
}

func (r *traceRedactor) url(target *url.URL) string {
	copy := *target
	if copy.User != nil {
		copy.User = nil
		r.changed = true
	}
	query := copy.Query()
	for key := range query {
		if sensitiveTraceKey(key) {
			query.Set(key, "[REDACTED]")
			r.changed = true
		}
	}
	copy.RawQuery = query.Encode()
	return r.text(copy.String())
}

func (r *traceRedactor) text(value string) string {
	before := value
	for _, secret := range r.secrets {
		value = strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	value = traceCredentialPattern.ReplaceAllString(value, "${1}[REDACTED]")
	value = traceBearerPattern.ReplaceAllString(value, "${1} [REDACTED]")
	value = traceDataPattern.ReplaceAllString(value, "[binary image omitted]")
	value = traceURLPattern.ReplaceAllStringFunc(value, func(raw string) string {
		target, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		changed := target.User != nil
		target.User = nil
		query := target.Query()
		for key := range query {
			if sensitiveTraceKey(key) {
				query.Set(key, "[REDACTED]")
				changed = true
			}
		}
		if !changed {
			return raw
		}
		target.RawQuery = query.Encode()
		return target.String()
	})
	if before != value {
		r.changed = true
	}
	return value
}

func (r *traceRedactor) body(raw string, sse bool) string {
	if sse && strings.TrimSpace(raw) == "[DONE]" {
		return raw
	}
	if json.Valid([]byte(raw)) {
		r.rememberBodySecrets(raw)
		var edits []traceJSONEdit
		r.jsonValue(raw, 0, &edits)
		var result strings.Builder
		previous := 0
		for _, edit := range edits {
			result.WriteString(raw[previous:edit.start])
			result.WriteString(edit.value)
			previous = edit.end
		}
		result.WriteString(raw[previous:])
		return result.String()
	}
	value := traceBinaryJSONPattern.ReplaceAllString(raw, `${1}"[binary payload omitted]"`)
	if value != raw {
		r.changed = true
	}
	return r.text(value)
}

func (r *traceRedactor) rememberBodySecrets(raw string) {
	if json.Valid([]byte(raw)) {
		r.jsonValue(raw, 0, nil)
		sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
	}
}

type traceJSONEdit struct {
	start, end int
	value      string
}

func traceJSONSpace(raw string, offset int) int {
	for offset < len(raw) && strings.ContainsRune(" \t\r\n", rune(raw[offset])) {
		offset++
	}
	return offset
}

func traceJSONStringEnd(raw string, offset int) int {
	for offset++; offset < len(raw); offset++ {
		if raw[offset] == '\\' {
			offset++
		} else if raw[offset] == '"' {
			return offset + 1
		}
	}
	return len(raw)
}

func traceJSONEnd(raw string, offset int) int {
	if raw[offset] == '"' {
		return traceJSONStringEnd(raw, offset)
	}
	if raw[offset] != '{' && raw[offset] != '[' {
		for offset < len(raw) && !strings.ContainsRune(",]} \t\n\r", rune(raw[offset])) {
			offset++
		}
		return offset
	}
	depth := 0
	for offset < len(raw) {
		switch raw[offset] {
		case '"':
			offset = traceJSONStringEnd(raw, offset)
			continue
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth == 0 {
				return offset + 1
			}
		}
		offset++
	}
	return offset
}

// Walk valid JSON without reserializing it: diagnostic SSE retains whitespace,
// field order, and line boundaries except for the values that must be removed.
func (r *traceRedactor) jsonValue(raw string, offset int, edits *[]traceJSONEdit) int {
	offset = traceJSONSpace(raw, offset)
	switch raw[offset] {
	case '{':
		offset = traceJSONSpace(raw, offset+1)
		for raw[offset] != '}' {
			keyEnd := traceJSONStringEnd(raw, offset)
			var key string
			_ = json.Unmarshal([]byte(raw[offset:keyEnd]), &key)
			if edits != nil {
				r.jsonString(raw, offset, keyEnd, edits)
			}
			offset = traceJSONSpace(raw, traceJSONSpace(raw, keyEnd)+1)
			if sensitiveTraceKey(key) || traceBinaryKey(key) {
				end := traceJSONEnd(raw, offset)
				if edits == nil {
					if sensitiveTraceKey(key) {
						r.rememberCredentialJSON(raw[offset:end])
					}
				} else {
					marker := `"[REDACTED]"`
					if traceBinaryKey(key) {
						marker = `"[binary payload omitted]"`
					}
					*edits = append(*edits, traceJSONEdit{start: offset, end: end, value: marker})
					r.changed = true
				}
				offset = end
			} else {
				offset = r.jsonValue(raw, offset, edits)
			}
			offset = traceJSONSpace(raw, offset)
			if raw[offset] == ',' {
				offset = traceJSONSpace(raw, offset+1)
			}
		}
		return offset + 1
	case '[':
		offset = traceJSONSpace(raw, offset+1)
		for raw[offset] != ']' {
			offset = traceJSONSpace(raw, r.jsonValue(raw, offset, edits))
			if raw[offset] == ',' {
				offset = traceJSONSpace(raw, offset+1)
			}
		}
		return offset + 1
	case '"':
		end := traceJSONStringEnd(raw, offset)
		if edits == nil {
			var decoded string
			_ = json.Unmarshal([]byte(raw[offset:end]), &decoded)
			trimmed := strings.TrimSpace(decoded)
			if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') && json.Valid([]byte(decoded)) {
				r.jsonValue(decoded, 0, nil)
			} else {
				r.rememberURLSecrets(decoded)
			}
		} else {
			r.jsonString(raw, offset, end, edits)
		}
		return end
	default:
		return traceJSONEnd(raw, offset)
	}
}

func (r *traceRedactor) rememberCredentialJSON(raw string) {
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return
	}
	var remember func(any)
	remember = func(value any) {
		switch value := value.(type) {
		case string:
			if value != "[REDACTED]" {
				r.addSecret(value)
			}
		case []any:
			for _, child := range value {
				remember(child)
			}
		case map[string]any:
			for _, child := range value {
				remember(child)
			}
		}
	}
	remember(value)
}

func (r *traceRedactor) rememberURLSecrets(value string) {
	for _, raw := range traceURLPattern.FindAllString(value, -1) {
		target, err := url.Parse(raw)
		if err != nil {
			continue
		}
		if target.User != nil {
			r.addSecret(target.User.Username())
			password, _ := target.User.Password()
			r.addSecret(password)
		}
		for key, values := range target.Query() {
			if sensitiveTraceKey(key) {
				for _, credential := range values {
					if credential != "[REDACTED]" {
						r.addSecret(credential)
					}
				}
			}
		}
	}
}

func traceBinaryKey(key string) bool {
	switch strings.ToLower(key) {
	case "b64_json", "image_base64", "image_data", "image_url", "encrypted_content", "embedding":
		return true
	default:
		return false
	}
}

func (r *traceRedactor) jsonString(raw string, start, end int, edits *[]traceJSONEdit) {
	var decoded string
	_ = json.Unmarshal([]byte(raw[start:end]), &decoded)
	clean := decoded
	trimmed := strings.TrimSpace(decoded)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') && json.Valid([]byte(decoded)) {
		clean = r.body(decoded, false)
	} else {
		clean = r.text(clean)
	}
	if clean != decoded {
		encoded, _ := json.Marshal(clean)
		*edits = append(*edits, traceJSONEdit{start: start, end: end, value: string(encoded)})
	}
}
