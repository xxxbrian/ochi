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
		return errors.New("请选择 Exa、Brave 或 SearXNG")
	}
	if c.MaxResults < 1 || c.MaxResults > 20 {
		return errors.New("搜索结果上限须为 1 至 20")
	}
	if c.TimeoutSeconds < 3 || c.TimeoutSeconds > 60 {
		return errors.New("搜索超时须为 3 至 60 秒")
	}
	if c.BaseURL != "" {
		u, err := url.Parse(c.BaseURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || !validPort(u) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("搜索服务地址须为 HTTP(S) 地址，不能包含账号、查询参数或片段")
		}
	}
	if c.Enabled && c.BaseURL == "" {
		return errors.New("请填写搜索服务地址")
	}
	if c.Enabled && c.Provider != "searxng" && strings.TrimSpace(c.APIKey) == "" {
		return errors.New("请配置搜索服务的 API 密钥")
	}
	if strings.ContainsAny(c.APIKey, "\r\n") || len(c.APIKey) > 4096 {
		return errors.New("搜索 API 密钥无效")
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
		return response, errors.New("网页搜索尚未启用")
	}
	if query == "" || utf8.RuneCountInString(query) > 600 || len(strings.Fields(query)) > 75 {
		return response, errors.New("搜索词须为 1 至 600 字符，且不超过 75 个词")
	}
	if limit < 0 {
		return response, errors.New("搜索结果数量无效")
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
		return response, errors.New("搜索服务地址无效")
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
				return response, errors.New("搜索响应超时，请重试")
			}
			return response, ctx.Err()
		}
		return response, errors.New("暂时无法连接搜索服务")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		switch res.StatusCode {
		case 401, 403:
			return response, errors.New("搜索服务鉴权失败，请检查配置")
		case 402:
			return response, errors.New("搜索服务额度不足")
		case 429:
			return response, errors.New("搜索服务请求过于频繁，请稍后重试")
		default:
			return response, fmt.Errorf("搜索服务暂时不可用（HTTP %d）", res.StatusCode)
		}
	}
	const maxBody = 2 << 20
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		return response, errors.New("搜索结果过大或未完整接收")
	}
	results, err := decode(c.Provider, body)
	if err != nil {
		return response, errors.New("搜索服务返回了无效的结果")
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
