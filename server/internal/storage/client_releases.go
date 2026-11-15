package storage

import (
	"context"
	"encoding/json"
	"time"
)

type AndroidClientRelease struct {
	VersionName  string    `json:"version_name"`
	VersionCode  int64     `json:"version_code"`
	SizeBytes    int64     `json:"size_bytes"`
	SHA256       string    `json:"sha256"`
	PublishedAt  time.Time `json:"published_at"`
	ReleaseNotes string    `json:"release_notes"`
}

type IOSClientRelease struct {
	URL string `json:"url"`
}

type ClientReleases struct {
	Android *AndroidClientRelease `json:"android"`
	IOS     *IOSClientRelease     `json:"ios"`
}

func (s *Store) ClientReleases(ctx context.Context) (ClientReleases, error) {
	var payload []byte
	err := s.db.QueryRow(ctx, `SELECT client_releases FROM app_settings WHERE id=true`).Scan(&payload)
	var releases ClientReleases
	if err == nil {
		err = json.Unmarshal(payload, &releases)
	}
	return releases, err
}

func (s *Store) SaveAndroidClientRelease(ctx context.Context, release *AndroidClientRelease) (ClientReleases, error) {
	return s.saveClientRelease(ctx, "android", release)
}

func (s *Store) SaveIOSClientRelease(ctx context.Context, release *IOSClientRelease) (ClientReleases, error) {
	return s.saveClientRelease(ctx, "ios", release)
}

func (s *Store) saveClientRelease(ctx context.Context, platform string, value any) (ClientReleases, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return ClientReleases{}, err
	}
	var updated []byte
	err = s.db.QueryRow(ctx, `UPDATE app_settings SET client_releases=jsonb_set(client_releases,ARRAY[$1]::text[],$2::jsonb)
 WHERE id=true RETURNING client_releases`, platform, payload).Scan(&updated)
	var releases ClientReleases
	if err == nil {
		err = json.Unmarshal(updated, &releases)
	}
	return releases, err
}
