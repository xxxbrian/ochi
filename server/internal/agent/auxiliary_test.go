package agent

import (
	"encoding/json"
	"testing"
)

func TestAuxiliaryUsesSupportedLowBeforeCatalogNone(t *testing.T) {
	config := AuxiliaryConfig(Config{Effort: "high", EffortValue: json.RawMessage(`"high"`), EffortMapping: map[string]json.RawMessage{"none": json.RawMessage(`"none"`), "low": json.RawMessage(`"low"`), "high": json.RawMessage(`"high"`)}, MemoryContext: "private context", Tools: &testTools{}})
	if config.Effort != "low" || string(config.EffortValue) != `"low"` || config.MemoryContext != "" || config.Tools != nil {
		t.Fatalf("auxiliary inherited expensive/unsupported configuration: %+v", config)
	}
}
