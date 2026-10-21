package storage

import (
	"context"
	"errors"
	"testing"
)

func TestModelOrderRequiresCompletePublishedSetAndValidDefault(t *testing.T) {
	current := []string{"a", "b", "c"}
	for _, test := range []struct {
		name    string
		ordered []string
		initial string
		want    error
	}{
		{"reorder", []string{"c", "a", "b"}, "a", nil},
		{"missing", []string{"a", "b"}, "a", ErrModelOrderChanged},
		{"duplicate", []string{"a", "a", "c"}, "a", ErrModelOrderChanged},
		{"unknown", []string{"a", "b", "other"}, "a", ErrModelOrderChanged},
		{"invalid default", current, "other", ErrModelSelection},
		{"empty default", current, "", ErrModelSelection},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateModelOrder(current, test.ordered, test.initial); !errors.Is(err, test.want) {
				t.Fatalf("got %v, want %v", err, test.want)
			}
		})
	}
	if err := validateModelOrder(nil, nil, ""); err != nil {
		t.Fatal("an empty catalog must remain configurable", err)
	}
}

func modelSelectionStore(t *testing.T) (*Store, Model, Model) {
	t.Helper()
	s := processTestStore(t)
	ctx := context.Background()
	if err := s.BootstrapProvider(ctx, "https://provider.example/v1", "fixture-not-sent", "First"); err != nil {
		t.Fatal(err)
	}
	models, err := s.Models(ctx, true)
	if err != nil || len(models) != 1 {
		t.Fatal("missing model fixture", err)
	}
	provider, err := s.SaveProvider(ctx, Provider{Name: "Another provider", BaseURL: "https://another.example/v1", Protocol: "openai", Enabled: true, TimeoutSeconds: 480})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.SaveModel(ctx, Model{ProviderID: provider.ID, Name: "Second", Model: "second", Enabled: true, Available: true})
	if err != nil {
		t.Fatal(err)
	}
	return s, models[0], second
}

func TestModelOrderIsGlobalAtomicAndIndependentOfDefault(t *testing.T) {
	s, first, second := modelSelectionStore(t)
	ctx := context.Background()
	if err := s.SaveModelOrder(ctx, []string{second.ID, first.ID}, first.ID); err != nil {
		t.Fatal(err)
	}
	assertOrder := func() {
		t.Helper()
		models, err := s.Models(ctx, true)
		if err != nil || len(models) != 2 || models[0].ID != second.ID || models[1].ID != first.ID || !models[1].IsDefault || models[0].IsDefault {
			t.Fatalf("order/default changed unexpectedly: %+v, %v", models, err)
		}
	}
	assertOrder()
	first.Name = "Renamed"
	if _, err := s.SaveModel(ctx, first); err != nil {
		t.Fatal(err)
	}
	assertOrder()
	if err := s.SaveModelOrder(ctx, []string{first.ID}, first.ID); !errors.Is(err, ErrModelOrderChanged) {
		t.Fatal("a stale admin dialog overwrote the catalog", err)
	}
	assertOrder()
	third, err := s.SaveModel(ctx, Model{ProviderID: first.ProviderID, Name: "New", Model: "new", Enabled: true, Available: true})
	if err != nil {
		t.Fatal(err)
	}
	models, err := s.Models(ctx, true)
	if err != nil || len(models) != 3 || models[2].ID != third.ID {
		t.Fatal("new models must append after explicit order", err)
	}
}

func TestPreferredModelIsDurableAccountScopedAndDoesNotResetOtherPreferences(t *testing.T) {
	s, first, second := modelSelectionStore(t)
	ctx := context.Background()
	for _, id := range []string{"model-user-a", "model-user-b"} {
		if err := s.BootstrapUser(ctx, User{ID: id, Username: id, DisplayName: id, Role: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	off, on := false, true
	before, err := s.PatchPreferences(ctx, "model-user-a", PreferencesPatch{MemoryEnabled: &off, ComputerDefault: &on})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PatchPreferences(ctx, "model-user-a", PreferencesPatch{PreferredModelID: &second.ID}); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Preferences(ctx, "model-user-a")
	if err != nil || saved.PreferredModelID != second.ID || saved.MemoryEnabled || !saved.ComputerDefault || saved.MemoryRevision != before.MemoryRevision {
		t.Fatalf("selection did not survive a fresh read or rewrote independent preferences: %+v %v", saved, err)
	}
	other, err := s.Preferences(ctx, "model-user-b")
	if err != nil || other.PreferredModelID != "" || !other.MemoryEnabled || other.ComputerDefault {
		t.Fatal("model preference leaked across accounts", err)
	}
	second.Enabled = false
	if _, err = s.SaveModel(ctx, second); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{second.ID, "not-a-uuid", "11111111-1111-4111-8111-111111111111"} {
		if _, err = s.PatchPreferences(ctx, "model-user-a", PreferencesPatch{PreferredModelID: &id}); !errors.Is(err, ErrModelSelection) {
			t.Fatal("accepted an unpublished model", err)
		}
	}
	if _, err = s.PatchPreferences(ctx, "model-user-a", PreferencesPatch{PreferredModelID: &first.ID}); err != nil {
		t.Fatal(err)
	}
	empty := ""
	if _, err = s.PatchPreferences(ctx, "model-user-a", PreferencesPatch{PreferredModelID: &empty}); err != nil {
		t.Fatal("resetting preference must restore administrator default", err)
	}
}
