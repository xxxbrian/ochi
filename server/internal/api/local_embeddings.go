package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

const localEmbeddingModelID = storage.LocalMemoryEmbeddingModelID

// The Chinese bge-small model emits 512 dimensions; the English variant emits 384.
const localEmbeddingDimensions = 512

func embeddingIdentity(modelID string) string {
	if modelID == "" {
		return localEmbeddingModelID
	}
	return modelID
}

func (s *Server) embeddingVectors(ctx context.Context, modelID string, texts []string) ([][]float32, string, error) {
	vectors, target, err := s.embeddingVectorsTarget(ctx, modelID, texts)
	return vectors, target.ModelID, err
}

func (s *Server) embeddingVectorsTarget(ctx context.Context, modelID string, texts []string) ([][]float32, storage.MemoryEmbeddingTarget, error) {
	identity := embeddingIdentity(modelID)
	target, err := s.store.MemoryEmbeddingTarget(ctx)
	if err != nil {
		return nil, target, err
	}
	if target.ModelID != identity {
		return nil, target, storage.ErrMemoryChanged
	}
	if len(texts) == 0 {
		return [][]float32{}, target, nil
	}
	if len(texts) > 40 {
		return nil, target, errors.New("embedding batch exceeds 40 inputs")
	}
	if modelID != "" {
		config, err := s.auxiliaryModelKind(ctx, modelID, "embedding")
		if err != nil || config == nil {
			return nil, target, err
		}
		vectors, err := agent.Embed(ctx, *config, texts)
		if err != nil {
			return nil, target, err
		}
		return s.checkedEmbeddingVectors(ctx, target, vectors, len(texts))
	}
	bridge, err := s.bridgeSource()
	if err != nil {
		return nil, target, err
	}
	payload, _ := json.Marshal(map[string]any{"model": "BAAI/bge-small-zh-v1.5", "input": texts})
	status, _, body, err := bridge.Bridge(contextWithoutScope(ctx), "__admin__", http.MethodPost, "/embeddings", payload)
	if err != nil || status >= 400 {
		return nil, target, bridgeError(status, body, err)
	}
	var result struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, target, err
	}
	if len(result.Data) != len(texts) {
		return nil, target, errors.New("local embedding returned incomplete vectors")
	}
	vectors := make([][]float32, len(texts))
	for _, row := range result.Data {
		if row.Index < 0 || row.Index >= len(texts) || len(row.Embedding) == 0 || vectors[row.Index] != nil {
			return nil, target, errors.New("local embedding returned invalid vectors")
		}
		vectors[row.Index] = row.Embedding
	}
	if len(vectors) > 0 && len(vectors[0]) != localEmbeddingDimensions {
		return nil, target, storage.ErrEmbeddingDimensions
	}
	return s.checkedEmbeddingVectors(ctx, target, vectors, len(texts))
}

func validateEmbeddingBatch(vectors [][]float32, count int) (int, error) {
	if len(vectors) != count || count < 1 {
		return 0, errors.New("embedding batch is incomplete")
	}
	dimensions := len(vectors[0])
	for _, vector := range vectors {
		if len(vector) != dimensions {
			return 0, storage.ErrEmbeddingDimensions
		}
		if err := storage.ValidateMemoryVector(vector); err != nil {
			return 0, err
		}
	}
	return dimensions, nil
}

func (s *Server) checkedEmbeddingVectors(ctx context.Context, target storage.MemoryEmbeddingTarget, vectors [][]float32, count int) ([][]float32, storage.MemoryEmbeddingTarget, error) {
	dimensions, err := validateEmbeddingBatch(vectors, count)
	if err == nil {
		current, currentErr := s.store.MemoryEmbeddingTarget(ctx)
		if currentErr != nil {
			err = currentErr
		} else if current != target {
			err = storage.ErrMemoryChanged
		} else {
			err = s.store.CheckEmbeddingDimensions(ctx, target.DimensionIdentity(), dimensions)
		}
	}
	if err != nil {
		return nil, target, err
	}
	return vectors, target, nil
}
