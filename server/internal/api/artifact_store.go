package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"ochi/server/internal/storage"
)

func artifactsRoot() string {
	if root := os.Getenv("ARTIFACTS_ROOT"); root != "" {
		return root
	}
	return "./work/artifacts"
}

func storeArtifactBytes(userID, path string, data []byte) (string, error) {
	hash := sha256.Sum256([]byte(userID))
	key := hex.EncodeToString(hash[:12]) + "/" + strings.TrimPrefix(filepath.Clean(path), "/")
	if !strings.HasPrefix(path, "/data/") {
		return "", errors.New("invalid artifact path")
	}
	destination := filepath.Join(artifactsRoot(), key)
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return "", err
	}
	if _, err := os.Stat(destination); err == nil {
		return key, nil
	}
	temp, err := os.CreateTemp(filepath.Dir(destination), ".artifact-")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return "", err
	}
	if err = temp.Close(); err != nil {
		return "", err
	}
	return key, os.Rename(temp.Name(), destination)
}

func artifactBytes(item storage.Artifact) ([]byte, error) {
	if item.StorageKey == "" {
		return nil, errors.New("artifact storage key is missing")
	}
	clean := filepath.Clean(item.StorageKey)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return nil, errors.New("invalid artifact storage key")
	}
	return os.ReadFile(filepath.Join(artifactsRoot(), clean))
}
