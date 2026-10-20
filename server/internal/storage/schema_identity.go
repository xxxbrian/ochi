package storage

import (
	"crypto/sha256"
	"encoding/hex"
)

// SchemaSHA256 identifies the exact schema shipped with this executable.
func SchemaSHA256() string {
	sum := sha256.Sum256([]byte(schemaSQL))
	return hex.EncodeToString(sum[:])
}
