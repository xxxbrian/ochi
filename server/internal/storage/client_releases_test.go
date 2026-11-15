package storage

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestClientReleasesIndependentPlatformUpdates(t *testing.T) {
	s := processTestStore(t)
	ctx := context.Background()
	initial, err := s.ClientReleases(ctx)
	if err != nil || initial.Android != nil || initial.IOS != nil {
		t.Fatalf("initial catalog: %+v, %v", initial, err)
	}
	android := &AndroidClientRelease{
		VersionName: "0.1.0", VersionCode: 20, SizeBytes: 40 << 20,
		SHA256: "fixture-sha", PublishedAt: time.Now().UTC().Truncate(time.Microsecond), ReleaseNotes: "A new build.",
	}
	ios := &IOSClientRelease{URL: "https://example.invalid/install"}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := s.SaveAndroidClientRelease(ctx, android); err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := s.SaveIOSClientRelease(ctx, ios); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	current, err := s.ClientReleases(ctx)
	if err != nil || current.Android == nil || *current.Android != *android || current.IOS == nil || *current.IOS != *ios {
		t.Fatalf("independent writes lost another platform: %+v, %v", current, err)
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings.SystemPrompt = "Unrelated settings stay independent."
	if err := s.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveAndroidClientRelease(ctx, nil); err != nil {
		t.Fatal(err)
	}
	current, err = s.ClientReleases(ctx)
	if err != nil || current.Android != nil || current.IOS == nil || current.IOS.URL != ios.URL {
		t.Fatal("Android unpublication changed iOS")
	}
	if _, err := s.SaveIOSClientRelease(ctx, nil); err != nil {
		t.Fatal(err)
	}
	current, err = s.ClientReleases(ctx)
	if err != nil || current.Android != nil || current.IOS != nil {
		t.Fatal("clearing iOS did not clear only its own value")
	}
	settings, err = s.Settings(ctx)
	if err != nil || settings.SystemPrompt != "Unrelated settings stay independent." {
		t.Fatal("catalog writes replaced ordinary settings")
	}
}
