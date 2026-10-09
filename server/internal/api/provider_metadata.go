package api

import (
	"context"
	"net/http"
	"time"

	"ochi/server/internal/storage"
)

func resolvedCatalogReferences(ctx context.Context, provider storage.Provider, ids []string) map[string]storage.CatalogModel {
	refs := map[string]storage.CatalogModel{}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	catalog, err := storage.FetchModelCatalog(ctx)
	if err != nil {
		return refs
	}
	for _, id := range ids {
		if reference, match, ok := storage.ResolveCatalogModel(catalog, provider, id); ok {
			reference.Match = match
			refs[id] = reference
		}
	}
	return refs
}

func (s *Server) resolveModelMetadata(w http.ResponseWriter, r *http.Request) {
	provider := storage.Provider{Protocol: "openai"}
	if id := r.URL.Query().Get("provider_id"); id != "" {
		var err error
		provider, err = s.store.Provider(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	catalog, err := storage.FetchModelCatalog(r.Context())
	if err != nil {
		fallback := storage.InferImageMetadata(storage.Model{Model: r.URL.Query().Get("model"), Name: r.URL.Query().Get("model"), Kind: "chat", MetadataSource: "unknown"})
		if fallback.SupportsImageGeneration {
			writeJSON(w, http.StatusOK, map[string]any{"matched": true, "model": fallback, "metadata_match": "family"})
			return
		}
		writeError(w, http.StatusBadGateway, err)
		return
	}
	id := r.URL.Query().Get("model")
	reference, match, ok := storage.ResolveCatalogModel(catalog, provider, id)
	if !ok {
		fallback := storage.InferImageMetadata(storage.Model{Model: id, Name: id, Kind: "chat", MetadataSource: "unknown"})
		if fallback.SupportsImageGeneration {
			writeJSON(w, http.StatusOK, map[string]any{"matched": true, "model": fallback, "metadata_match": "family"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"matched": false, "metadata_match": "unmatched"})
		return
	}
	model := storage.EnrichCatalogModel(storage.Model{Model: id, Name: id, Kind: "chat", MetadataOverrides: map[string]bool{}}, provider, reference, match)
	writeJSON(w, http.StatusOK, map[string]any{"matched": true, "model": model, "reference": reference, "metadata_match": match})
}

func (s *Server) refreshProviderMetadata(w http.ResponseWriter, r *http.Request) {
	provider, err := s.store.Provider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var request struct {
		ResetOverrides bool `json:"reset_overrides"`
	}
	if r.ContentLength != 0 && !decodeRequest(w, r, &request) {
		return
	}
	catalog, err := storage.FetchModelCatalog(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	all, err := s.store.Models(r.Context(), false)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	models := []storage.Model{}
	matched, unmatched := 0, 0
	changed := false
	defer func() {
		if changed {
			s.enqueueMemoryIndexesAfterConfigChange(r.Context())
		}
	}()
	for _, model := range all {
		if model.ProviderID != provider.ID {
			continue
		}
		if reference, match, ok := storage.ResolveCatalogModel(catalog, provider, model.Model); ok {
			name := model.Name
			if request.ResetOverrides {
				model.MetadataOverrides = map[string]bool{}
			}
			model = storage.EnrichCatalogModel(model, provider, reference, match)
			model.Name = name
			model, err = s.store.SaveModel(r.Context(), model)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			matched++
		} else {
			if request.ResetOverrides {
				model.MetadataOverrides = map[string]bool{}
			}
			model, err = s.store.SaveModel(r.Context(), storage.InferImageMetadata(model))
			if err != nil {
				writeStoreError(w, err)
				return
			}
			unmatched++
		}
		changed = true
		models = append(models, model)
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models, "matched": matched, "unmatched": unmatched})
}
