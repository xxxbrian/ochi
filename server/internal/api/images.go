package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

var imageToolDefinition = agent.ToolDefinition{
	Name:        "generate_image",
	Description: "Generate a new image, or edit supplied reference images, using the administrator's configured image model. This works without computer permission. Use for user-requested image creation or editing, not ordinary questions, charts made from data, or HTML/SVG code. Provide image_ids only for authenticated uploaded or prior generated image IDs, never external URLs. The result is automatically displayed in this conversation (delivered:true); do not publish or generate it again just to show it. Omit size and quality unless requested. A failed request is not automatically retried; do not repeat an ambiguously billed failure without the user's agreement.",
	Parameters:  json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string","description":"Complete description of the desired image or requested edits"},"size":{"type":"string","description":"Optional WIDTHxHEIGHT or auto; omit to use the configured default"},"quality":{"type":"string","enum":["auto","low","medium","high","xhigh","max","standard","hd"]},"image_ids":{"type":"array","items":{"type":"string"},"maxItems":8,"description":"Reference image file IDs. Omit to generate from text."}},"required":["prompt"],"additionalProperties":false}`),
}

func (s *Server) publishedImageModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.ImageModels(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	for i := range models {
		models[i].EffortMapping = nil
		models[i].LastTest = nil
	}
	writeJSON(w, http.StatusOK, models)
}

func (s *Server) selectedImageModel(ctx context.Context) (storage.Model, storage.Provider, error) {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return storage.Model{}, storage.Provider{}, err
	}
	var model storage.Model
	if settings.ImageModelID != "" {
		model, err = s.store.Model(ctx, settings.ImageModelID)
	} else {
		var models []storage.Model
		models, err = s.store.ImageModels(ctx)
		if err == nil && len(models) == 0 {
			err = errors.New("尚未配置可用的生图模型")
		}
		if err == nil {
			model = models[0]
		}
	}
	if err != nil {
		return model, storage.Provider{}, err
	}
	if model.Kind != "image" || !model.Enabled || !model.Available || !model.SupportsImageGeneration {
		return model, storage.Provider{}, errors.New("生图模型未启用或不可用")
	}
	provider, err := s.store.Provider(ctx, model.ProviderID)
	if err != nil || !provider.Enabled {
		return model, provider, errors.New("生图服务未启用或不可用")
	}
	return model, provider, nil
}

func imageOptions(model storage.Model) agent.ImageOptions {
	return agent.ImageOptions{Size: model.ImageConfig.Size, Quality: model.ImageConfig.Quality, OutputFormat: model.ImageConfig.OutputFormat, Background: model.ImageConfig.Background}
}

func (s *Server) generateImageTool(ctx context.Context, scope agent.RunScope, args json.RawMessage) (agent.ToolResult, error) {
	if scope.UserID == "" || scope.SessionID == "" || scope.RunID == "" {
		return agent.ToolResult{}, errors.New("missing image generation run scope")
	}
	var input struct {
		Prompt   string   `json:"prompt"`
		Size     string   `json:"size"`
		Quality  string   `json:"quality"`
		ImageIDs []string `json:"image_ids"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return agent.ToolResult{}, errors.New("图片生成参数无效")
	}
	model, provider, err := s.selectedImageModel(ctx)
	if err != nil {
		return agent.ToolResult{}, err
	}
	options := imageOptions(model)
	options.Prompt = strings.TrimSpace(input.Prompt)
	if input.Size != "" {
		options.Size = input.Size
	}
	if input.Quality != "" {
		options.Quality = input.Quality
	}
	if len(input.ImageIDs) > 0 {
		if len(input.ImageIDs) > 8 {
			return agent.ToolResult{}, errors.New("参考图片最多为 8 张")
		}
		if model.ImageConfig.SupportsEdit != nil && !*model.ImageConfig.SupportsEdit {
			return agent.ToolResult{}, errors.New("当前生图模型不支持图片编辑")
		}
		items, err := s.store.GetArtifacts(ctx, scope.UserID, input.ImageIDs)
		if err != nil {
			return agent.ToolResult{}, errors.New("参考图片不存在或不可访问")
		}
		for _, file := range items {
			if !strings.HasPrefix(file.MIMEType, "image/") || file.Size > 32<<20 {
				return agent.ToolResult{}, errors.New("参考文件需要是 32 MB 以内的图片")
			}
			data, err := artifactBytes(file)
			if err != nil {
				return agent.ToolResult{}, errors.New("无法读取参考图片")
			}
			options.Images = append(options.Images, agent.ImageInput{Name: file.Name, MIMEType: file.MIMEType, Data: data})
		}
	}
	config := s.modelConfig(ctx, model, provider, "", storage.Settings{})
	generated, err := agent.GenerateImage(ctx, *config, options)
	if err != nil {
		return agent.ToolResult{}, errors.New(storage.SanitizeProviderError(provider, err))
	}
	// The provider has already charged for these bytes. Persist delivery even if
	// the user closes the client or stops immediately as generation completes.
	save, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	file, err := s.saveGeneratedImage(save, scope, model, options, generated)
	if err != nil {
		return agent.ToolResult{}, errors.New("图片已生成，但保存失败；请勿重新生成")
	}
	if run, ok := s.runtime.Get(scope.RunID); ok {
		if items, err := s.store.ListRunArtifacts(save, scope.UserID, scope.RunID); err == nil {
			run.SetArtifacts(items)
			run.AddUsage(generated.Usage)
			_ = s.store.Checkpoint(save, run.Snapshot())
		}
	}
	body, err := json.Marshal(map[string]any{"delivered": true, "artifact": file.Attachment(), "url": file.URL, "generation": file.Generation})
	return agent.ToolResult{Output: string(body)}, err
}

func (s *Server) saveGeneratedImage(ctx context.Context, scope agent.RunScope, model storage.Model, options agent.ImageOptions, image agent.GeneratedImage) (storage.Artifact, error) {
	id, err := newID()
	if err != nil {
		return storage.Artifact{}, err
	}
	name := "image-" + id[:8] + "." + image.Extension
	path := "/data/published/" + id + "/" + name
	key, err := storeArtifactBytes(scope.UserID, path, image.Data)
	if err != nil {
		return storage.Artifact{}, err
	}
	size, quality := options.Size, options.Quality
	if image.Size != "" {
		size = image.Size
	} else if image.Width > 0 && image.Height > 0 {
		size = fmt.Sprintf("%dx%d", image.Width, image.Height)
	}
	if image.Quality != "" {
		quality = image.Quality
	}
	generation := &agent.ImageGeneration{Prompt: options.Prompt, RevisedPrompt: image.RevisedPrompt, ModelID: model.ID, ModelName: model.Name, Size: size, Quality: quality, OutputFormat: image.Extension, Width: image.Width, Height: image.Height}
	return s.store.SaveArtifact(ctx, storage.Artifact{UserID: scope.UserID, SessionID: scope.SessionID, RunID: scope.RunID, Name: name, Path: path, SourcePath: path, MIMEType: image.MIMEType, Size: int64(len(image.Data)), StorageKey: key, Generation: generation})
}
