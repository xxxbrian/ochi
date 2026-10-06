package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"ochi/server/internal/product"
)

const maxGeneratedImageBytes = 50 << 20

type ImageOptions struct {
	Prompt       string
	Size         string
	Quality      string
	OutputFormat string
	Background   string
	Images       []ImageInput
}

type ImageInput struct {
	Name     string
	MIMEType string
	Data     []byte
}

type GeneratedImage struct {
	Data          []byte
	MIMEType      string
	Extension     string
	Width         int
	Height        int
	RevisedPrompt string
	Size          string
	Quality       string
	Usage         Usage
}

var imageSizePattern = regexp.MustCompile(`^([1-9][0-9]{1,4})x([1-9][0-9]{1,4})$`)

func ValidateImageOptions(options ImageOptions) error {
	if options.Size != "" && options.Size != "auto" {
		parts := imageSizePattern.FindStringSubmatch(options.Size)
		if len(parts) != 3 {
			return errors.New("图片尺寸应为 auto 或 宽x高，例如 1024x1024")
		}
		w, _ := strconv.Atoi(parts[1])
		h, _ := strconv.Atoi(parts[2])
		if w > 8192 || h > 8192 || w*h > 32*1024*1024 {
			return errors.New("图片尺寸过大")
		}
	}
	if !slices.Contains([]string{"", "auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"}, options.Quality) {
		return errors.New("图片质量选项无效")
	}
	if !slices.Contains([]string{"", "png", "jpeg", "webp"}, options.OutputFormat) {
		return errors.New("图片格式应为 png、jpeg 或 webp")
	}
	if !slices.Contains([]string{"", "auto", "opaque", "transparent"}, options.Background) {
		return errors.New("图片背景选项无效")
	}
	if options.OutputFormat == "jpeg" && options.Background == "transparent" {
		return errors.New("透明背景需要 png 或 webp 格式")
	}
	return nil
}

func imageModelID(name string) string {
	parts := strings.Split(strings.ToLower(name), "/")
	return parts[len(parts)-1]
}

func validateImageModelOptions(model string, options ImageOptions) error {
	if err := ValidateImageOptions(options); err != nil {
		return err
	}
	id := imageModelID(model)
	if id == "gpt-image-2" {
		if options.Quality == "xhigh" || options.Quality == "max" || options.Quality == "standard" || options.Quality == "hd" {
			return errors.New("gpt-image-2 的图片质量支持 low、medium、high 或 auto")
		}
		if parts := imageSizePattern.FindStringSubmatch(options.Size); len(parts) == 3 {
			w, _ := strconv.Atoi(parts[1])
			h, _ := strconv.Atoi(parts[2])
			if w%16 != 0 || h%16 != 0 || w > 3840 || h > 3840 || w > h*3 || h > w*3 || w*h < 655360 || w*h > 8294400 {
				return errors.New("gpt-image-2 尺寸需为 16 的倍数、最长边不超过 3840、比例不超过 3:1，总像素为 655360–8294400")
			}
		}
	}
	if strings.HasPrefix(id, "dall-e-") {
		if options.OutputFormat != "" && options.OutputFormat != "png" || options.Background != "" && options.Background != "auto" && options.Background != "opaque" {
			return errors.New("DALL-E 不支持自定义输出格式或透明背景")
		}
		if id == "dall-e-3" && len(options.Images) > 0 {
			return errors.New("DALL-E 3 不支持参考图片编辑")
		}
	}
	return nil
}

// Dedicated native Images API requests work independently from the selected
// chat model and never require a Docker workspace or computer permission.
func GenerateImage(ctx context.Context, config Config, options ImageOptions) (GeneratedImage, error) {
	if config.BaseURL == "" || config.Model == "" || config.APIKey == "" && !config.AllowNoKey {
		return GeneratedImage{}, errors.New("请先配置可用的生图服务")
	}
	options.Prompt = strings.TrimSpace(options.Prompt)
	if options.Prompt == "" || len([]rune(options.Prompt)) > 32000 {
		return GeneratedImage{}, errors.New("请提供有效的图片描述")
	}
	if err := validateImageModelOptions(config.Model, options); err != nil {
		return GeneratedImage{}, err
	}
	fields := map[string]string{"model": config.Model, "prompt": options.Prompt}
	for key, value := range map[string]string{"size": options.Size, "quality": options.Quality, "output_format": options.OutputFormat, "background": options.Background} {
		if value != "" {
			fields[key] = value
		}
	}
	dalle := strings.HasPrefix(imageModelID(config.Model), "dall-e-")
	if dalle {
		fields["response_format"] = "b64_json"
		delete(fields, "output_format")
		delete(fields, "background")
	}
	var body bytes.Buffer
	contentType, endpoint := "application/json", "/images/generations"
	if len(options.Images) == 0 {
		payload := map[string]any{"n": 1}
		for key, value := range fields {
			payload[key] = value
		}
		if err := json.NewEncoder(&body).Encode(payload); err != nil {
			return GeneratedImage{}, err
		}
	} else {
		if len(options.Images) > 8 {
			return GeneratedImage{}, errors.New("参考图片最多为 8 张")
		}
		endpoint = "/images/edits"
		writer := multipart.NewWriter(&body)
		for key, value := range fields {
			if err := writer.WriteField(key, value); err != nil {
				return GeneratedImage{}, err
			}
		}
		if err := writer.WriteField("n", "1"); err != nil {
			return GeneratedImage{}, err
		}
		for index, input := range options.Images {
			mime, ext, _, _, err := generatedImageType(input.Data)
			if err != nil || len(input.Data) > 32<<20 {
				return GeneratedImage{}, errors.New("参考图片需为有效的 PNG、JPEG 或 WebP，且不超过 32 MB")
			}
			field := "image[]"
			if dalle {
				field = "image"
			}
			header := textproto.MIMEHeader{}
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="reference-%d.%s"`, field, index+1, ext))
			header.Set("Content-Type", mime)
			part, err := writer.CreatePart(header)
			if err != nil {
				return GeneratedImage{}, err
			}
			if _, err = part.Write(input.Data); err != nil {
				return GeneratedImage{}, err
			}
		}
		if err := writer.Close(); err != nil {
			return GeneratedImage{}, err
		}
		contentType = writer.FormDataContentType()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.BaseURL, "/")+endpoint, &body)
	if err != nil {
		return GeneratedImage{}, errors.New("生图服务地址无效")
	}
	req.Header.Set("User-Agent", product.UserAgent())
	for key, value := range config.Headers {
		req.Header.Set(key, value)
	}
	if config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	client := providerClient(config)
	// Never replay an ambiguously billed image request on timeout/server failure.
	resp, err := client.Do(req)
	if err != nil {
		return GeneratedImage{}, errors.New("生图服务连接中断，未自动重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&failure)
		return GeneratedImage{}, fmt.Errorf("生图服务返回 HTTP %d: %.1000s", resp.StatusCode, failure.Error.Message)
	}
	var response struct {
		Data []struct {
			Base64        string `json:"b64_json"`
			URL           string `json:"url"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
		Size    string `json:"size"`
		Quality string `json:"quality"`
		Usage   struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
			TotalTokens  int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxGeneratedImageBytes*4/3+1048576)).Decode(&response); err != nil || len(response.Data) == 0 {
		return GeneratedImage{}, errors.New("生图服务未返回有效图片")
	}
	result := response.Data[0]
	var data []byte
	if result.Base64 != "" {
		if base64.StdEncoding.DecodedLen(len(result.Base64)) > maxGeneratedImageBytes {
			return GeneratedImage{}, errors.New("生成的图片超过 50 MB")
		}
		data, err = base64.StdEncoding.DecodeString(result.Base64)
	} else if result.URL != "" {
		data, err = downloadGeneratedImage(ctx, client, result.URL)
	} else {
		err = errors.New("生图服务未返回图片内容")
	}
	if err != nil {
		return GeneratedImage{}, errors.New("生成图片下载失败，未重新生成")
	}
	mime, ext, width, height, err := generatedImageType(data)
	if err != nil {
		return GeneratedImage{}, err
	}
	return GeneratedImage{Data: data, MIMEType: mime, Extension: ext, Width: width, Height: height, RevisedPrompt: result.RevisedPrompt, Size: response.Size, Quality: response.Quality,
		Usage: Usage{PromptTokens: response.Usage.InputTokens, CompletionTokens: response.Usage.OutputTokens, TotalTokens: response.Usage.TotalTokens}}, nil
}

func downloadGeneratedImage(ctx context.Context, client *http.Client, location string) ([]byte, error) {
	u, err := url.Parse(location)
	if err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" {
		return nil, errors.New("invalid image download URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", product.UserAgent())
	// The image host receives no provider key or custom authentication headers.
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("image download failed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxGeneratedImageBytes+1))
	if len(data) > maxGeneratedImageBytes {
		return nil, errors.New("image too large")
	}
	return data, err
}

func generatedImageType(data []byte) (mime, extension string, width, height int, err error) {
	if len(data) == 0 || len(data) > maxGeneratedImageBytes {
		return "", "", 0, 0, errors.New("生成的图片内容无效")
	}
	if len(data) >= 30 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		switch string(data[12:16]) {
		case "VP8X":
			width = 1 + int(data[24]) + int(data[25])<<8 + int(data[26])<<16
			height = 1 + int(data[27]) + int(data[28])<<8 + int(data[29])<<16
		case "VP8 ":
			if string(data[23:26]) == "\x9d\x01\x2a" {
				width = int(binary.LittleEndian.Uint16(data[26:28]) & 0x3fff)
				height = int(binary.LittleEndian.Uint16(data[28:30]) & 0x3fff)
			}
		case "VP8L":
			if data[20] == 0x2f {
				bits := binary.LittleEndian.Uint32(data[21:25])
				width, height = int(bits&0x3fff)+1, int(bits>>14&0x3fff)+1
			}
		}
		if width > 0 && height > 0 {
			return "image/webp", "webp", width, height, nil
		}
	}
	config, format, decodeErr := image.DecodeConfig(bytes.NewReader(data))
	if decodeErr == nil && (format == "png" || format == "jpeg") {
		return "image/" + format, format, config.Width, config.Height, nil
	}
	return "", "", 0, 0, errors.New("生图服务返回的内容不是有效的 PNG、JPEG 或 WebP 图片")
}
