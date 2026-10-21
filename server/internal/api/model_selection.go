package api

import (
	"errors"
	"net/http"

	"ochi/server/internal/storage"
)

func (s *Server) adminModelOrder(w http.ResponseWriter, r *http.Request) {
	var value struct {
		ModelIDs       []string `json:"model_ids"`
		DefaultModelID string   `json:"default_model_id"`
	}
	if !decodeRequest(w, r, &value) {
		return
	}
	err := s.store.SaveModelOrder(r.Context(), value.ModelIDs, value.DefaultModelID)
	if errors.Is(err, storage.ErrModelSelection) {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if errors.Is(err, storage.ErrModelOrderChanged) {
		writeError(w, http.StatusConflict, err)
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
