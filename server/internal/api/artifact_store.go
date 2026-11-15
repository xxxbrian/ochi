package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"ochi/server/internal/filelimits"
	"ochi/server/internal/storage"
)

var errFileTooLarge = errors.New("file exceeds the configured transfer limit")

func artifactsRoot() string {
	if root := os.Getenv("ARTIFACTS_ROOT"); root != "" {
		return root
	}
	return "./work/artifacts"
}

func storeArtifactBytes(userID, path string, data []byte) (string, error) {
	key, _, err := storeArtifactStream(userID, path, bytes.NewReader(data))
	return key, err
}

func storeArtifactStream(userID, path string, source io.Reader) (string, int64, error) {
	clean := filepath.Clean(path)
	if !strings.HasPrefix(clean, "/data/") {
		return "", 0, errors.New("invalid artifact path")
	}
	key := artifactUserKey(userID) + "/" + strings.TrimPrefix(clean, "/")
	destination := filepath.Join(artifactsRoot(), key)
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return "", 0, err
	}
	temp, err := os.CreateTemp(filepath.Dir(destination), ".artifact-")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(temp.Name())
	limit := filelimits.MaxFileBytes()
	size, err := io.Copy(temp, io.LimitReader(source, limit+1))
	if err != nil {
		temp.Close()
		return "", 0, err
	}
	if size > limit {
		temp.Close()
		return "", 0, errFileTooLarge
	}
	if err = temp.Close(); err != nil {
		return "", 0, err
	}
	// Link creates an immutable destination without replacing another writer.
	if err = os.Link(temp.Name(), destination); errors.Is(err, os.ErrExist) {
		existing, statErr := os.Stat(destination)
		if statErr != nil {
			return "", 0, statErr
		}
		return key, existing.Size(), nil
	}
	return key, size, err
}

func artifactUserKey(userID string) string {
	hash := sha256.Sum256([]byte(userID))
	return hex.EncodeToString(hash[:12])
}

func openArtifact(item storage.Artifact) (*os.File, error) {
	if item.StorageKey == "" {
		return nil, errors.New("artifact storage key is missing")
	}
	clean := filepath.Clean(item.StorageKey)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return nil, errors.New("invalid artifact storage key")
	}
	file, err := os.Open(filepath.Join(artifactsRoot(), clean))
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		if err == nil {
			err = errors.New("artifact is not a regular file")
		}
		return nil, err
	}
	return file, nil
}

func artifactBytesLimited(item storage.Artifact, limit int64) ([]byte, error) {
	file, err := openArtifact(item)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > limit {
		return nil, errFileTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errFileTooLarge
	}
	return data, err
}
