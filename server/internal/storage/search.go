package storage

import (
	"context"

	"ochi/server/internal/websearch"
)

func (s *Store) SearchSettings(ctx context.Context) (websearch.Config, error) {
	var c websearch.Config
	err := s.db.QueryRow(ctx, `SELECT enabled,provider,base_url,api_key,max_results,timeout_seconds FROM search_settings WHERE id=true`).Scan(&c.Enabled, &c.Provider, &c.BaseURL, &c.APIKey, &c.MaxResults, &c.TimeoutSeconds)
	return c, err
}

func (s *Store) SaveSearchSettings(ctx context.Context, c websearch.Config) error {
	_, err := s.db.Exec(ctx, `UPDATE search_settings SET enabled=$1,provider=$2,base_url=$3,api_key=$4,max_results=$5,timeout_seconds=$6 WHERE id=true`, c.Enabled, c.Provider, c.BaseURL, c.APIKey, c.MaxResults, c.TimeoutSeconds)
	return err
}
