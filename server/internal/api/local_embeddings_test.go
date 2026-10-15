package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

type localEmbeddingFixture struct {
	t          *testing.T
	dimensions int
}

func (f localEmbeddingFixture) Definitions(context.Context, string) ([]agent.ToolDefinition, error) {
	return nil, nil
}

func (f localEmbeddingFixture) Call(context.Context, string, string, json.RawMessage) (agent.ToolResult, error) {
	return agent.ToolResult{}, errors.New("unexpected tool call")
}

func (f localEmbeddingFixture) Bridge(_ context.Context, userID, method, route string, payload []byte) (int, http.Header, []byte, error) {
	f.t.Helper()
	var input struct {
		Model string   `json:"model"`
		Input []string `json:"input"`
	}
	if userID != "__admin__" || method != http.MethodPost || route != "/embeddings" || json.Unmarshal(payload, &input) != nil || input.Model != "BAAI/bge-small-zh-v1.5" {
		f.t.Fatal("local model request used the wrong bridge or model")
	}
	rows := make([]map[string]any, 0, len(input.Input))
	// Reverse response order to also exercise reconstruction by index.
	for i := len(input.Input) - 1; i >= 0; i-- {
		vector := make([]float32, f.dimensions)
		vector[0] = float32(i + 1)
		rows = append(rows, map[string]any{"index": i, "embedding": vector})
	}
	body, err := json.Marshal(map[string]any{"data": rows})
	return http.StatusOK, nil, body, err
}

func TestLocalChineseEmbeddingDimensionsAndIndexing(t *testing.T) {
	for _, dimensions := range []int{512, 384} {
		name := "accept_chinese_512"
		if dimensions == 384 {
			name = "reject_english_384"
		}
		t.Run(name, func(t *testing.T) {
			f := newCoreHTTPFixture(t)
			ctx := context.Background()
			f.server.SetTools(localEmbeddingFixture{t: t, dimensions: dimensions})
			vectors, target, err := f.server.embeddingVectorsTarget(ctx, "", []string{"first", "second"})
			if target.ModelID != localEmbeddingModelID {
				t.Fatal("local embedding identity changed")
			}
			if dimensions == 384 {
				if !errors.Is(err, storage.ErrEmbeddingDimensions) || vectors != nil {
					t.Fatal("wrong local model dimensions were accepted")
				}
				return
			}
			if err != nil || len(vectors) != 2 || len(vectors[0]) != 512 || vectors[0][0] != 1 || vectors[1][0] != 2 {
				t.Fatalf("512-dimensional Chinese vectors rejected or reordered: %v", err)
			}
			if _, err := f.server.store.SaveMemoryRecord(ctx, f.owner, storage.Memory{Content: "Persistent local memory", Source: "user"}); err != nil {
				t.Fatal(err)
			}
			job, err := f.server.store.ClaimMemoryIndexJob(ctx)
			if err != nil || job == nil {
				t.Fatal("could not claim local indexing work")
			}
			if err := f.server.indexMemoryBatch(ctx, *job); err != nil {
				t.Fatal(err)
			}
			status, err := f.server.store.MemoryIndexJobStatus(ctx, f.owner)
			if err != nil || status.Status != "completed" || status.LastError != "" {
				t.Fatal("local indexing failed to complete")
			}
			memories, err := f.server.store.ScopedMemories(ctx, f.owner, "", "", false)
			if err != nil || len(memories) != 1 || !memories[0].HasEmbedding || memories[0].EmbeddingModelID != target.Identity || memories[0].Content != "Persistent local memory" {
				t.Fatal("local indexing lost content or stored the wrong vector identity")
			}
		})
	}
}
