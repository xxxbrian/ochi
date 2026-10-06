package agent

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// The bridge uses these same fixtures: accepting an assertion on only one side
// would turn a correctable model error into a dispatched side effect.
func TestToolSchemaSharedContract(t *testing.T) {
	data, err := os.ReadFile("testdata/tool_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Schema, Arguments, Code string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			err := ValidateToolArguments(ToolDefinition{Name: "fixture", Parameters: json.RawMessage(c.Schema)}, json.RawMessage(c.Arguments))
			if c.Code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var classified *ToolArgumentError
			if !errors.As(err, &classified) || classified.Code != c.Code || classified.Tool != "fixture" || classified.Path == "" {
				t.Fatalf("want %s with tool/path, got %#v", c.Code, err)
			}
		})
	}
}
