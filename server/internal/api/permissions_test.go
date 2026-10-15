package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

func TestOrdinaryToolsAndImmutableArtifactStore(t *testing.T) {
	for _, name := range []string{"exec", "files_read", "files_write", "web_fetch", "publish_file", "read_artifact"} {
		if !computationTool(name) {
			t.Fatalf("ordinary tool disabled: %s", name)
		}
	}
	for _, name := range []string{"browser_goto", "computer_screenshot", "mcp_filesystem_read", "skills_read"} {
		if computationTool(name) {
			t.Fatalf("privileged tool escaped gate: %s", name)
		}
	}
	t.Setenv("ARTIFACTS_ROOT", t.TempDir())
	key, err := storeArtifactBytes("user", "/data/published/run/hash/report.md", []byte("中文 UTF-8"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = storeArtifactBytes("user", "/data/published/run/hash/report.md", []byte("overwrite")); err != nil {
		t.Fatal(err)
	}
	data, err := artifactBytes(storage.Artifact{StorageKey: key})
	if err != nil || string(data) != "中文 UTF-8" {
		t.Fatalf("immutable artifact changed: %q %v", data, err)
	}
	if _, err := os.Stat(artifactsRoot()); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", "../outside", "/absolute", "user/../../outside"} {
		if _, err := artifactBytes(storage.Artifact{StorageKey: key}); err == nil {
			t.Fatalf("accepted invalid artifact key: %q", key)
		}
	}
}

func TestRevokeInterruptsOnlyMatchingComputerCalls(t *testing.T) {
	s := &Server{}
	a, cancelA := context.WithCancelCause(context.Background())
	b, cancelB := context.WithCancelCause(context.Background())
	defer cancelA(nil)
	defer cancelB(nil)
	s.computerCalls.Store("run-a", &computerCall{sessionID: "a", cancel: cancelA})
	s.computerCalls.Store("run-b", &computerCall{sessionID: "b", cancel: cancelB})
	s.interruptComputerCalls("a")
	if !errors.Is(context.Cause(a), errComputerModeChanged) || b.Err() != nil {
		t.Fatal("revoke did not isolate the in-flight operation to its session")
	}
}

func TestRevokedComputerResultPreservesOutputAndReason(t *testing.T) {
	result, err := revokedComputerResult(agent.ToolResult{Output: `{"exit_code":-15,"stdout":"started\n","stderr":""}`, Screenshot: "image"})
	var output struct {
		ExitCode int    `json:"exit_code"`
		Stdout   string `json:"stdout"`
		Error    string `json:"error"`
	}
	if json.Unmarshal([]byte(result.Output), &output) != nil || err == nil || output.Error != err.Error() || !strings.Contains(output.Error, "permission was revoked") {
		t.Fatalf("canonical result lost revocation reason: %s, %v", result.Output, err)
	}
	if output.ExitCode != -15 || output.Stdout != "started\n" || result.Screenshot != "image" {
		t.Fatal("revocation lost captured operation output")
	}
}

func TestArtifactRestoreSelectsLatestOwnVersion(t *testing.T) {
	scope := agent.RunScope{SessionID: "own", CWD: "/data/work/session"}
	items := []storage.Artifact{
		{SessionID: "own", RunID: "two", SourcePath: "/data/work/session/answer.json", Version: 2},
		{SessionID: "other", RunID: "other", SourcePath: "/data/work/session/answer.json", Version: 3},
		{SessionID: "own", RunID: "one", SourcePath: "/data/work/session/answer.json", Version: 1},
	}
	versions := sameSessionArtifactVersions(items, scope)["/data/work/session/answer.json"]
	if len(versions) != 2 || versions[len(versions)-1].RunID != "two" {
		t.Fatal("restoration picked stale or other-session source")
	}
	if publishedDigest("/data/published/run/0123456789abcdef0123/answer.json") != "0123456789abcdef0123" || publishedDigest("/data/work/answer.json") != "" {
		t.Fatal("artifact baseline digest invalid")
	}
	result := withArtifactUpdates(agent.ToolResult{Output: `{"content":"local work"}`}, []artifactUpdate{{SourcePath: "answer.json", ArtifactPath: "/data/published/new/answer.json", LocalSourcePreserved: true}})
	var output struct {
		Content string           `json:"content"`
		Updates []artifactUpdate `json:"artifact_updates"`
	}
	if err := json.Unmarshal([]byte(result.Output), &output); err != nil || output.Content != "local work" || len(output.Updates) != 1 || !output.Updates[0].LocalSourcePreserved {
		t.Fatal("conflict source was not communicated with tool result")
	}
}
