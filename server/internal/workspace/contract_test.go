package workspace

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func contractHealth(t *testing.T, mode string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(ContractJSON, &value); err != nil {
		t.Fatal(err)
	}
	value["contract_sha256"] = ContractSHA256()
	value["mode"] = mode
	return value
}

func TestBridgeContractRejectsIncompatibleOrWrongModeImage(t *testing.T) {
	for _, mode := range []string{"control", "workspace", "compute"} {
		data, _ := json.Marshal(contractHealth(t, mode))
		if err := CheckBridgeContract(data, mode); err != nil {
			t.Fatalf("matching %s bridge rejected: %v", mode, err)
		}
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"missing image identity", func(v map[string]any) { delete(v, "contract_sha256") }},
		{"different image contract", func(v map[string]any) { v["contract_sha256"] = strings.Repeat("0", 64) }},
		{"different protocol", func(v map[string]any) { v["protocol"] = 999 }},
		{"different revision", func(v map[string]any) { v["revision"] = 999 }},
		{"missing capabilities", func(v map[string]any) { v["capabilities"] = []string{} }},
		{"wrong execution mode", func(v map[string]any) { v["mode"] = "control" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := contractHealth(t, "workspace")
			tc.change(value)
			data, _ := json.Marshal(value)
			if !errors.Is(CheckBridgeContract(data, "workspace"), ErrContractMismatch) {
				t.Fatal("incompatible image was admitted")
			}
		})
	}
	for _, value := range []string{"{}", "not json", `{"status":"ok"}`} {
		if !errors.Is(CheckBridgeContract([]byte(value), "workspace"), ErrContractMismatch) {
			t.Fatal("unidentified bridge was admitted")
		}
	}
}
