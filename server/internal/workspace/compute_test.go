package workspace

import (
	"encoding/json"
	"testing"

	"ochi/server/internal/agent"
)

func TestComputeHasOnlyOrdinaryTools(t *testing.T) {
	var all []agent.ToolDefinition
	if err := json.Unmarshal(intrinsicTools, &all); err != nil {
		t.Fatal(err)
	}
	items := computeDefinitions(all)
	if len(items) != 5 {
		t.Fatalf("ordinary catalogue contains %d tools", len(items))
	}
	for _, d := range items {
		if d.Name != "exec" && d.Name != "files_list" && d.Name != "files_read" && d.Name != "files_write" && d.Name != "web_fetch" {
			t.Fatalf("privileged tool exposed: %s", d.Name)
		}
	}
	if computeContainer("user", "first") == computeContainer("user", "second") || computeContainer("user", "first") == computeContainer("other", "first") {
		t.Fatal("scratch container identity crosses conversation/user boundary")
	}
}
