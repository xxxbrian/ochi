package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"ochi/server/internal/storage"
)

func TestModelOrderAndPreferenceHTTPContracts(t *testing.T) {
	f := newCoreHTTPFixture(t)
	ctx := context.Background()
	models, err := f.server.store.Models(ctx, true)
	if err != nil || len(models) != 1 {
		t.Fatal("missing model fixture", err)
	}
	first := models[0]
	second, err := f.server.store.SaveModel(ctx, storage.Model{ProviderID: first.ProviderID, Name: "Another", Model: "another", Enabled: true, Available: true})
	if err != nil {
		t.Fatal(err)
	}
	order := fmt.Sprintf(`{"model_ids":[%q,%q],"default_model_id":%q}`, second.ID, first.ID, first.ID)
	f.request(t, "", http.MethodPut, "/api/admin/models/order", order, http.StatusUnauthorized)
	f.request(t, f.token, http.MethodPut, "/api/admin/models/order", order, http.StatusForbidden)
	f.request(t, f.foreign, http.MethodPut, "/api/admin/models/order", order, http.StatusNoContent)
	f.request(t, f.foreign, http.MethodPut, "/api/admin/models/order", fmt.Sprintf(`{"model_ids":[%q],"default_model_id":%q}`, second.ID, second.ID), http.StatusConflict)
	var published []storage.Model
	if err = json.Unmarshal(f.request(t, f.token, http.MethodGet, "/api/models", "", http.StatusOK), &published); err != nil || len(published) != 2 || published[0].ID != second.ID || !published[1].IsDefault {
		t.Fatal("published catalog lost order/default", err)
	}
	model, _, err := f.server.selectedModel(ctx, "", "")
	if err != nil || model.ID != first.ID {
		t.Fatal("backend initial default must not follow display order", err)
	}
	patch := fmt.Sprintf(`{"preferred_model_id":%q}`, second.ID)
	f.request(t, "", http.MethodPatch, "/api/preferences", patch, http.StatusUnauthorized)
	f.request(t, f.token, http.MethodPatch, "/api/preferences", patch, http.StatusOK)
	var preferences storage.Preferences
	if err = json.Unmarshal(f.request(t, f.token, http.MethodGet, "/api/preferences", "", http.StatusOK), &preferences); err != nil || preferences.PreferredModelID != second.ID {
		t.Fatal("a new request did not retain selection", err)
	}
	if err = json.Unmarshal(f.request(t, f.foreign, http.MethodGet, "/api/preferences", "", http.StatusOK), &preferences); err != nil || preferences.PreferredModelID != "" {
		t.Fatal("model preference crossed account boundary", err)
	}
	f.request(t, f.token, http.MethodPatch, "/api/preferences", `{"preferred_model_id":"missing"}`, http.StatusBadRequest)
}
