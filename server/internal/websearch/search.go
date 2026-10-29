package websearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"ochi/server/internal/i18n"
	"ochi/server/internal/product"
)

type Config struct {
	Enabled        bool   `json:"enabled"`
	Provider       string `json:"provider"`
	BaseURL        string `json:"base_url"`
	APIKey         string `json:"-"`
	MaxResults     int    `json:"max_results"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

type Result struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	PublishedAt string `json:"published_at,omitempty"`
}

type Response struct {
	Query    string   `json:"query"`
	Provider string   `json:"provider"`
	Count    int      `json:"count"`
	Results  []Result `json:"results"`
}

func Defaults() Config {
	return Config{Provider: "exa", BaseURL: DefaultBaseURL("exa"), MaxResults: 6, TimeoutSeconds: 20}
}

func DefaultBaseURL(provider string) string {
	switch provider {
	case "exa":
		return "https://api.exa.ai"
	case "brave":
		return "https://api.search.brave.com/res/v1"
	default:
		return ""
	}
}

func Validate(c Config) error {
	if c.Provider != "exa" && c.Provider != "brave" && c.Provider != "searxng" {
		return i18n.New("search_provider_invalid")
	}
	if c.MaxResults < 1 || c.MaxResults > 20 {
		return i18n.New("search_result_limit_invalid")
	}
	if c.TimeoutSeconds < 3 || c.TimeoutSeconds > 60 {
		return i18n.New("search_timeout_invalid")
	}
	if c.BaseURL != "" {
		u, err := url.Parse(c.BaseURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || !validPort(u) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return i18n.New("search_url_invalid")
		}
	}
	if c.Enabled && c.BaseURL == "" {
		return i18n.New("search_url_required")
	}
	if c.Enabled && c.Provider != "searxng" && strings.TrimSpace(c.APIKey) == "" {
		return i18n.New("search_api_key_unconfigured")
	}
	if strings.ContainsAny(c.APIKey, "\r\n") || len(c.APIKey) > 4096 {
		return i18n.New("search_api_key_invalid")
	}
	return nil
}

// Search makes one provider request per query; it never opens the result pages.
// The returned contract contains only public source data, not provider diagnostics.
func Search(ctx context.Context, c Config, query string, limit int) (Response, error) {
	query = strings.TrimSpace(query)
	response := Response{Query: query, Provider: c.Provider, Results: []Result{}}
	if err := Validate(c); err != nil {
		return response, err
	}
	if !c.Enabled {
		return response, i18n.New("search_disabled")
	}
	if query == "" || utf8.RuneCountInString(query) > 600 || len(strings.Fields(query)) > 75 {
		return response, i18n.New("search_query_invalid")
	}
	if limit < 0 {
		return response, i18n.New("search_result_count_invalid")
	}
	if limit == 0 || limit > c.MaxResults {
		limit = c.MaxResults
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeoutSeconds)*time.Second)
	defer cancel()
	base := strings.TrimRight(c.BaseURL, "/")
	var req *http.Request
	var err error
	switch c.Provider {
	case "exa":
		body, _ := json.Marshal(map[string]any{"query": query, "numResults": limit, "type": "auto", "contents": map[string]bool{"highlights": true}})
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, base+"/search", bytes.NewReader(body))
	case "brave", "searxng":
		params := url.Values{"q": {query}}
		path := "/web/search"
		if c.Provider == "brave" {
			params.Set("count", fmt.Sprint(limit))
		} else {
			path = "/search"
			params.Set("format", "json")
			params.Set("categories", "general")
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, base+path+"?"+params.Encode(), nil)
	}
	if err != nil {
		return response, i18n.New("search_url_invalid")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", product.UserAgent())
	switch c.Provider {
	case "exa":
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", c.APIKey)
	case "brave":
		req.Header.Set("X-Subscription-Token", c.APIKey)
	case "searxng":
		if c.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.APIKey)
		}
	}
	// Do not forward API keys to an upstream redirect, even on the same host.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return response, i18n.New("search_timeout")
			}
			return response, ctx.Err()
		}
		return response, i18n.New("search_connection_failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		switch res.StatusCode {
		case 401, 403:
			return response, i18n.New("search_authentication_failed")
		case 402:
			return response, i18n.New("search_quota_exhausted")
		case 429:
			return response, i18n.New("search_rate_limited")
		default:
			return response, i18n.With("search_http_error", map[string]any{"status": res.StatusCode})
		}
	}
	const maxBody = 2 << 20
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		return response, i18n.New("search_response_too_large")
	}
	results, err := decode(c.Provider, body)
	if err != nil {
		return response, i18n.New("search_response_invalid")
	}
	seen := make(map[string]bool)
	for _, item := range results {
		address := publicURL(item.URL)
		if address == "" || seen[address] {
			continue
		}
		seen[address] = true
		item.URL = address
		item.Title = plainText(item.Title, 240)
		if item.Title == "" {
			u, _ := url.Parse(address)
			item.Title = u.Hostname()
		}
		item.Description = plainText(item.Description, 1600)
		item.PublishedAt = plainText(item.PublishedAt, 64)
		response.Results = append(response.Results, item)
		if len(response.Results) == limit {
			break
		}
	}
	response.Count = len(response.Results)
	return response, nil
}

func decode(provider string, body []byte) ([]Result, error) {
	var payload struct {
		Error   json.RawMessage `json:"error"`
		Results json.RawMessage `json:"results"`
		Web     *struct {
			Results json.RawMessage `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if len(payload.Error) > 0 && string(payload.Error) != "null" {
		return nil, errors.New("provider returned an error")
	}
	items := payload.Results
	if provider == "brave" {
		// Brave can omit the web section when a query has no web results.
		if payload.Web == nil {
			return []Result{}, nil
		}
		items = payload.Web.Results
	}
	if items == nil || string(items) == "null" {
		return nil, errors.New("missing results")
	}
	var raw []struct {
		Title         string   `json:"title"`
		URL           string   `json:"url"`
		Description   string   `json:"description"`
		Content       string   `json:"content"`
		Highlights    []string `json:"highlights"`
		Summary       string   `json:"summary"`
		PublishedDate string   `json:"publishedDate"`
		Age           string   `json:"age"`
	}
	if err := json.Unmarshal(items, &raw); err != nil {
		return nil, err
	}
	results := make([]Result, 0, len(raw))
	for _, item := range raw {
		snippet := item.Description
		if provider == "exa" {
			snippet = strings.Join(item.Highlights, " ")
			if snippet == "" {
				snippet = item.Summary
			}
		} else if provider == "searxng" {
			snippet = item.Content
		}
		published := item.PublishedDate
		if published == "" && provider == "brave" {
			published = item.Age
		}
		results = append(results, Result{Title: item.Title, URL: item.URL, Description: snippet, PublishedAt: published})
	}
	return results, nil
}

var htmlTags = regexp.MustCompile(`<[^>]*>`)

func plainText(text string, limit int) string {
	text = strings.Join(strings.Fields(html.UnescapeString(htmlTags.ReplaceAllString(text, " "))), " ")
	if utf8.RuneCountInString(text) > limit {
		return string([]rune(text)[:limit]) + "..."
	}
	return text
}

func publicURL(address string) string {
	if len(address) > 4096 {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(address))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || !validPort(u) || u.User != nil {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
			return ""
		}
	} else {
		// Browsers normalize abbreviated/decimal/hex IPv4 hosts differently from
		// Go. Only named public domains or canonical IP literals become links.
		labels := strings.Split(host, ".")
		if len(labels) < 2 || labels[len(labels)-1] == "" || !strings.ContainsAny(labels[len(labels)-1], "abcdefghijklmnopqrstuvwxyz") {
			return ""
		}
	}
	return u.String()
}

func validPort(u *url.URL) bool {
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		return err == nil && value > 0 && value <= 65535
	}
	return !strings.HasSuffix(u.Host, ":")
}
