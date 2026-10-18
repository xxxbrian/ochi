package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Diagnostic deliberately excludes request bodies, tool output and credentials.
type Diagnostic struct {
	Kind       string         `json:"kind"`
	Class      string         `json:"class"`
	Code       string         `json:"code,omitempty"`
	ToolIndex  *int           `json:"tool_index,omitempty"`
	Attempt    int            `json:"attempt,omitempty"`
	StatusCode int            `json:"status_code,omitempty"`
	Message    string         `json:"message,omitempty"`
	Budget     *ContextBudget `json:"budget,omitempty"`
}

type ModelError struct {
	Class      string
	Code       string
	ToolIndex  *int
	StatusCode int
	RetryAfter time.Duration
	retryable  bool
	committed  bool
	cause      error
}

func (e *ModelError) Error() string {
	message := map[string]string{
		"authentication": "model authentication failed; check provider credentials",
		"permission":     "model access was denied; check provider permissions",
		"configuration":  "model request or provider configuration is invalid",
		"billing":        "model provider usage or credit limit was reached",
		"rate_limit":     "model provider rate limit was reached",
		"unavailable":    "model provider is temporarily unavailable",
		"timeout":        "model request timed out",
		"connection":     "model provider connection failed",
		"context":        "model context window was exceeded",
		"stream":         "model stream ended before completion",
		"invalid_stream": "model returned an invalid stream",
		"tool_protocol":  "model returned an invalid tool call",
		"output_limit":   "model response ended with an output limit",
		"content_filter": "model response was stopped by the provider content filter",
	}[e.Class]
	if message == "" {
		message = "model request failed"
	}
	if e.StatusCode > 0 {
		message += fmt.Sprintf(" (HTTP %d)", e.StatusCode)
	}
	return message
}

func (e *ModelError) Unwrap() error { return e.cause }

func providerError(status int, data []byte, retryAfter string) *ModelError {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &envelope)
	return classifyProviderError(status, envelope.Error.Code+" "+envelope.Error.Type, envelope.Error.Message, retryAfter)
}

func classifyProviderError(status int, code, message, retryAfter string) *ModelError {
	e := &ModelError{StatusCode: status, RetryAfter: parseRetryAfter(retryAfter, time.Now()), Class: "configuration"}
	code, message = strings.ToLower(code), strings.ToLower(message)
	switch {
	case strings.Contains(code, "context_length_exceeded") || strings.Contains(code, "context_window_exceeded") ||
		((status == 400 || status == 413 || status == 0) && (strings.Contains(message, "maximum context length") || strings.Contains(message, "context window") || strings.Contains(message, "too many tokens"))):
		e.Class = "context"
	case strings.Contains(code, "insufficient_quota") || strings.Contains(code, "credit_balance_exhausted") || strings.Contains(code, "spend_limit_exceeded") || strings.Contains(code, "usage_limit_exceeded"):
		e.Class = "billing"
	case status == 401 || strings.Contains(code, "authentication_error"):
		e.Class = "authentication"
	case status == 403 || strings.Contains(code, "permission_denied"):
		e.Class = "permission"
	case status == 429 || strings.Contains(code, "rate_limit_exceeded"):
		e.Class, e.retryable = "rate_limit", true
	case status == 408 || strings.Contains(code, "request_timeout"):
		e.Class, e.retryable = "timeout", true
	case status == 500 || status == 502 || status == 503 || status == 504 || strings.Contains(code, "server_error") || strings.Contains(code, "server_overloaded") || strings.Contains(code, "internal_error"):
		e.Class, e.retryable = "unavailable", true
	}
	return e
}

func connectionError(err error) error {
	if errors.Is(err, context.Canceled) {
		return err
	}
	var verify *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var invalid x509.HostnameError
	if errors.As(err, &verify) || errors.As(err, &unknown) || errors.As(err, &invalid) {
		return &ModelError{Class: "configuration", cause: err}
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return &ModelError{Class: "timeout", retryable: true, cause: err}
	}
	return &ModelError{Class: "connection", retryable: true, cause: err}
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	if seconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && seconds > 0 {
		if seconds > 86400 {
			return 24 * time.Hour
		}
		return time.Duration(seconds * float64(time.Second))
	}
	if date, err := http.ParseTime(value); err == nil && date.After(now) {
		return date.Sub(now)
	}
	return 0
}

const maxModelAttempts = 3

func retryDelay(err error, attempt int) (time.Duration, bool) {
	var model *ModelError
	if attempt >= maxModelAttempts || !errors.As(err, &model) || !model.retryable {
		return 0, false
	}
	// A long server delay is terminal for this run, never shortened or ignored.
	if model.RetryAfter > 30*time.Second {
		return 0, false
	}
	base := time.Duration(1<<(attempt-1)) * 500 * time.Millisecond
	delay := base + time.Duration(rand.Int64N(int64(base/2)+1))
	if delay < model.RetryAfter {
		delay = model.RetryAfter
	}
	return delay, true
}

func waitRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (g *OpenAI) observe(d Diagnostic) {
	if g.config.Observe != nil {
		g.config.Observe(d)
	}
}

func (g *OpenAI) observeModelError(kind string, attempt int, err error) {
	var model *ModelError
	if errors.As(err, &model) {
		g.observe(Diagnostic{Kind: kind, Class: model.Class, Code: model.Code, ToolIndex: model.ToolIndex, Attempt: attempt, StatusCode: model.StatusCode, Message: model.Error()})
	}
}

// Only model inference is retried. Tool calls and streamed client output are
// outside this seam, so a recovery never re-executes an external side effect.
func (g *OpenAI) doRetry(ctx context.Context, body any) (*http.Response, error) {
	return g.retryRequest(ctx, func(attemptCtx context.Context) (*http.Response, error) { return g.do(attemptCtx, body) })
}

func (g *OpenAI) retryRequest(ctx context.Context, request func(context.Context) (*http.Response, error)) (*http.Response, error) {
	for attempt := 1; ; attempt++ {
		response, err := request(withProviderTraceAttempt(ctx, "", attempt))
		if err == nil {
			return response, nil
		}
		delay, retry := retryDelay(err, attempt)
		if !retry {
			g.observeModelError("request_failed", attempt, err)
			return nil, err
		}
		g.observeModelError("request_retry", attempt, err)
		if err := waitRetry(ctx, delay); err != nil {
			return nil, err
		}
	}
}

func interruptedStream(err error) error {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return &ModelError{Class: "stream", retryable: true, cause: err}
	}
	return connectionError(err)
}
