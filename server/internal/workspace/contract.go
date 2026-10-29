package workspace

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"slices"

	"ochi/server/internal/i18n"
)

// ContractJSON is copied unchanged into the workspace image. Keep its revision
// tied to semantic bridge requirements, not every implementation change.
//
//go:embed contract.json
var ContractJSON []byte

var ErrContractMismatch = i18n.New("workspace_contract_changed")

func ContractSHA256() string {
	digest := sha256.Sum256(ContractJSON)
	return hex.EncodeToString(digest[:])
}

// CheckBridgeContract rejects a running but incompatible image before tools
// are advertised or dispatched. This is the current contract, not a migration.
func CheckBridgeContract(data []byte, mode string) error {
	var expected struct {
		Protocol     int      `json:"protocol"`
		Revision     int      `json:"revision"`
		Capabilities []string `json:"capabilities"`
		Modes        []string `json:"modes"`
	}
	var actual struct {
		Protocol       int      `json:"protocol"`
		Revision       int      `json:"revision"`
		ContractSHA256 string   `json:"contract_sha256"`
		Capabilities   []string `json:"capabilities"`
		Mode           string   `json:"mode"`
	}
	if json.Unmarshal(ContractJSON, &expected) != nil || json.Unmarshal(data, &actual) != nil {
		return ErrContractMismatch
	}
	if actual.ContractSHA256 != ContractSHA256() || actual.Protocol != expected.Protocol ||
		actual.Revision != expected.Revision || actual.Mode != mode || !slices.Contains(expected.Modes, mode) {
		return ErrContractMismatch
	}
	for _, capability := range expected.Capabilities {
		if !slices.Contains(actual.Capabilities, capability) {
			return ErrContractMismatch
		}
	}
	return nil
}
